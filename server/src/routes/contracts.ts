import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { eq, and, isNull, desc, inArray, like } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { generateContract, longDatePtBR, parseIsoDate, docMime, formatOfFileName } from '../lib/contract.js';
import { loadTemplateById } from './templates.js';
import { getMinInstallmentValue } from './settings.js';
import { officeToPdf } from '../lib/pdf.js';

const brDate = (s?: string | null) => {
  const d = parseIsoDate(s);
  return d ? d.toLocaleDateString('pt-BR') : '';
};


const round2 = (n: number) => Math.round(n * 100) / 100;

// Max installments so no installment is below the configured minimum value
// (Configurações → Parcelamento, R$150 by default); at least 1.
async function maxInstallmentsFor(total: number): Promise<number> {
  return Math.max(1, Math.floor(total / (await getMinInstallmentValue())));
}

// Split a total into `count` equal installments (cents-exact; remainder on last).
function splitAmount(total: number, count: number): number[] {
  const n = Math.max(1, count);
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  const arr = Array.from({ length: n }, () => base);
  arr[n - 1] += cents - base * n;
  return arr.map((c) => c / 100);
}

// Create one payment per installment (linked to the contract and/or invoice).
async function createInstallmentPayments(opts: {
  contractId: number | null;
  invoiceId?: number | null;
  customerId?: number | null;
  label: string;
  total: number;
  count: number;
  dueDates?: (string | null)[];
}) {
  const count = Math.max(1, opts.count);
  const amounts = splitAmount(opts.total, count);
  const rows = amounts.map((amt, i) => ({
    contractId: opts.contractId,
    invoiceId: opts.invoiceId ?? null,
    customerId: opts.customerId ?? null,
    // Contract number is its own column, so contract installments are just
    // "Parcela X/Y"; invoice installments keep the invoice reference (no column).
    description: opts.label ? `${opts.label} — Parcela ${i + 1}/${count}` : `Parcela ${i + 1}/${count}`,
    amount: String(amt),
    flow: 'in' as const,
    status: 'upcoming' as const,
    installmentNumber: i + 1,
    installmentCount: count,
    dueDate: opts.dueDates?.[i] ?? null,
  }));
  if (rows.length > 0) await db.insert(schema.payments).values(rows);
}

// Next contract number in the YY/XXX format, sequence resetting each year.
async function nextContractNumber(type: 'contract' | 'invoice'): Promise<string> {
  // Recurring contracts (invoices) use their own ever-increasing sequence: F001, F002, ...
  if (type === 'invoice') {
    const rows = await db
      .select({ number: schema.contracts.number })
      .from(schema.contracts)
      .where(like(schema.contracts.number, 'F%'));
    let max = 0;
    for (const r of rows) {
      const seq = Number(String(r.number).replace(/^F/i, ''));
      if (Number.isFinite(seq) && seq > max) max = seq;
    }
    return `F${String(max + 1).padStart(3, '0')}`;
  }

  // One-time contracts: YY/XXX, reset per year.
  const yy = String(new Date().getFullYear() % 100).padStart(2, '0');
  const prefix = `${yy}/`;
  const rows = await db
    .select({ number: schema.contracts.number })
    .from(schema.contracts)
    .where(like(schema.contracts.number, `${prefix}%`));
  let max = 0;
  for (const r of rows) {
    const seq = Number(String(r.number).split('/')[1]);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

// Sequential invoice reference number, reset per year: seq-YY (e.g. 001-26, 002-26).
async function nextInvoiceRefNumber(): Promise<string> {
  const yy = String(new Date().getFullYear() % 100).padStart(2, '0');
  const suffix = `-${yy}`;
  const rows = await db
    .select({ refNumber: schema.invoices.refNumber })
    .from(schema.invoices)
    .where(like(schema.invoices.refNumber, `%${suffix}`));
  let max = 0;
  for (const r of rows) {
    const seq = Number(String(r.refNumber ?? '').split('-')[0]);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return `${String(max + 1).padStart(3, '0')}${suffix}`;
}

interface AdditionalInput {
  additionalId?: number;
  quantity?: number;
  discountPercent?: number;
}
interface ItemInput {
  serviceVersionId: number;
  quantity?: number;
  discountPercent?: number;
  additionals?: AdditionalInput[];
}
interface AddRow {
  additionalId: number | null;
  name: string;
  unitPrice: string;
  quantity: number;
  discountPercent: number;
  lineTotal: string;
}
interface SnapshotRow {
  serviceVersionId: number;
  serviceName: string;
  basePrice: string;
  quantity: number;
  discountPercent: number;
  lineTotal: string;
  additionals: AddRow[];
}

const withDisc = (amount: number, pct: any) => amount * (1 - (Number(pct) || 0) / 100);

// Snapshot a service version + chosen additionals into a priced row.
// item lineTotal = base*qty*(1-svcDisc) + Σ additional(unit*qty*(1-addDisc)).
async function snapshotOne(it: ItemInput): Promise<SnapshotRow | null> {
  const [version] = await db
    .select()
    .from(schema.serviceVersions)
    .where(eq(schema.serviceVersions.id, it.serviceVersionId));
  if (!version) return null;
  const [service] = await db
    .select()
    .from(schema.services)
    .where(eq(schema.services.id, version.serviceId));

  const qty = Math.max(1, Math.floor(Number(it.quantity) || 1));
  const svcDisc = Number(it.discountPercent) || 0;
  const serviceLine = withDisc(Number(version.basePrice) * qty, svcDisc);

  const additionals: AddRow[] = [];
  for (const a of it.additionals ?? []) {
    if (!a.additionalId || !(Number(a.quantity) > 0)) continue;
    const [row] = await db
      .select()
      .from(schema.serviceAdditionals)
      .where(eq(schema.serviceAdditionals.id, a.additionalId));
    if (!row) continue;
    const aQty = Math.max(1, Math.floor(Number(a.quantity)));
    const aDisc = Number(a.discountPercent) || 0;
    const aTotal = round2(withDisc(Number(row.price) * aQty, aDisc));
    additionals.push({
      additionalId: row.id,
      name: row.name,
      unitPrice: row.price,
      quantity: aQty,
      discountPercent: aDisc,
      lineTotal: String(aTotal),
    });
  }

  const lineTotal = round2(serviceLine + additionals.reduce((s, a) => s + Number(a.lineTotal), 0));
  return {
    serviceVersionId: version.id,
    serviceName: service?.name ?? 'Serviço',
    basePrice: version.basePrice,
    quantity: qty,
    discountPercent: svcDisc,
    lineTotal: String(lineTotal),
    additionals,
  };
}

// Snapshot several items, with grand total.
async function buildItems(items: ItemInput[]): Promise<{ rows: SnapshotRow[]; total: number }> {
  const rows: SnapshotRow[] = [];
  let total = 0;
  for (const it of items ?? []) {
    const row = await snapshotOne(it);
    if (!row) continue;
    rows.push(row);
    total += Number(row.lineTotal);
  }
  return { rows, total };
}

// Insert one snapshotted item (+ its additionals) and return the new item id.
async function persistOneItem(
  contractId: number,
  row: SnapshotRow,
  extra?: { description?: string | null; performedAt?: string | null; invoiceId?: number | null }
): Promise<number> {
  const itemRes: any = await db
    .insert(schema.contractItems)
    .values({
      contractId,
      serviceVersionId: row.serviceVersionId,
      serviceName: row.serviceName,
      basePrice: row.basePrice,
      quantity: row.quantity,
      discountPercent: String(row.discountPercent),
      lineTotal: row.lineTotal,
      description: extra?.description ?? null,
      performedAt: extra?.performedAt ?? null,
      invoiceId: extra?.invoiceId ?? null,
    })
    .$returningId();
  const itemId = itemRes[0].id;
  if (row.additionals.length > 0) {
    await db.insert(schema.contractItemAdditionals).values(
      row.additionals.map((a) => ({
        contractItemId: itemId,
        additionalId: a.additionalId,
        name: a.name,
        unitPrice: a.unitPrice,
        quantity: a.quantity,
        discountPercent: String(a.discountPercent),
        lineTotal: a.lineTotal,
      }))
    );
  }
  return itemId;
}

// Contract total = sum of item line totals (already per-item discounted)
// plus the contract-level custom modifiers (which may be negative). Never below 0.
async function recomputeContractTotal(contractId: number) {
  const [contract] = await db
    .select({ type: schema.contracts.type })
    .from(schema.contracts)
    .where(eq(schema.contracts.id, contractId));

  let total: number;
  if (contract?.type === 'invoice') {
    // Recurring contract total = the amount actually billed: the sum of its
    // invoices, each net of any credit applied.
    const invs = await db
      .select({ total: schema.invoices.total, creditApplied: schema.invoices.creditApplied })
      .from(schema.invoices)
      .where(eq(schema.invoices.contractId, contractId));
    total = Math.max(0, round2(invs.reduce((s, i) => s + (Number(i.total) - Number(i.creditApplied ?? 0)), 0)));
  } else {
    // One-time contract total = its items (already discounted) + its modifiers.
    const rows = await db
      .select({ lineTotal: schema.contractItems.lineTotal })
      .from(schema.contractItems)
      .where(eq(schema.contractItems.contractId, contractId));
    const mods = await db
      .select({ price: schema.contractModifiers.price, discountPercent: schema.contractModifiers.discountPercent })
      .from(schema.contractModifiers)
      .where(eq(schema.contractModifiers.contractId, contractId));
    const itemsSum = rows.reduce((s, r) => s + Number(r.lineTotal), 0);
    const modsSum = mods.reduce((s, m) => s + Number(m.price) * (1 - (Number(m.discountPercent) || 0) / 100), 0);
    total = Math.max(0, round2(itemsSum + modsSum));
  }

  await db.update(schema.contracts).set({ total: String(total) }).where(eq(schema.contracts.id, contractId));
  return total;
}

// Money actually discounted on item lines: (gross before %) − net lineTotal,
// summed over each item's service line and its additionals.
function itemsDiscountAmount(items: any[]): number {
  return itemsGrossTotal(items) - (items ?? []).reduce((s: number, it: any) => s + Number(it.lineTotal), 0);
}

// Value of the items BEFORE any discount: each service's base price × quantity plus
// its additionals at their unit price × quantity.
function itemsGrossTotal(items: any[]): number {
  return (items ?? []).reduce(
    (sum: number, it: any) =>
      sum +
      Number(it.basePrice) * Number(it.quantity) +
      (it.additionals ?? []).reduce((s: number, a: any) => s + Number(a.unitPrice) * Number(a.quantity), 0),
    0
  );
}

// Sum of the modifiers' values BEFORE their discount % (may include negative ones).
function modifiersGrossTotal(mods: any[]): number {
  return (mods ?? []).reduce((s: number, m: any) => s + Number(m.price), 0);
}

// Money discounted by the % on each custom modifier (positive discounts only).
function modifiersDiscountAmount(mods: any[]): number {
  return (mods ?? []).reduce(
    (s: number, m: any) => s + Number(m.price) * ((Number(m.discountPercent) || 0) / 100),
    0
  );
}

// Replace a contract's custom modifiers. items: [{name, price}]
async function persistContractModifiers(contractId: number, modifiers: any[] | undefined) {
  await db.delete(schema.contractModifiers).where(eq(schema.contractModifiers.contractId, contractId));
  const rows = (modifiers ?? [])
    .filter((m) => m && m.name)
    .map((m) => ({
      contractId,
      name: m.name,
      price: String(Number(m.price) || 0),
      discountPercent: String(Number(m.discountPercent) || 0),
    }));
  if (rows.length > 0) await db.insert(schema.contractModifiers).values(rows);
}

// Deduct up to `total` from a customer's credit; returns the amount applied and
// reduces the credit's remaining balance. Validates the credit belongs to the customer.
async function applyCredit(opts: {
  creditId: number | null | undefined;
  customerId: number | null;
  total: number;
}): Promise<number> {
  const { creditId, customerId, total } = opts;
  if (!creditId || !customerId || total <= 0) return 0;
  const [credit] = await db
    .select()
    .from(schema.customerCredits)
    .where(eq(schema.customerCredits.id, Number(creditId)));
  if (!credit || credit.customerId !== customerId) return 0;
  const remaining = Number(credit.remaining);
  if (remaining <= 0) return 0;
  const applied = round2(Math.min(remaining, total));
  await db
    .update(schema.customerCredits)
    .set({ remaining: String(round2(remaining - applied)) })
    .where(eq(schema.customerCredits.id, credit.id));
  return applied;
}

// Description of the credit used on a document (empty when none was applied).
async function creditDescription(creditId: number | null | undefined): Promise<string> {
  if (!creditId) return '';
  const [row] = await db
    .select({ description: schema.customerCredits.description })
    .from(schema.customerCredits)
    .where(eq(schema.customerCredits.id, Number(creditId)));
  return row?.description ?? '';
}

// Give back a credit that an invoice had applied (on invoice delete/edit): the
// applied amount returns to the credit's remaining balance.
async function reinstateInvoiceCredit(inv: { creditId: number | null; creditApplied: string | null }) {
  const applied = Number(inv.creditApplied ?? 0);
  if (!inv.creditId || applied <= 0) return;
  const [credit] = await db
    .select()
    .from(schema.customerCredits)
    .where(eq(schema.customerCredits.id, inv.creditId));
  if (!credit) return;
  await db
    .update(schema.customerCredits)
    .set({ remaining: String(round2(Number(credit.remaining) + applied)) })
    .where(eq(schema.customerCredits.id, credit.id));
}

type InvoiceBody = {
  reference?: string | null;
  comments?: string | null;
  discountPercent?: number | string;
  installments?: number | string;
  dueDates?: string[];
  modifiers?: any[];
  creditId?: number | null;
  creditDescription?: string;
};

// Compute an invoice's totals and write its composition onto an existing invoice
// row: fields, modifiers, billed items, installment payments, and (when the raw
// total is negative) a surplus customer credit. Shared by create and edit.
// The invoice row and its old modifiers/payments must already be clear; `billable`
// are the (unbilled) items to attach.
async function composeInvoice(
  invoiceId: number,
  contractId: number,
  customerId: number | null,
  body: InvoiceBody,
  billable: (typeof schema.contractItems.$inferSelect)[],
  // Only create-time banks a negative fatura's surplus as a new credit; edits do
  // not, because the originally banked credit can't be reliably reversed here.
  bankSurplus = true
) {
  const { reference, comments, discountPercent, installments, dueDates, modifiers, creditId, creditDescription } = body;

  const subtotal = billable.reduce((s, it) => s + Number(it.lineTotal), 0);
  const modsSum = (modifiers ?? [])
    .filter((m: any) => m && m.name)
    .reduce((s: number, m: any) => s + (Number(m.price) || 0) * (1 - (Number(m.discountPercent) || 0) / 100), 0);
  // The raw total may be negative (e.g. negative modifiers); the invoice is
  // clamped to 0 and the surplus becomes a customer credit (below).
  const rawTotal = round2(withDisc(subtotal, discountPercent) + modsSum);
  const total = Math.max(0, rawTotal);
  const creditApplied = await applyCredit({ creditId, customerId, total });
  const base = Math.max(0, round2(total - creditApplied));
  const count = base > 0 ? Math.min(Math.max(1, Number(installments) || 1), await maxInstallmentsFor(base)) : 0;

  await db
    .update(schema.invoices)
    .set({
      reference: reference ?? null,
      comments: comments ?? null,
      discountPercent: String(discountPercent ?? 0),
      installments: count,
      total: String(total),
      creditId: creditApplied > 0 ? Number(creditId) : null,
      creditApplied: creditApplied > 0 ? String(creditApplied) : '0',
    })
    .where(eq(schema.invoices.id, invoiceId));

  const modRows = (modifiers ?? [])
    .filter((m: any) => m && m.name)
    .map((m: any) => ({
      invoiceId,
      name: m.name,
      price: String(Number(m.price) || 0),
      discountPercent: String(Number(m.discountPercent) || 0),
    }));
  if (modRows.length > 0) await db.insert(schema.invoiceModifiers).values(modRows);

  if (billable.length > 0) {
    await db
      .update(schema.contractItems)
      .set({ invoiceId })
      .where(inArray(schema.contractItems.id, billable.map((it) => it.id)));
  }

  if (base > 0) {
    await createInstallmentPayments({
      contractId,
      invoiceId,
      customerId,
      label: reference ?? '',
      total: base,
      count,
      dueDates,
    });
  }

  if (bankSurplus && rawTotal < 0 && customerId) {
    const surplus = round2(-rawTotal);
    const desc =
      (typeof creditDescription === 'string' && creditDescription.trim()) ||
      `Crédito da fatura${reference ? ` ${reference}` : ''}`;
    await db.insert(schema.customerCredits).values({
      customerId,
      description: desc,
      value: String(surplus),
      remaining: String(surplus),
    });
  }
}

async function loadFullContract(id: number) {
  const [contract] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, id));
  if (!contract) return null;
  const [customer] = contract.customerId
    ? await db.select().from(schema.customers).where(eq(schema.customers.id, contract.customerId))
    : [null];

  const items = await db
    .select()
    .from(schema.contractItems)
    .where(eq(schema.contractItems.contractId, id));
  const itemsFull = [];
  for (const item of items) {
    const additionals = await db
      .select()
      .from(schema.contractItemAdditionals)
      .where(eq(schema.contractItemAdditionals.contractItemId, item.id));
    // Resolve the owning service + version number (for the editor's version picker).
    let serviceId: number | null = null;
    let version: number | null = null;
    if (item.serviceVersionId) {
      const [v] = await db
        .select({ serviceId: schema.serviceVersions.serviceId, version: schema.serviceVersions.version })
        .from(schema.serviceVersions)
        .where(eq(schema.serviceVersions.id, item.serviceVersionId));
      if (v) {
        serviceId = v.serviceId;
        version = v.version;
      }
    }
    itemsFull.push({ ...item, serviceId, version, additionals });
  }

  const modifiers = await db
    .select()
    .from(schema.contractModifiers)
    .where(eq(schema.contractModifiers.contractId, id));

  const documents = await db
    .select()
    .from(schema.contractDocuments)
    .where(eq(schema.contractDocuments.contractId, id))
    .orderBy(desc(schema.contractDocuments.generatedAt));

  // All payments (installments) generated for this contract.
  const allPayments = await db
    .select()
    .from(schema.payments)
    .where(eq(schema.payments.contractId, id))
    .orderBy(schema.payments.installmentNumber);
  // Contract-level installments (one-time) vs invoice-level.
  const payments = allPayments.filter((p) => !p.invoiceId);

  // Invoices (recurring contracts) with their own documents + payments.
  const invoiceRows = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.contractId, id))
    .orderBy(desc(schema.invoices.id));
  const invoices = [];
  for (const inv of invoiceRows) {
    const invDocs = documents.filter((d) => d.invoiceId === inv.id);
    const invPays = allPayments.filter((p) => p.invoiceId === inv.id);
    const invMods = await db
      .select()
      .from(schema.invoiceModifiers)
      .where(eq(schema.invoiceModifiers.invoiceId, inv.id));
    invoices.push({ ...inv, documents: invDocs, payments: invPays, modifiers: invMods });
  }

  return { ...contract, customer, items: itemsFull, documents, invoices, payments, modifiers };
}

// Persist several items (one-time contract scope).
async function persistItems(contractId: number, built: SnapshotRow[]) {
  for (const r of built) await persistOneItem(contractId, r);
}

export function registerContractRoutes(app: FastifyInstance) {
  // List contracts with a few summary fields.
  app.get('/api/contracts', async () => {
    const rows = await db
      .select({
        id: schema.contracts.id,
        number: schema.contracts.number,
        type: schema.contracts.type,
        title: schema.contracts.title,
        total: schema.contracts.total,
        createdAt: schema.contracts.createdAt,
        customerId: schema.contracts.customerId,
        customerName: schema.customers.name,
        status: schema.contracts.status,
        statusChangedAt: schema.contracts.statusChangedAt,
      })
      .from(schema.contracts)
      .leftJoin(schema.customers, eq(schema.contracts.customerId, schema.customers.id))
      .orderBy(desc(schema.contracts.id));
    return rows;
  });

  // Contracts whose time-boxed status has passed its deadline (for the Painel).
  app.get('/api/contracts/overdue', async () => {
    const [s] = await db.select().from(schema.settings).where(eq(schema.settings.id, 1));
    const editDays = s?.editWindowDays ?? 20;
    const previewDays = s?.previewWindowDays ?? 30;
    const rows = await db
      .select({
        id: schema.contracts.id,
        number: schema.contracts.number,
        title: schema.contracts.title,
        status: schema.contracts.status,
        statusChangedAt: schema.contracts.statusChangedAt,
        customerName: schema.customers.name,
      })
      .from(schema.contracts)
      .leftJoin(schema.customers, eq(schema.contracts.customerId, schema.customers.id))
      .where(inArray(schema.contracts.status, ['em_edicao', 'enviado']));
    const now = Date.now();
    return rows
      .map((r) => {
        const days = r.status === 'em_edicao' ? editDays : previewDays;
        const deadline = new Date(r.statusChangedAt);
        deadline.setDate(deadline.getDate() + days);
        return { ...r, days, deadline: deadline.toISOString(), overdue: now > deadline.getTime() };
      })
      .filter((r) => r.overdue);
  });

  app.get('/api/contracts/:id', async (req: any, reply) => {
    const full = await loadFullContract(Number(req.params.id));
    if (!full) return reply.code(404).send({ error: 'not found' });
    return full;
  });

  // Advance/revert the one-time contract workflow by exactly one step.
  app.put('/api/contracts/:id/status', async (req: any, reply) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    const [c] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, id));
    if (!c) return reply.code(404).send({ error: 'not found' });
    const statuses = schema.CONTRACT_STATUSES as readonly string[];
    const curIdx = statuses.indexOf(c.status);
    const nextIdx = statuses.indexOf(status);
    if (nextIdx < 0) return reply.code(400).send({ error: 'status inválido' });
    if (Math.abs(nextIdx - curIdx) !== 1) {
      return reply.code(400).send({ error: 'só é possível avançar ou voltar um passo por vez' });
    }
    await db
      .update(schema.contracts)
      .set({ status: status as any, statusChangedAt: new Date() })
      .where(eq(schema.contracts.id, id));
    return loadFullContract(id);
  });

  // Create a contract.
  // One-time body: { customerId, type:'contract', items:[oneItem], modifiers:[{name,price}],
  //                  installments, dueDates, templateId, execution*, comments }
  //   where item = { serviceVersionId, quantity?, discountPercent?, additionals:[{additionalId, quantity, discountPercent}] }
  // Recurring body: { customerId, type:'invoice', title?, invoiceTemplateId?, comments }
  app.post('/api/contracts', async (req: any, reply) => {
    const {
      customerId,
      type,
      title,
      comments,
      items,
      modifiers,
      installments,
      dueDates,
      templateId,
      invoiceTemplateId,
      receiptTemplateId,
      executionDate,
      executionTime,
      executionAddress,
      duration,
      quantity,
      creditId,
    } = req.body ?? {};
    const isOneTime = (type ?? 'contract') !== 'invoice';
    const { rows, total: itemsSum } = await buildItems(isOneTime ? items ?? [] : []);
    const number = await nextContractNumber(isOneTime ? 'contract' : 'invoice');

    // A one-time contract's title is the (single) service name.
    const derivedTitle = isOneTime ? rows[0]?.serviceName ?? title ?? null : title ?? null;

    // Installment count is bounded by the discounted total (items + modifiers).
    const modsSum = isOneTime
      ? (modifiers ?? []).reduce(
          (s: number, m: any) => s + (Number(m?.price) || 0) * (1 - (Number(m?.discountPercent) || 0) / 100),
          0
        )
      : 0;
    const baseFinal = Math.max(0, itemsSum + modsSum);
    const count = isOneTime
      ? Math.min(Math.max(1, Number(installments) || 1), await maxInstallmentsFor(baseFinal))
      : 1;

    const res: any = await db
      .insert(schema.contracts)
      .values({
        number,
        customerId: customerId ?? null,
        type: type ?? 'contract',
        title: derivedTitle,
        comments: comments ?? null,
        installments: count,
        templateId: isOneTime ? templateId ?? null : null,
        invoiceTemplateId: isOneTime ? null : invoiceTemplateId ?? null,
        receiptTemplateId: receiptTemplateId ?? null,
        executionDate: executionDate ?? null,
        executionTime: executionTime ?? null,
        executionAddress: executionAddress ?? null,
        duration: isOneTime ? duration ?? null : null,
        quantity: isOneTime ? (quantity != null && quantity !== '' ? Number(quantity) : null) : null,
        total: '0',
      })
      .$returningId();
    const contractId = res[0].id;

    await persistItems(contractId, rows);
    if (isOneTime) await persistContractModifiers(contractId, modifiers);
    const total = await recomputeContractTotal(contractId);

    // Apply a prepaid credit: it reduces the amount split into installments.
    const creditApplied = isOneTime ? await applyCredit({ creditId, customerId: customerId ?? null, total }) : 0;
    const base = Math.max(0, round2(total - creditApplied));
    const finalCount = base > 0 ? Math.min(Math.max(1, Number(installments) || 1), await maxInstallmentsFor(base)) : 0;

    if (isOneTime) {
      await db
        .update(schema.contracts)
        .set({
          installments: finalCount,
          ...(creditApplied > 0 ? { creditId: Number(creditId), creditApplied: String(creditApplied) } : {}),
        })
        .where(eq(schema.contracts.id, contractId));
      // Generate installment payments only for the amount still owed after credit.
      if (base > 0) {
        await createInstallmentPayments({
          contractId,
          customerId: customerId ?? null,
          label: '',
          total: base,
          count: finalCount,
          dueDates,
        });
      }
    }

    reply.code(201);
    return loadFullContract(contractId);
  });

  // Update a contract; items are fully replaced from the payload.
  // Edit a contract; items are fully rebuilt from the payload. Each item names
  // an explicit serviceVersionId, so keeping the original version reproduces the
  // exact original price (versions are immutable) while the user may also switch
  // an item to a different version on purpose.
  // Body: { customerId?, type?, title?, comments?, items:[{serviceVersionId, modifierIds:[]}] }
  app.put('/api/contracts/:id', async (req: any, reply) => {
    const id = Number(req.params.id);
    const [existing] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, id));
    if (!existing) return reply.code(404).send({ error: 'not found' });

    const {
      customerId,
      type,
      title,
      comments,
      items,
      modifiers,
      installments,
      dueDates,
      templateId,
      invoiceTemplateId,
      receiptTemplateId,
      executionDate,
      executionTime,
      executionAddress,
      duration,
      quantity,
    } = req.body ?? {};

    // Full contract edit (one-time): rebuild items + modifiers; title = service name.
    // Header-only edit (items omitted) leaves line items untouched.
    let newTitle: string | null | undefined;
    if (Array.isArray(items)) {
      const { rows } = await buildItems(items);
      await db.delete(schema.contractItems).where(eq(schema.contractItems.contractId, id));
      await persistItems(id, rows);
      newTitle = rows[0]?.serviceName ?? null;
      if (modifiers !== undefined) await persistContractModifiers(id, modifiers);
    } else if (title !== undefined) {
      newTitle = title;
    }

    await db
      .update(schema.contracts)
      .set({
        ...(customerId !== undefined ? { customerId } : {}),
        ...(type !== undefined ? { type } : {}),
        ...(newTitle !== undefined ? { title: newTitle } : {}),
        ...(comments !== undefined ? { comments } : {}),
        ...(templateId !== undefined ? { templateId: templateId ?? null } : {}),
        ...(invoiceTemplateId !== undefined ? { invoiceTemplateId: invoiceTemplateId ?? null } : {}),
        ...(receiptTemplateId !== undefined ? { receiptTemplateId: receiptTemplateId ?? null } : {}),
        ...(executionDate !== undefined ? { executionDate: executionDate ?? null } : {}),
        ...(executionTime !== undefined ? { executionTime: executionTime ?? null } : {}),
        ...(executionAddress !== undefined ? { executionAddress: executionAddress ?? null } : {}),
        ...(duration !== undefined ? { duration: duration ?? null } : {}),
        ...(quantity !== undefined
          ? { quantity: quantity != null && quantity !== '' ? Number(quantity) : null }
          : {}),
      })
      .where(eq(schema.contracts.id, id));

    const total = await recomputeContractTotal(id);

    // Resolve + store installment count against the new total.
    let count: number | undefined;
    if (installments !== undefined) {
      count = Math.min(Math.max(1, Number(installments) || 1), await maxInstallmentsFor(total));
      await db.update(schema.contracts).set({ installments: count }).where(eq(schema.contracts.id, id));
    }

    // Regenerate the contract-level installment payments when the client sends
    // due dates (i.e., the full contract form was submitted, not a header-only edit).
    if (Array.isArray(dueDates)) {
      await db
        .delete(schema.payments)
        .where(and(eq(schema.payments.contractId, id), isNull(schema.payments.invoiceId)));
      await createInstallmentPayments({
        contractId: id,
        customerId: customerId ?? existing.customerId,
        label: '',
        total,
        count: count ?? (Number(existing.installments) || 1),
        dueDates,
      });
    }

    return loadFullContract(id);
  });

  app.delete('/api/contracts/:id', async (req: any, reply) => {
    await db.delete(schema.contracts).where(eq(schema.contracts.id, Number(req.params.id)));
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Recurring contracts: performed services (logged over time) + invoices
  // -------------------------------------------------------------------------

  // Log a performed service against a contract.
  // Body: { serviceVersionId, modifierIds?:[], description?, performedAt? }
  app.post('/api/contracts/:id/items', async (req: any, reply) => {
    const contractId = Number(req.params.id);
    const [contract] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, contractId));
    if (!contract) return reply.code(404).send({ error: 'contract not found' });

    const { serviceVersionId, additionals, description, performedAt, quantity, discountPercent, items } = req.body ?? {};

    // Batch mode: each entry becomes a separate single-unit item sharing one
    // service version + performed date, with its own description and additionals.
    if (Array.isArray(items) && items.length > 0) {
      for (const entry of items) {
        const row = await snapshotOne({
          serviceVersionId: Number(serviceVersionId),
          quantity: 1,
          discountPercent: entry?.discountPercent ?? discountPercent,
          additionals: entry?.additionals,
        });
        if (!row) return reply.code(400).send({ error: 'invalid serviceVersionId' });
        await persistOneItem(contractId, row, {
          description: entry?.description ?? null,
          performedAt: performedAt ?? null,
          invoiceId: null,
        });
      }
      await recomputeContractTotal(contractId);
      reply.code(201);
      return loadFullContract(contractId);
    }

    // Single item (legacy).
    const row = await snapshotOne({ serviceVersionId: Number(serviceVersionId), quantity, discountPercent, additionals });
    if (!row) return reply.code(400).send({ error: 'invalid serviceVersionId' });

    await persistOneItem(contractId, row, {
      description: description ?? null,
      performedAt: performedAt ?? null,
      invoiceId: null,
    });
    await recomputeContractTotal(contractId);
    reply.code(201);
    return loadFullContract(contractId);
  });

  // Edit a performed service — allowed only until it is billed by an invoice.
  // Re-snapshots the service/additionals and updates the item in place.
  app.put('/api/contracts/:id/items/:itemId', async (req: any, reply) => {
    const contractId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const [item] = await db.select().from(schema.contractItems).where(eq(schema.contractItems.id, itemId));
    if (!item || item.contractId !== contractId) return reply.code(404).send({ error: 'item not found' });
    if (item.invoiceId) return reply.code(409).send({ error: 'item já faturado; não pode ser editado' });

    const { serviceVersionId, additionals, description, performedAt, discountPercent } = req.body ?? {};
    const row = await snapshotOne({
      serviceVersionId: Number(serviceVersionId ?? item.serviceVersionId),
      quantity: item.quantity, // single-unit model: quantity is not changed here
      discountPercent: discountPercent ?? item.discountPercent,
      additionals,
    });
    if (!row) return reply.code(400).send({ error: 'invalid serviceVersionId' });

    await db
      .update(schema.contractItems)
      .set({
        serviceVersionId: row.serviceVersionId,
        serviceName: row.serviceName,
        basePrice: row.basePrice,
        quantity: row.quantity,
        discountPercent: String(row.discountPercent),
        lineTotal: row.lineTotal,
        description: description ?? null,
        performedAt: performedAt ?? null,
      })
      .where(eq(schema.contractItems.id, itemId));

    // Replace the item's additionals with the new snapshot.
    await db.delete(schema.contractItemAdditionals).where(eq(schema.contractItemAdditionals.contractItemId, itemId));
    if (row.additionals.length > 0) {
      await db.insert(schema.contractItemAdditionals).values(
        row.additionals.map((a) => ({
          contractItemId: itemId,
          additionalId: a.additionalId,
          name: a.name,
          unitPrice: a.unitPrice,
          quantity: a.quantity,
          discountPercent: String(a.discountPercent),
          lineTotal: a.lineTotal,
        }))
      );
    }

    await recomputeContractTotal(contractId);
    return loadFullContract(contractId);
  });

  // Remove a performed service (only if it hasn't been billed yet).
  app.delete('/api/contracts/:id/items/:itemId', async (req: any, reply) => {
    const contractId = Number(req.params.id);
    const itemId = Number(req.params.itemId);
    const [item] = await db.select().from(schema.contractItems).where(eq(schema.contractItems.id, itemId));
    if (!item) return reply.code(404).send({ error: 'item not found' });
    if (item.invoiceId) return reply.code(409).send({ error: 'item já faturado; exclua a fatura primeiro' });
    await db.delete(schema.contractItems).where(eq(schema.contractItems.id, itemId));
    await recomputeContractTotal(contractId);
    return loadFullContract(contractId);
  });

  // Create an invoice from selected (unbilled) performed services.
  // Body: { reference?, comments?, itemIds: number[], modifiers?: [{name,price,discountPercent}] }
  app.post('/api/contracts/:id/invoices', async (req: any, reply) => {
    const contractId = Number(req.params.id);
    const { itemIds } = req.body ?? {};
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return reply.code(400).send({ error: 'selecione ao menos um serviço' });
    }

    const [contract] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, contractId));
    if (!contract) return reply.code(404).send({ error: 'contract not found' });

    // Only bill items that belong to this contract and are still unbilled.
    const items = await db
      .select()
      .from(schema.contractItems)
      .where(inArray(schema.contractItems.id, itemIds.map((n: any) => Number(n))));
    const billable = items.filter((it) => it.contractId === contractId && !it.invoiceId);
    if (billable.length === 0) return reply.code(400).send({ error: 'nenhum item válido para faturar' });

    // Insert the invoice shell (keeps its sequential refNumber), then compose it.
    const invRes: any = await db
      .insert(schema.invoices)
      .values({
        contractId,
        refNumber: await nextInvoiceRefNumber(),
        discountPercent: '0',
        installments: 0,
        total: '0',
      })
      .$returningId();
    const invoiceId = invRes[0].id;

    await composeInvoice(invoiceId, contractId, contract.customerId, req.body, billable);
    await recomputeContractTotal(contractId);
    reply.code(201);
    return loadFullContract(contractId);
  });

  // Edit a generated invoice: change reference/comments/discount/modifiers/items/
  // credit and re-plan installments. Items removed from the invoice are unbilled
  // (returned to the open list); the previously applied credit is reinstated and
  // recomputed. Blocked once any installment has been received.
  app.put('/api/invoices/:id', async (req: any, reply) => {
    const invoiceId = Number(req.params.id);
    const { itemIds } = req.body ?? {};
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!inv) return reply.code(404).send({ error: 'not found' });
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return reply.code(400).send({ error: 'selecione ao menos um serviço' });
    }
    const [contract] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, inv.contractId));
    if (!contract) return reply.code(404).send({ error: 'contract not found' });

    // Cannot edit once money has come in: any installment already received/sent.
    const invPayments = await db.select().from(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
    if (invPayments.some((p) => p.receiptStatus !== 'open')) {
      return reply.code(409).send({ error: 'fatura com parcela já recebida não pode ser editada' });
    }

    // Candidate items: belong to this contract AND are either unbilled or already
    // on THIS invoice (validate before mutating anything).
    const chosen = await db
      .select()
      .from(schema.contractItems)
      .where(inArray(schema.contractItems.id, itemIds.map((n: any) => Number(n))));
    const billable = chosen.filter(
      (it) => it.contractId === inv.contractId && (!it.invoiceId || it.invoiceId === invoiceId)
    );
    if (billable.length === 0) return reply.code(400).send({ error: 'nenhum item válido para faturar' });

    // Undo the old composition: reinstate applied credit, unbill its items, drop
    // its payments/modifiers/generated documents (all stale after an edit).
    await reinstateInvoiceCredit(inv);
    await db
      .update(schema.contractItems)
      .set({ invoiceId: null })
      .where(eq(schema.contractItems.invoiceId, invoiceId));
    await db.delete(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
    await db.delete(schema.invoiceModifiers).where(eq(schema.invoiceModifiers.invoiceId, invoiceId));
    await db.delete(schema.contractDocuments).where(eq(schema.contractDocuments.invoiceId, invoiceId));

    await composeInvoice(invoiceId, inv.contractId, contract.customerId, req.body, billable, false);
    await recomputeContractTotal(inv.contractId);
    reply.code(200);
    return loadFullContract(inv.contractId);
  });

  // Delete an invoice: reinstate any applied credit, unbill its items, remove its
  // documents + payments (cascade) + the invoice.
  app.delete('/api/invoices/:id', async (req: any, reply) => {
    const invoiceId = Number(req.params.id);
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!inv) return reply.code(404).send({ error: 'not found' });
    await reinstateInvoiceCredit(inv);
    await db
      .update(schema.contractItems)
      .set({ invoiceId: null })
      .where(eq(schema.contractItems.invoiceId, invoiceId));
    await db.delete(schema.invoices).where(eq(schema.invoices.id, invoiceId)); // cascades documents + payments
    await recomputeContractTotal(inv.contractId);
    return reply.code(204).send();
  });

  // Generate an invoice .docx listing the billed services WITH their descriptions.
  app.post('/api/invoices/:id/generate', async (req: any, reply) => {
    const invoiceId = Number(req.params.id);
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!inv) return reply.code(404).send({ error: 'invoice not found' });
    const full = await loadFullContract(inv.contractId);
    if (!full) return reply.code(404).send({ error: 'contract not found' });

    const c = full.customer;
    const now = new Date();
    const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const invItems = full.items.filter((it) => it.invoiceId === invoiceId);

    // Actual money discounted: per-item/additional discounts + invoice-level %
    // on the items subtotal + modifier %.
    const discountTotal = round2(
      itemsDiscountAmount(invItems) +
        invItems.reduce((s, it) => s + Number(it.lineTotal), 0) * ((Number(inv.discountPercent) || 0) / 100) +
        modifiersDiscountAmount(full.invoices.find((i) => i.id === invoiceId)?.modifiers ?? [])
    );

    // Summary list: the same service collapsed into one row — total quantity and
    // summed value — for the invoice's first ("resumo") page. Items are grouped
    // only when they share BOTH the service AND the exact same additionals
    // (same additionals with the same quantities); differing additionals produce
    // separate rows. Rows appear in the order each combination first shows up.
    const additionalsSig = (it: any) =>
      (it.additionals ?? [])
        .map((a: any) => `${a.additionalId}:${Number(a.quantity)}`)
        .sort()
        .join('|');
    const summaryMap = new Map<
      string,
      { service_name: string; quantity: number; basePrice: number; total: number; additionals: any[] }
    >();
    for (const it of invItems) {
      const key = `${it.serviceName}@@${additionalsSig(it)}`;
      const cur =
        summaryMap.get(key) ??
        {
          service_name: it.serviceName,
          quantity: 0,
          basePrice: Number(it.basePrice),
          total: 0,
          additionals: (it.additionals ?? []).map((a: any) => ({
            name: a.name,
            quantity: Number(a.quantity),
            unitPrice: Number(a.unitPrice),
          })),
        };
      cur.quantity += Number(it.quantity);
      cur.total += Number(it.lineTotal);
      summaryMap.set(key, cur);
    }
    const itemsSummary = [...summaryMap.values()];

    const data = {
      customer_name: c?.name ?? '',
      customer_nickname: c?.nickname ?? '',
      customer_address: c?.address ?? '',
      customer_neighborhood: c?.neighborhood ?? '',
      customer_city: c?.city ?? '',
      customer_uf: c?.state ?? '',
      customer_email: c?.email ?? '',
      customer_phone: c?.phone ?? '',
      customer_whatsapp: c?.whatsapp ?? '',
      customer_document: c?.document ?? '',
      contract_number: full.number ?? '',
      title: full.title ?? '',
      invoice_reference: inv.reference ?? '',
      invoice_number: inv.refNumber ?? '',
      comments: inv.comments ?? '',
      // Value before ANY discount: services (+ additionals) at their base price plus
      // all modifiers at their full value. {subtotal} − {discount_total} = {total_before_credit}.
      subtotal: brl(
        itemsGrossTotal(invItems) + modifiersGrossTotal(full.invoices.find((i) => i.id === invoiceId)?.modifiers ?? [])
      ),
      discount_percent: `${Number(inv.discountPercent)}%`,
      discount_total: brl(discountTotal),
      // True only when a real discount was applied — wrap the discount line in
      // {#has_discount}...{/has_discount} to hide it entirely when there is none.
      has_discount: discountTotal > 0,
      // {total} is the amount actually charged (already net of any credit used).
      // {total_before_credit} keeps the gross; {total_after_credit} is an alias of {total}.
      total: brl(Number(inv.total) - Number(inv.creditApplied ?? 0)),
      total_before_credit: brl(Number(inv.total)),
      // Prepaid credit used on this fatura (use {#credit_used}...{/credit_used} for
      // conditional blocks). {credit_applied} is shown as a negative deduction.
      credit_used: Number(inv.creditApplied ?? 0) > 0,
      credit_applied: brl(Number(inv.creditApplied ?? 0) > 0 ? -Number(inv.creditApplied) : 0),
      credit_description: await creditDescription(inv.creditId),
      total_after_credit: brl(Number(inv.total) - Number(inv.creditApplied ?? 0)),
      // {date} stays the long form for compatibility; {date_short} is dd/MM/yyyy,
      // {date_long} an explicit alias — both usable in the template.
      date: longDatePtBR(now),
      date_long: longDatePtBR(now),
      date_short: now.toLocaleDateString('pt-BR'),
      installments_count: inv.installments,
      installments: (full.invoices.find((i) => i.id === invoiceId)?.payments ?? []).map((p) => ({
        number: p.installmentNumber,
        due_date: brDate(p.dueDate),
        amount: brl(Number(p.amount)),
      })),
      // Summary list (one row per service + additionals combination): use
      // {#items_summary}{item_number} {service_name} {quantity} {base_price}
      // {total} {#additionals}{name} x{quantity} {unit_price}{/additionals}{/items_summary}.
      items_summary: itemsSummary.map((s, i) => ({
        item_number: i + 1,
        service_name: s.service_name,
        quantity: s.quantity,
        base_price: brl(s.basePrice),
        total: brl(round2(s.total)),
        // Representative per-unit additionals of this row (identical across the
        // grouped items), so differing-additionals rows are distinguishable.
        additionals: s.additionals.map((a: any) => ({
          name: a.name,
          quantity: a.quantity,
          unit_price: brl(Number(a.unitPrice)),
        })),
      })),
      // Detailed list (one row per performed service, with descriptions).
      items: invItems.map((it, i) => ({
        item_number: i + 1,
        service_name: it.serviceName,
        description: it.description ?? '',
        performed_at: it.performedAt ?? '',
        quantity: it.quantity,
        base_price: brl(Number(it.basePrice)),
        // Service line only (base_price × quantity), before additionals.
        base_total: brl(Number(it.basePrice) * Number(it.quantity)),
        line_total: brl(Number(it.lineTotal)),
        additionals: (it.additionals ?? []).map((a) => ({
          name: a.name,
          quantity: a.quantity,
          unit_price: brl(Number(a.unitPrice)),
          line_total: brl(Number(a.lineTotal)),
        })),
      })),
      // Invoice-level custom modifiers (use {#modifiers}{name} {price} {discount_percent} {line_total}{/modifiers})
      modifiers: (full.invoices.find((i) => i.id === invoiceId)?.modifiers ?? []).map((m: any) => ({
        name: m.name,
        price: brl(Number(m.price)),
        discount_percent: `${Number(m.discountPercent ?? 0)}%`,
        line_total: brl(Number(m.price) * (1 - (Number(m.discountPercent ?? 0) || 0) / 100)),
      })),
    };

    const baseName = `fatura_${c?.nickname || c?.name || 'cliente'}_${inv.reference ?? inv.refNumber ?? invoiceId}`;
    // The recurring contract must have a selected invoice template (no default).
    const tpl = await loadTemplateById(full.invoiceTemplateId);
    if (!tpl) {
      return reply
        .code(400)
        .send({ error: 'Selecione um modelo de fatura no contrato recorrente antes de gerar.' });
    }
    let generated;
    try {
      generated = generateContract(data, baseName, tpl);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }

    // One document per invoice: the file name is deterministic (regenerating
    // overwrites the same file on disk), so collapse any prior rows for this invoice.
    await db.delete(schema.contractDocuments).where(eq(schema.contractDocuments.invoiceId, invoiceId));

    const docRes: any = await db
      .insert(schema.contractDocuments)
      .values({
        contractId: inv.contractId,
        invoiceId,
        comments: inv.comments ?? null,
        fileName: generated.fileName,
        filePath: generated.filePath,
        format: generated.format,
      })
      .$returningId();
    const [record] = await db
      .select()
      .from(schema.contractDocuments)
      .where(eq(schema.contractDocuments.id, docRes[0].id));
    reply.code(201);
    return record;
  });

  // Generate a document (.docx or .odt, following the chosen model) from the contract. Body: { comments? } (extra popup note).
  app.post('/api/contracts/:id/generate', async (req: any, reply) => {
    const id = Number(req.params.id);
    const full = await loadFullContract(id);
    if (!full) return reply.code(404).send({ error: 'contract not found' });

    const now = new Date();
    const c = full.customer;
    const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    // Actual money discounted: per-item/additional discounts + modifier %.
    const discountTotal = round2(itemsDiscountAmount(full.items) + modifiersDiscountAmount(full.modifiers));

    const data = {
      // customer
      customer_name: c?.name ?? '',
      customer_nickname: c?.nickname ?? '',
      customer_address: c?.address ?? '',
      customer_neighborhood: c?.neighborhood ?? '',
      customer_city: c?.city ?? '',
      customer_uf: c?.state ?? '',
      customer_email: c?.email ?? '',
      customer_phone: c?.phone ?? '',
      customer_whatsapp: c?.whatsapp ?? '',
      customer_document: c?.document ?? '',
      // contract
      contract_number: full.number ?? '',
      contract_type: full.type === 'invoice' ? 'Fatura' : 'Contrato',
      title: full.title ?? '',
      execution_date: full.executionDate ? new Date(full.executionDate + 'T00:00:00').toLocaleDateString('pt-BR') : '',
      execution_time: full.executionTime ?? '',
      execution_address: full.executionAddress ?? '',
      comments: full.comments || 'N/A',
      // Single service (one-time contract) exposed at top level for convenience.
      service_name: full.items[0]?.serviceName ?? '',
      service_base_price: brl(Number(full.items[0]?.basePrice ?? 0)),
      service_total: brl(Number(full.items[0]?.lineTotal ?? 0)),
      quantity: full.quantity ?? '',
      duration: full.duration ?? '',
      discount_percent: `${Number(full.items[0]?.discountPercent ?? 0)}%`,
      // Top-level additionals of the single service (use {#additionals}...{/additionals}).
      additionals: (full.items[0]?.additionals ?? []).map((a) => ({
        name: a.name,
        quantity: a.quantity,
        unit_price: brl(Number(a.unitPrice)),
        line_total: brl(Number(a.lineTotal)),
      })),
      // Value before ANY discount: the service (+ additionals) at its base price plus
      // all modifiers at their full value. {subtotal} − {discount_total} = {total_before_credit}.
      subtotal: brl(itemsGrossTotal(full.items) + modifiersGrossTotal(full.modifiers)),
      discount_total: brl(discountTotal),
      // True only when a real discount was applied — wrap the discount line in
      // {#has_discount}...{/has_discount} to hide it entirely when there is none.
      has_discount: discountTotal > 0,
      // {total} is the amount actually charged (already net of any credit used).
      // {total_before_credit} keeps the gross; {total_after_credit} is an alias of {total}.
      total: brl(Number(full.total) - Number(full.creditApplied ?? 0)),
      total_before_credit: brl(Number(full.total)),
      // Prepaid credit used on this contract (use {#credit_used}...{/credit_used} for
      // conditional blocks). {credit_applied} is shown as a negative deduction.
      credit_used: Number(full.creditApplied ?? 0) > 0,
      credit_applied: brl(Number(full.creditApplied ?? 0) > 0 ? -Number(full.creditApplied) : 0),
      credit_description: await creditDescription(full.creditId),
      total_after_credit: brl(Number(full.total) - Number(full.creditApplied ?? 0)),
      // {date} stays the long form for compatibility; {date_short} is dd/MM/yyyy,
      // {date_long} an explicit alias — both usable in the template.
      date: longDatePtBR(now),
      date_long: longDatePtBR(now),
      date_short: now.toLocaleDateString('pt-BR'),
      // installments (use {#installments}{number} {due_date} {amount}{/installments})
      installments_count: full.installments,
      installments: full.payments
        .filter((p) => p.installmentNumber)
        .map((p) => ({
          number: p.installmentNumber,
          due_date: brDate(p.dueDate),
          amount: brl(Number(p.amount)),
        })),
      // line items (use {#items}{service_name} {line_total} {#additionals}...{/additionals}{/items})
      items: full.items.map((it) => ({
        service_name: it.serviceName,
        description: it.description ?? '',
        quantity: it.quantity,
        base_price: brl(Number(it.basePrice)),
        // Service line only (base_price × quantity), before additionals.
        base_total: brl(Number(it.basePrice) * Number(it.quantity)),
        line_total: brl(Number(it.lineTotal)),
        additionals: (it.additionals ?? []).map((a) => ({
          name: a.name,
          quantity: a.quantity,
          unit_price: brl(Number(a.unitPrice)),
          line_total: brl(Number(a.lineTotal)),
        })),
      })),
      // contract-level custom modifiers (use {#modifiers}{name} {price}{/modifiers})
      modifiers: (full.modifiers ?? []).map((m) => ({
        name: m.name,
        price: brl(Number(m.price)),
        discount_percent: `${Number(m.discountPercent ?? 0)}%`,
        line_total: brl(Number(m.price) * (1 - (Number(m.discountPercent ?? 0) || 0) / 100)),
      })),
    };

    // File name: contrato_{apelido}_{numero} (e.g. contrato_FS_26-001).
    const nick = (c?.nickname || c?.name || 'cliente')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip accents
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .trim()
      .replace(/\s+/g, '_');
    const numPart = String(full.number ?? full.id).replace(/[^a-zA-Z0-9]+/g, '-');
    const baseName = `contrato_${nick}_${numPart}`;
    // The contract must have a selected document template (no default fallback).
    const tpl = await loadTemplateById(full.templateId);
    if (!tpl) {
      return reply
        .code(400)
        .send({ error: 'Selecione um modelo de contrato neste contrato antes de gerar o documento.' });
    }
    let generated;
    try {
      generated = generateContract(data, baseName, tpl);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }

    // Exactly one document record per contract. The file name is deterministic
    // (regenerating overwrites the same file on disk), so collapse any prior
    // rows — including pre-existing duplicates — and keep a single fresh record.
    await db
      .delete(schema.contractDocuments)
      .where(and(eq(schema.contractDocuments.contractId, id), isNull(schema.contractDocuments.invoiceId)));

    const docRes: any = await db
      .insert(schema.contractDocuments)
      .values({
        contractId: id,
        comments: full.comments ?? null,
        fileName: generated.fileName,
        filePath: generated.filePath,
        format: generated.format,
      })
      .$returningId();
    const [record] = await db
      .select()
      .from(schema.contractDocuments)
      .where(eq(schema.contractDocuments.id, docRes[0].id));

    reply.code(201);
    return record;
  });

  // Download a generated document.
  app.get('/api/contract-documents/:id/download', async (req: any, reply) => {
    const id = Number(req.params.id);
    const [row] = await db
      .select()
      .from(schema.contractDocuments)
      .where(eq(schema.contractDocuments.id, id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!fs.existsSync(row.filePath)) {
      return reply.code(410).send({ error: 'file no longer on this computer', filePath: row.filePath });
    }
    reply.header('Content-Disposition', `attachment; filename="${row.fileName}"`);
    reply.type(docMime(formatOfFileName(row.fileName)));
    return reply.send(fs.createReadStream(row.filePath));
  });

  // Download the same document converted to PDF — generated on the fly from the
  // stored .docx/.odt and never saved in the project folder.
  app.get('/api/contract-documents/:id/pdf', async (req: any, reply) => {
    const id = Number(req.params.id);
    const [row] = await db
      .select()
      .from(schema.contractDocuments)
      .where(eq(schema.contractDocuments.id, id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (!fs.existsSync(row.filePath)) {
      return reply.code(410).send({ error: 'file no longer on this computer', filePath: row.filePath });
    }
    let pdf: Buffer;
    try {
      const doc = await fs.promises.readFile(row.filePath);
      pdf = await officeToPdf(doc, formatOfFileName(row.fileName));
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
    const pdfName = row.fileName.replace(/\.(docx|odt)$/i, '') + '.pdf';
    reply.header('Content-Disposition', `attachment; filename="${pdfName}"`);
    reply.type('application/pdf');
    return reply.send(pdf);
  });

  // Delete a generated document — removes the DB record AND the file on disk.
  app.delete('/api/contract-documents/:id', async (req: any, reply) => {
    const id = Number(req.params.id);
    const [row] = await db
      .select()
      .from(schema.contractDocuments)
      .where(eq(schema.contractDocuments.id, id));
    if (!row) return reply.code(204).send();
    if (row.filePath && fs.existsSync(row.filePath)) {
      try {
        fs.unlinkSync(row.filePath);
      } catch {
        /* ignore filesystem errors; still remove the record */
      }
    }
    await db.delete(schema.contractDocuments).where(eq(schema.contractDocuments.id, id));
    return reply.code(204).send();
  });
}
