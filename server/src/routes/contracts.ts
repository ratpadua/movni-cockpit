import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq, ne, and, or, isNull, isNotNull, desc, inArray, like } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import {
  generateContract,
  longDatePtBR,
  parseIsoDate,
  docMime,
  formatOfFileName,
  sanitize,
  contractsDir,
} from '../lib/contract.js';
import { contentDisposition } from '../lib/http.js';
import {
  CONTRACT_TYPES,
  badRequest,
  isOneOf,
  optionalDate,
  optionalId,
  parseId,
  parseMoney,
} from '../lib/validate.js';
import { loadTemplateById } from './templates.js';
import { getMinInstallmentValue } from './settings.js';
import { officeToPdf } from '../lib/pdf.js';

const brDate = (s?: string | null) => {
  const d = parseIsoDate(s);
  return d ? d.toLocaleDateString('pt-BR') : '';
};


const round2 = (n: number) => Math.round(n * 100) / 100;

// A DB executor: the tx handed out by db.transaction() (or the shared db, cast).
// Helpers that take part in a transaction accept one (default: the shared db).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Tx;
const dbExec = (): Exec => db as unknown as Exec;

// MySQL duplicate-key error (unique index hit), possibly wrapped by the driver/ORM.
function isDupEntry(e: any): boolean {
  return e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062 || e?.cause?.code === 'ER_DUP_ENTRY' || e?.cause?.errno === 1062;
}

// Duplicate key (another machine took the number) or deadlock: safe to retry the whole transaction.
const isRetryable = (e: any) =>
  isDupEntry(e) || e?.code === 'ER_LOCK_DEADLOCK' || e?.errno === 1213 || e?.cause?.code === 'ER_LOCK_DEADLOCK' || e?.cause?.errno === 1213;

// Run fn (which allocates a number and writes inside one transaction). When two
// machines pick the same number the unique index rejects the second one (or MySQL
// reports a deadlock); we wait a jittered, growing delay (20-120ms base, doubling
// per attempt), recompute the next number and try again (up to 8 attempts).
async function withNumberRetry<T>(fn: () => Promise<T>): Promise<T> {
  const MAX_ATTEMPTS = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryable(e) || attempt >= MAX_ATTEMPTS) throw e;
      const delay = (20 + Math.random() * 100) * Math.min(2 ** (attempt - 1), 8);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Tiny in-process async mutex per key: this server never races itself when it
// allocates numbers (the DB unique index + retry still arbitrate between machines).
const mutexTails = new Map<string, Promise<void>>();
async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  mutexTails.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (mutexTails.get(key) === tail) mutexTails.delete(key);
  }
}

// Thrown inside a transaction to abort it and answer with a given HTTP status.
class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

// A document record as the client sees it: never the absolute path on this machine.
function publicDocument<T extends { filePath?: unknown }>(d: T): Omit<T, 'filePath'> {
  const { filePath: _filePath, ...rest } = d;
  return rest;
}

// ---- request validation (shape/format only; business rules live in the routes) ----

// Optional text field: undefined/null/'' pass; otherwise a string within `max`.
const textOk = (v: unknown, max: number) =>
  v === undefined || v === null || (typeof v === 'string' && v.length <= max);

// Free-value modifiers: [{ name, price, discountPercent }]; nameless entries are
// ignored later (as before). Returns an error message or null.
function modifiersError(modifiers: unknown): string | null {
  if (modifiers === undefined || modifiers === null) return null;
  if (!Array.isArray(modifiers)) return 'Lista de modificadores inválida.';
  for (const m of modifiers) {
    if (!m || !m.name) continue;
    if (typeof m.name !== 'string' || m.name.length > 255) return 'Nome de modificador inválido (máximo 255 caracteres).';
    if (parseMoney(m.price, { emptyAs: 0 }) === null) return `Valor inválido no modificador "${m.name}".`;
    if (m.discountPercent != null && m.discountPercent !== '' && !Number.isFinite(Number(m.discountPercent))) {
      return `Desconto inválido no modificador "${m.name}".`;
    }
  }
  return null;
}

// Installment due dates: an array of calendar dates (''/null allowed). Normalises ''
// to null in place. Returns an error message or null.
function dueDatesError(body: any): string | null {
  const dd = body.dueDates;
  if (dd === undefined || dd === null) return null;
  if (!Array.isArray(dd) || dd.length > 1000) return 'Lista de vencimentos inválida.';
  for (let i = 0; i < dd.length; i++) {
    const v = optionalDate(dd[i]);
    if (v === false) return `Vencimento da parcela ${i + 1}: data inválida.`;
    dd[i] = v ?? null;
  }
  return null;
}

function installmentsError(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  return typeof v !== 'object' && Number.isFinite(Number(v)) ? null : 'Número de parcelas inválido.';
}

// Create/update body of a contract (every field optional, as before — e.g. a contract
// without a customer is still allowed). Returns a pt-BR error or null.
function contractBodyError(body: any): string | null {
  if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body))) {
    return 'Dados inválidos.';
  }
  const b = body ?? {};
  for (const [k, label] of [
    ['customerId', 'Cliente'],
    ['templateId', 'Modelo do contrato'],
    ['invoiceTemplateId', 'Modelo da fatura'],
    ['receiptTemplateId', 'Modelo do recibo'],
    ['creditId', 'Crédito'],
  ] as const) {
    if (optionalId(b[k]) === false) return `${label} inválido.`;
  }
  const credErr = creditsError(b.credits);
  if (credErr) return credErr;
  if (b.type != null && !isOneOf(CONTRACT_TYPES, b.type)) return 'Tipo de contrato inválido.';
  if (optionalDate(b.executionDate) === false) return 'Data inválida (data de execução).';
  if (!textOk(b.title, 255)) return 'Título inválido (máximo 255 caracteres).';
  if (b.comments != null && typeof b.comments !== 'string') return 'Observações inválidas.';
  if (!textOk(b.executionTime, 16)) return 'Horário inválido.';
  if (!textOk(b.executionAddress, 512)) return 'Locação inválida (máximo 512 caracteres).';
  if (!textOk(b.duration, 128)) return 'Duração inválida (máximo 128 caracteres).';
  if (b.quantity != null && b.quantity !== '') {
    const q = Number(b.quantity);
    if (typeof b.quantity === 'object' || !Number.isFinite(q) || q < 0 || q > 2147483647) return 'Quantidade inválida.';
  }
  const inst = installmentsError(b.installments);
  if (inst) return inst;
  const dd = dueDatesError(b);
  if (dd) return dd;
  if (b.items !== undefined && b.items !== null) {
    if (!Array.isArray(b.items)) return 'Lista de itens inválida.';
    for (const it of b.items) {
      if (!it || typeof it !== 'object' || parseId(it.serviceVersionId) === null) return 'Serviço do item inválido.';
      if (it.additionals != null && !Array.isArray(it.additionals)) return 'Adicionais do item inválidos.';
    }
  }
  return modifiersError(b.modifiers);
}

// Body of an invoice (fatura) create/edit. Returns a pt-BR error or null.
function invoiceBodyError(body: any): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Dados inválidos.';
  if (!Array.isArray(body.itemIds) || body.itemIds.length === 0) return null; // reported by the route
  if (body.itemIds.length > 5000 || body.itemIds.some((n: unknown) => parseId(n) === null)) {
    return 'Lista de serviços inválida.';
  }
  if (!textOk(body.reference, 255)) return 'Referência inválida (máximo 255 caracteres).';
  if (body.comments != null && typeof body.comments !== 'string') return 'Observações inválidas.';
  if (body.discountPercent != null && body.discountPercent !== '' && !Number.isFinite(Number(body.discountPercent))) {
    return 'Desconto inválido.';
  }
  if (optionalId(body.creditId) === false) return 'Crédito inválido.';
  const credErr = creditsError(body.credits);
  if (credErr) return credErr;
  const inst = installmentsError(body.installments);
  if (inst) return inst;
  const dd = dueDatesError(body);
  if (dd) return dd;
  return modifiersError(body.modifiers);
}

// Where a stored document lives on disk. The DB's file_path is NOT trusted: the file
// is always <contracts dir>/<basename of file_name>, and the result must stay inside
// that directory. Null when the name is unusable.
function documentPath(fileName: string): string | null {
  const dir = path.resolve(contractsDir());
  const base = path.basename(String(fileName ?? ''));
  if (!base || base === '.' || base === '..') return null;
  const full = path.resolve(path.join(dir, base));
  return full.startsWith(dir + path.sep) ? full : null;
}

// Max installments so no installment is below the configured minimum value
// (Configurações → Parcelamento, R$150 by default); at least 1.
// Pass min (read BEFORE opening a transaction) to avoid a second pool connection inside it.
async function maxInstallmentsFor(total: number, min?: number): Promise<number> {
  return Math.max(1, Math.floor(total / (min ?? (await getMinInstallmentValue()))));
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
async function createInstallmentPayments(
  opts: {
    contractId: number | null;
    invoiceId?: number | null;
    customerId?: number | null;
    label: string;
    total: number;
    count: number;
    dueDates?: (string | null)[];
  },
  ex: Exec = dbExec()
) {
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
  if (rows.length > 0) await ex.insert(schema.payments).values(rows);
}

// Next contract number in the YY/XXX format, sequence resetting each year.
async function nextContractNumber(type: 'contract' | 'invoice', ex: Exec = dbExec()): Promise<string> {
  // Recurring contracts (invoices) use their own ever-increasing sequence: F001, F002, ...
  if (type === 'invoice') {
    const rows = await ex
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
  const rows = await ex
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
async function nextInvoiceRefNumber(ex: Exec = dbExec()): Promise<string> {
  const yy = String(new Date().getFullYear() % 100).padStart(2, '0');
  const suffix = `-${yy}`;
  const rows = await ex
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

// Number of payments already received (entrada: received/sent) or paid (saída: done)
// among the payments linked to a contract and/or to the given invoices.
// It is a LOCKING read (FOR UPDATE) meant to run inside a transaction: a concurrent
// receipt either committed first (and is seen here) or waits for this transaction.
async function countSettledPayments(
  opts: { contractId?: number; invoiceIds?: number[] },
  ex: Exec = dbExec()
): Promise<number> {
  const conds: any[] = [];
  if (opts.contractId !== undefined) conds.push(eq(schema.payments.contractId, opts.contractId));
  if (opts.invoiceIds && opts.invoiceIds.length > 0) conds.push(inArray(schema.payments.invoiceId, opts.invoiceIds));
  if (conds.length === 0) return 0;
  const rows = await ex
    .select({
      id: schema.payments.id,
      flow: schema.payments.flow,
      status: schema.payments.status,
      receiptStatus: schema.payments.receiptStatus,
    })
    .from(schema.payments)
    .where(conds.length === 1 ? conds[0] : or(...conds))
    .for('update');
  return rows.filter((p) =>
    p.flow === 'out' ? p.status === 'done' : p.receiptStatus === 'received' || p.receiptStatus === 'sent'
  ).length;
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
  extra?: { description?: string | null; performedAt?: string | null; invoiceId?: number | null },
  ex: Exec = dbExec()
): Promise<number> {
  const itemRes: any = await ex
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
    await ex.insert(schema.contractItemAdditionals).values(
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
async function recomputeContractTotal(contractId: number, ex: Exec = dbExec()) {
  const [contract] = await ex
    .select({ type: schema.contracts.type })
    .from(schema.contracts)
    .where(eq(schema.contracts.id, contractId));

  let total: number;
  if (contract?.type === 'invoice') {
    // Recurring contract total = the amount actually billed: the sum of its
    // invoices, each net of any credit applied.
    const invs = await ex
      .select({ total: schema.invoices.total, creditApplied: schema.invoices.creditApplied })
      .from(schema.invoices)
      .where(eq(schema.invoices.contractId, contractId));
    total = Math.max(0, round2(invs.reduce((s, i) => s + (Number(i.total) - Number(i.creditApplied ?? 0)), 0)));
  } else {
    // One-time contract total = its items (already discounted) + its modifiers.
    const rows = await ex
      .select({ lineTotal: schema.contractItems.lineTotal })
      .from(schema.contractItems)
      .where(eq(schema.contractItems.contractId, contractId));
    const mods = await ex
      .select({ price: schema.contractModifiers.price, discountPercent: schema.contractModifiers.discountPercent })
      .from(schema.contractModifiers)
      .where(eq(schema.contractModifiers.contractId, contractId));
    const itemsSum = rows.reduce((s, r) => s + Number(r.lineTotal), 0);
    const modsSum = mods.reduce((s, m) => s + Number(m.price) * (1 - (Number(m.discountPercent) || 0) / 100), 0);
    total = Math.max(0, round2(itemsSum + modsSum));
  }

  await ex.update(schema.contracts).set({ total: String(total) }).where(eq(schema.contracts.id, contractId));
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
async function persistContractModifiers(contractId: number, modifiers: any[] | undefined, ex: Exec = dbExec()) {
  await ex.delete(schema.contractModifiers).where(eq(schema.contractModifiers.contractId, contractId));
  const rows = (modifiers ?? [])
    .filter((m) => m && m.name)
    .map((m) => ({
      contractId,
      name: m.name,
      price: String(Number(m.price) || 0),
      discountPercent: String(Number(m.discountPercent) || 0),
    }));
  if (rows.length > 0) await ex.insert(schema.contractModifiers).values(rows);
}

// ---------------------------------------------------------------------------
// Customer credits applied to a one-time contract or a fatura.
// One row per credit used in `credit_applications` (a record may use several
// credits, each with its own amount). The LEGACY columns contracts/invoices
// .credit_id + .credit_applied are still written (credit_applied = TOTAL of the
// applications, credit_id = the first credit or null) so totals and documents that
// read creditApplied keep working; they will be dropped in a later step.
// READ rule: applications come from credit_applications; only when a record has NO
// rows but legacy credit_id/credit_applied (a database not backfilled yet) is the
// legacy pair read as a single application. Rows win when both exist (no double count).
// Lock order: contract -> invoices -> payments -> credits, credits in ASCENDING id.
// ---------------------------------------------------------------------------
type CreditRow = typeof schema.customerCredits.$inferSelect;
type CreditUse = { creditId: number; amount: number };
// A requested use; amount null = legacy single `creditId` ("as much as possible").
type CreditRequest = { creditId: number; amount: number | null };
type CreditRef = { contractId: number } | { invoiceId: number };

const fmtBrl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const sumUses = (uses: CreditUse[]) => round2(uses.reduce((s, u) => s + u.amount, 0));

// Shape check of `credits: [{ creditId, amount }]` (undefined/null = not sent).
function creditsError(credits: unknown): string | null {
  if (credits === undefined || credits === null) return null;
  if (!Array.isArray(credits) || credits.length > 100) return 'Lista de créditos inválida.';
  const seen = new Set<number>();
  for (const c of credits) {
    if (!c || typeof c !== 'object') return 'Lista de créditos inválida.';
    const id = parseId((c as any).creditId);
    if (id === null) return 'Crédito inválido.';
    const amount = parseMoney((c as any).amount);
    if (amount === null || amount <= 0) return 'Valor de crédito inválido: informe um valor maior que zero.';
    if (seen.has(id)) return 'Crédito repetido na lista.';
    seen.add(id);
  }
  return null;
}

// Requested credits from a body (already validated): the `credits` array, else the legacy
// single `creditId` (amount decided on the server). undefined = the body says nothing.
function parseCreditRequests(body: any): CreditRequest[] | undefined {
  if (Array.isArray(body?.credits)) {
    return body.credits.map((c: any) => ({ creditId: Number(c.creditId), amount: parseMoney(c.amount) as number }));
  }
  const legacy = parseId(body?.creditId);
  if (legacy !== null && (body?.credits === undefined || body?.credits === null)) {
    return [{ creditId: legacy, amount: null }];
  }
  return undefined;
}

// Lock the credit rows (FOR UPDATE) in ASCENDING id order and return them by id.
async function lockCredits(ids: number[], ex: Exec): Promise<Map<number, CreditRow>> {
  const uniq = [...new Set(ids)].sort((a, b) => a - b);
  if (uniq.length === 0) return new Map();
  const rows = await ex
    .select()
    .from(schema.customerCredits)
    .where(inArray(schema.customerCredits.id, uniq))
    .orderBy(schema.customerCredits.id)
    .for('update');
  return new Map(rows.map((r) => [r.id, r]));
}

// Credits applied to a record: its credit_applications rows, or (no rows) the legacy
// single credit_id/credit_applied pair.
async function readAppliedCredits(
  ref: CreditRef,
  legacy: { creditId: number | null; creditApplied: string | null },
  ex: Exec = dbExec()
): Promise<CreditUse[]> {
  const cond =
    'contractId' in ref
      ? eq(schema.creditApplications.contractId, ref.contractId)
      : eq(schema.creditApplications.invoiceId, ref.invoiceId);
  const rows = await ex.select().from(schema.creditApplications).where(cond).orderBy(schema.creditApplications.id);
  if (rows.length > 0) return rows.map((r) => ({ creditId: r.creditId, amount: Number(r.amount) }));
  const applied = Number(legacy.creditApplied ?? 0);
  return legacy.creditId && applied > 0 ? [{ creditId: legacy.creditId, amount: applied }] : [];
}

// Applied credits with their descriptions, as exposed to the client and the documents.
async function describeCredits(uses: CreditUse[], ex: Exec = dbExec()) {
  if (uses.length === 0) return [];
  const rows = await ex
    .select({ id: schema.customerCredits.id, description: schema.customerCredits.description })
    .from(schema.customerCredits)
    .where(inArray(schema.customerCredits.id, [...new Set(uses.map((u) => u.creditId))]));
  const byId = new Map(rows.map((r) => [r.id, r.description]));
  return uses.map((u) => ({ creditId: u.creditId, description: byId.get(u.creditId) ?? '', amount: u.amount }));
}

// Spend the requested credits (validates ownership, balance and the total cap), reducing
// each credit's remaining balance; returns what was applied. Must run in a transaction.
// `total` is the amount to be covered (contract/fatura total after discounts/modifiers).
async function applyCreditRequests(
  requests: CreditRequest[],
  customerId: number | null,
  total: number,
  overMessage: string,
  ex: Exec
): Promise<CreditUse[]> {
  if (requests.length === 0) return [];
  if (!customerId) throw new HttpError(400, 'Crédito não encontrado.');
  const locked = await lockCredits(requests.map((r) => r.creditId), ex);
  const uses: CreditUse[] = [];
  let left = total;
  for (const r of [...requests].sort((a, b) => a.creditId - b.creditId)) {
    const credit = locked.get(r.creditId);
    if (!credit || credit.customerId !== customerId) throw new HttpError(400, 'Crédito não encontrado.');
    const remaining = Number(credit.remaining);
    let amount: number;
    if (r.amount === null) {
      amount = round2(Math.min(remaining, left)); // legacy single creditId
      if (amount <= 0) continue;
    } else {
      amount = round2(r.amount);
      if (amount <= 0) throw new HttpError(400, 'Valor de crédito inválido: informe um valor maior que zero.');
      if (amount > remaining + 0.004) {
        throw new HttpError(400, `Saldo insuficiente no crédito "${credit.description}" (disponível ${fmtBrl(remaining)}).`);
      }
    }
    left = round2(left - amount);
    if (left < -0.004) throw new HttpError(400, overMessage);
    await ex
      .update(schema.customerCredits)
      .set({ remaining: String(round2(Math.max(0, remaining - amount))) })
      .where(eq(schema.customerCredits.id, credit.id));
    uses.push({ creditId: credit.id, amount });
  }
  return uses;
}

// Give applied credits back (contract/fatura edit or delete): each amount returns to its
// credit's remaining balance (never above the credit's value). Several uses of one credit
// are summed; credits are locked in ascending id order.
async function reinstateCredits(uses: CreditUse[], ex: Exec = dbExec()) {
  const byCredit = new Map<number, number>();
  for (const u of uses) if (u.amount > 0) byCredit.set(u.creditId, round2((byCredit.get(u.creditId) ?? 0) + u.amount));
  if (byCredit.size === 0) return;
  const locked = await lockCredits([...byCredit.keys()], ex);
  for (const [creditId, amount] of [...byCredit.entries()].sort((a, b) => a[0] - b[0])) {
    const credit = locked.get(creditId);
    if (!credit) continue;
    const back = round2(Math.min(Number(credit.value), Number(credit.remaining) + amount));
    await ex.update(schema.customerCredits).set({ remaining: String(back) }).where(eq(schema.customerCredits.id, creditId));
  }
}

// Replace a record's credit_applications rows and keep the legacy columns in sync
// (credit_applied = total, credit_id = first credit or null). Returns the total applied.
async function writeCreditApplications(ref: CreditRef, uses: CreditUse[], ex: Exec): Promise<number> {
  const total = sumUses(uses);
  const legacy = { creditId: uses[0]?.creditId ?? null, creditApplied: String(total) };
  if ('contractId' in ref) {
    await ex.delete(schema.creditApplications).where(eq(schema.creditApplications.contractId, ref.contractId));
    if (uses.length > 0) {
      await ex
        .insert(schema.creditApplications)
        .values(uses.map((u) => ({ creditId: u.creditId, contractId: ref.contractId, amount: String(u.amount) })));
    }
    await ex.update(schema.contracts).set(legacy).where(eq(schema.contracts.id, ref.contractId));
  } else {
    await ex.delete(schema.creditApplications).where(eq(schema.creditApplications.invoiceId, ref.invoiceId));
    if (uses.length > 0) {
      await ex
        .insert(schema.creditApplications)
        .values(uses.map((u) => ({ creditId: u.creditId, invoiceId: ref.invoiceId, amount: String(u.amount) })));
    }
    await ex.update(schema.invoices).set(legacy).where(eq(schema.invoices.id, ref.invoiceId));
  }
  return total;
}

type InvoiceBody = {
  reference?: string | null;
  comments?: string | null;
  discountPercent?: number | string;
  installments?: number | string;
  dueDates?: string[];
  modifiers?: any[];
  // Credits to spend (already parsed by the route; legacy single creditId arrives as amount null).
  credits?: CreditRequest[];
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
  bankSurplus = true,
  ex: Exec = dbExec(),
  minInstallment?: number
) {
  const { reference, comments, discountPercent, installments, dueDates, modifiers, credits, creditDescription } = body;

  const subtotal = billable.reduce((s, it) => s + Number(it.lineTotal), 0);
  const modsSum = (modifiers ?? [])
    .filter((m: any) => m && m.name)
    .reduce((s: number, m: any) => s + (Number(m.price) || 0) * (1 - (Number(m.discountPercent) || 0) / 100), 0);
  // The raw total may be negative (e.g. negative modifiers); the invoice is
  // clamped to 0 and the surplus becomes a customer credit (below).
  const rawTotal = round2(withDisc(subtotal, discountPercent) + modsSum);
  const total = Math.max(0, rawTotal);
  // Credits are applied BEFORE the installments are split (base = total - credits).
  const uses = await applyCreditRequests(
    credits ?? [],
    customerId,
    total,
    'O total dos créditos excede o valor da fatura.',
    ex
  );
  const creditApplied = sumUses(uses);
  const base = Math.max(0, round2(total - creditApplied));
  const count = base > 0 ? Math.min(Math.max(1, Number(installments) || 1), await maxInstallmentsFor(base, minInstallment)) : 0;

  await ex
    .update(schema.invoices)
    .set({
      reference: reference ?? null,
      comments: comments ?? null,
      discountPercent: String(discountPercent ?? 0),
      installments: count,
      total: String(total),
    })
    .where(eq(schema.invoices.id, invoiceId));
  // Applications + legacy credit_id/credit_applied (kept in sync).
  await writeCreditApplications({ invoiceId }, uses, ex);

  const modRows = (modifiers ?? [])
    .filter((m: any) => m && m.name)
    .map((m: any) => ({
      invoiceId,
      name: m.name,
      price: String(Number(m.price) || 0),
      discountPercent: String(Number(m.discountPercent) || 0),
    }));
  if (modRows.length > 0) await ex.insert(schema.invoiceModifiers).values(modRows);

  if (billable.length > 0) {
    await ex
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
    }, ex);
  }

  if (bankSurplus && rawTotal < 0 && customerId) {
    const surplus = round2(-rawTotal);
    const desc =
      (typeof creditDescription === 'string' && creditDescription.trim()) ||
      `Crédito da fatura${reference ? ` ${reference}` : ''}`;
    await ex.insert(schema.customerCredits).values({
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

  const documents = (
    await db
      .select()
      .from(schema.contractDocuments)
      .where(eq(schema.contractDocuments.contractId, id))
      .orderBy(desc(schema.contractDocuments.generatedAt))
  ).map(publicDocument);

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
    const invCredits = await describeCredits(await readAppliedCredits({ invoiceId: inv.id }, inv));
    invoices.push({ ...inv, documents: invDocs, payments: invPays, modifiers: invMods, credits: invCredits });
  }

  // Credits applied to the one-time contract: [{ creditId, description, amount }]
  // (creditApplied stays the TOTAL, kept in sync with the applications).
  const credits = await describeCredits(await readAppliedCredits({ contractId: id }, contract));

  return { ...contract, customer, items: itemsFull, documents, invoices, payments, modifiers, credits };
}

// Persist several items (one-time contract scope).
async function persistItems(contractId: number, built: SnapshotRow[], ex: Exec = dbExec()) {
  for (const r of built) await persistOneItem(contractId, r, undefined, ex);
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
    if (!full) return reply.code(404).send({ error: 'Registro não encontrado.' });
    return full;
  });

  // Advance/revert the one-time contract workflow by exactly one step.
  app.put('/api/contracts/:id/status', async (req: any, reply) => {
    const id = Number(req.params.id);
    const { status } = req.body ?? {};
    const [c] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, id));
    if (!c) return reply.code(404).send({ error: 'Registro não encontrado.' });
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
    const bodyError = contractBodyError(req.body);
    if (bodyError) return badRequest(reply, bodyError);
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
    const isOneTime = (type ?? 'contract') !== 'invoice';
    // Credits to spend ([{creditId, amount}] or the legacy single creditId); validated
    // against the customer/balances inside the transaction (400 'Crédito não encontrado.').
    const creditRequests = isOneTime ? parseCreditRequests(req.body) ?? [] : [];
    const { rows, total: itemsSum } = await buildItems(isOneTime ? items ?? [] : []);
    if (isOneTime && Array.isArray(items) && rows.length < items.length) {
      return badRequest(reply, 'Serviço não encontrado.');
    }
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
    const minInst = await getMinInstallmentValue(); // read before the transaction
    const count = isOneTime
      ? Math.min(Math.max(1, Number(installments) || 1), await maxInstallmentsFor(baseFinal, minInst))
      : 1;

    // Everything is written in ONE transaction (contract, items, modifiers, credit
    // use, installments). The number is allocated inside it; if another machine took
    // the same number first, the unique index rejects it and we retry with the next.
    let contractId: number;
    try {
    contractId = await withMutex('contract-number', () => withNumberRetry(() =>
      db.transaction(async (tx) => {
        const number = await nextContractNumber(isOneTime ? 'contract' : 'invoice', tx);
        const res: any = await tx
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
            executionDate: executionDate || null,
            executionTime: executionTime ?? null,
            executionAddress: executionAddress ?? null,
            duration: isOneTime ? duration ?? null : null,
            quantity: isOneTime ? (quantity != null && quantity !== '' ? Number(quantity) : null) : null,
            total: '0',
          })
          .$returningId();
        const newId: number = res[0].id;

        await persistItems(newId, rows, tx);
        if (isOneTime) await persistContractModifiers(newId, modifiers, tx);
        const total = await recomputeContractTotal(newId, tx);

        // Apply prepaid credits (one amount per credit): they reduce the amount split
        // into installments.
        const uses = isOneTime
          ? await applyCreditRequests(
              creditRequests,
              customerId ?? null,
              total,
              'O total dos créditos excede o valor do contrato.',
              tx
            )
          : [];
        const creditApplied = sumUses(uses);
        const base = Math.max(0, round2(total - creditApplied));
        const finalCount = base > 0 ? Math.min(Math.max(1, Number(installments) || 1), await maxInstallmentsFor(base, minInst)) : 0;

        if (isOneTime) {
          await tx
            .update(schema.contracts)
            .set({ installments: finalCount })
            .where(eq(schema.contracts.id, newId));
          if (uses.length > 0) await writeCreditApplications({ contractId: newId }, uses, tx);
          // Generate installment payments only for the amount still owed after credit.
          if (base > 0) {
            await createInstallmentPayments(
              {
                contractId: newId,
                customerId: customerId ?? null,
                label: '',
                total: base,
                count: finalCount,
                dueDates,
              },
              tx
            );
          }
        }
        return newId;
      })
    ));
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }

    reply.code(201);
    return loadFullContract(contractId);
  });

  // Edit a contract; items are fully rebuilt from the payload. Each item names
  // an explicit serviceVersionId, so keeping the original version reproduces the
  // exact original price (versions are immutable) while the user may also switch
  // an item to a different version on purpose.
  // Body: { customerId?, type?, title?, comments?, items:[{serviceVersionId, modifierIds:[]}] }
  //
  // Once any payment of the contract was received/paid, money edits (items,
  // modifiers, installments, due dates) are refused with 409; header-only edits
  // (comments, execution data, templates, customer, title...) stay allowed.
  app.put('/api/contracts/:id', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(reply, 'Identificador inválido.');
    const [existing] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, id));
    if (!existing) return reply.code(404).send({ error: 'Registro não encontrado.' });
    const bodyError = contractBodyError(req.body);
    if (bodyError) return badRequest(reply, bodyError);

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

    // `credits` (full list, possibly empty) REPLACES the applied credits; omitted = keep them.
    const creditRequests = Array.isArray(req.body?.credits) ? parseCreditRequests(req.body) ?? [] : undefined;
    const isMoneyEdit =
      creditRequests !== undefined ||
      Array.isArray(items) ||
      (installments !== undefined && installments !== null && installments !== '') ||
      Array.isArray(dueDates);
    const minInst = await getMinInstallmentValue(); // read before the transaction

    // Snapshot the new items before opening the transaction (catalog reads only).
    const built = Array.isArray(items) ? await buildItems(items) : null;

    try {
      await withNumberRetry(() => db.transaction(async (tx) => {
        // Lock the contract row first, then check received payments, so a payment
        // received meanwhile cannot slip between the check and the rebuild.
        const [locked] = await tx.select().from(schema.contracts).where(eq(schema.contracts.id, id)).for('update');
        if (!locked) throw new HttpError(404, 'Registro não encontrado.');
        // A real type change is also blocked once money came in (a no-op type is ignored).
        const isTypeChange = type !== undefined && type !== locked.type;
        if (isMoneyEdit || isTypeChange) {
          const invs = await tx
            .select({ id: schema.invoices.id })
            .from(schema.invoices)
            .where(eq(schema.invoices.contractId, id));
          const settled = await countSettledPayments({ contractId: id, invoiceIds: invs.map((i) => i.id) }, tx);
          if (settled > 0) {
            throw new HttpError(
              409,
              isMoneyEdit
                ? 'Não é possível alterar valores ou parcelas: já há pagamento(s) recebido(s) neste contrato.'
                : 'Não é possível alterar o tipo do contrato: já há pagamento(s) recebido(s) neste contrato.'
            );
          }
        }

        // Full contract edit (one-time): rebuild items + modifiers; title = service name.
        // Header-only edit (items omitted) leaves line items untouched.
        let newTitle: string | null | undefined;
        if (built) {
          await tx.delete(schema.contractItems).where(eq(schema.contractItems.contractId, id));
          await persistItems(id, built.rows, tx);
          newTitle = built.rows[0]?.serviceName ?? null;
          if (modifiers !== undefined) await persistContractModifiers(id, modifiers, tx);
        } else if (title !== undefined) {
          newTitle = title;
        }

        // Header fields actually sent; drizzle rejects an empty .set(), so skip the UPDATE when none.
        const headerSet = {
            ...(customerId !== undefined ? { customerId } : {}),
            ...(type !== undefined ? { type } : {}),
            ...(newTitle !== undefined ? { title: newTitle } : {}),
            ...(comments !== undefined ? { comments } : {}),
            ...(templateId !== undefined ? { templateId: templateId ?? null } : {}),
            ...(invoiceTemplateId !== undefined ? { invoiceTemplateId: invoiceTemplateId ?? null } : {}),
            ...(receiptTemplateId !== undefined ? { receiptTemplateId: receiptTemplateId ?? null } : {}),
            ...(executionDate !== undefined ? { executionDate: executionDate || null } : {}),
            ...(executionTime !== undefined ? { executionTime: executionTime ?? null } : {}),
            ...(executionAddress !== undefined ? { executionAddress: executionAddress ?? null } : {}),
            ...(duration !== undefined ? { duration: duration ?? null } : {}),
            ...(quantity !== undefined
              ? { quantity: quantity != null && quantity !== '' ? Number(quantity) : null }
              : {}),
          };
        if (Object.keys(headerSet).length > 0) {
          await tx.update(schema.contracts).set(headerSet).where(eq(schema.contracts.id, id));
        }

        const total = await recomputeContractTotal(id, tx);

        // Credits: a `credits` list replaces the applications (reinstate the old ones, apply
        // the new ones, both under credit row locks taken in ascending id order); otherwise
        // the stored credits stay applied. Installments are split on the NET total.
        const tooSmall = 'O valor do contrato ficou menor que o crédito aplicado.';
        const current = await readAppliedCredits({ contractId: id }, locked, tx);
        let creditApplied = sumUses(current);
        // Recurring contracts hold no credit themselves (their faturas do): ignore the list.
        const isRecurringNow = (type ?? locked.type) === 'invoice';
        const wanted = isRecurringNow ? undefined : creditRequests;
        if (isRecurringNow && current.length > 0) {
          // Type changed from one-time to recurring: credits only apply to one-time contracts.
          await lockCredits(current.map((u) => u.creditId), tx);
          await reinstateCredits(current, tx);
          creditApplied = await writeCreditApplications({ contractId: id }, [], tx);
        } else if (wanted !== undefined) {
          await lockCredits([...current.map((u) => u.creditId), ...wanted.map((r) => r.creditId)], tx);
          await reinstateCredits(current, tx);
          const uses = await applyCreditRequests(
            wanted,
            (customerId !== undefined ? customerId : locked.customerId) ?? null,
            total,
            'O total dos créditos excede o valor do contrato.',
            tx
          );
          creditApplied = await writeCreditApplications({ contractId: id }, uses, tx);
        } else if (isMoneyEdit && creditApplied > 0 && total < creditApplied) {
          throw new HttpError(400, tooSmall);
        }
        const base = Math.max(0, round2(total - creditApplied));

        // Resolve + store the installment count against the new net total.
        let count: number | undefined;
        if (isMoneyEdit) {
          count =
            base > 0
              ? Math.min(
                  Math.max(1, Number(installments ?? locked.installments) || 1),
                  await maxInstallmentsFor(base, minInst)
                )
              : 0;
          await tx.update(schema.contracts).set({ installments: count }).where(eq(schema.contracts.id, id));
        }

        // Regenerate the contract-level installment payments on every money edit, so the
        // stored count and the rows always agree (missing due dates stay empty). Only
        // installment rows are replaced: extra payments (no installment number) are never
        // touched. Recurring contracts have no contract-level installments.
        if (isMoneyEdit && (type ?? locked.type) !== 'invoice') {
          await tx
            .delete(schema.payments)
            .where(
              and(
                eq(schema.payments.contractId, id),
                isNull(schema.payments.invoiceId),
                isNotNull(schema.payments.installmentNumber)
              )
            );
          if (base > 0) {
            await createInstallmentPayments(
              {
                contractId: id,
                customerId: customerId ?? locked.customerId,
                label: '',
                total: base,
                count: count ?? 1,
                dueDates,
              },
              tx
            );
          }
        }
      }));
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }

    return loadFullContract(id);
  });

  // Delete a contract. Blocked while any of its payments (direct or via its
  // invoices) was already received/paid. Otherwise the customer credit it consumed
  // (the contract's own and each invoice's) is reinstated, its payments, invoices
  // and documents go with it (cascade) and the generated files are removed.
  app.delete('/api/contracts/:id', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(reply, 'Identificador inválido.');
    let fileNames: string[] = [];
    try {
      await withNumberRetry(() => db.transaction(async (tx) => {
        const [contract] = await tx.select().from(schema.contracts).where(eq(schema.contracts.id, id)).for('update');
        if (!contract) throw new HttpError(404, 'Registro não encontrado.');
        const invoices = await tx.select().from(schema.invoices).where(eq(schema.invoices.contractId, id));

        if ((await countSettledPayments({ contractId: id, invoiceIds: invoices.map((i) => i.id) }, tx)) > 0) {
          throw new HttpError(409, 'Não é possível excluir: já há pagamento(s) recebido(s)/pago(s) neste contrato.');
        }

        // Reinstate the credit consumed: the contract's own (one-time) and each
        // invoice's (recurring). They are disjoint, so nothing is counted twice.
        // Credits are locked in ascending id order (same order everywhere: no deadlocks).
        // Every application (rows, or the legacy pair when a record has no rows) goes back to
        // its credit exactly once; reinstateCredits sums per credit and locks ascending.
        const toReinstate: CreditUse[] = await readAppliedCredits({ contractId: id }, contract, tx);
        for (const inv of invoices) toReinstate.push(...(await readAppliedCredits({ invoiceId: inv.id }, inv, tx)));
        await reinstateCredits(toReinstate, tx);

        const docs = await tx
          .select({ fileName: schema.contractDocuments.fileName })
          .from(schema.contractDocuments)
          .where(eq(schema.contractDocuments.contractId, id));
        fileNames = docs.map((d) => d.fileName);

        await tx.delete(schema.contracts).where(eq(schema.contracts.id, id)); // cascades items, invoices, payments, documents
      }));
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }

    // After commit: remove the generated files (only inside the contracts folder).
    for (const name of fileNames) {
      const file = documentPath(name);
      if (file && fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          /* ignore filesystem errors; the records are already gone */
        }
      }
    }
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
    if (!contract) return reply.code(404).send({ error: 'Contrato não encontrado.' });

    const { serviceVersionId, additionals, description, performedAt, quantity, discountPercent, items } = req.body ?? {};
    if (parseId(serviceVersionId) === null) return badRequest(reply, 'Serviço inválido.');
    if (optionalDate(performedAt) === false) return badRequest(reply, 'Data inválida (data de realização).');

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
        if (!row) return reply.code(400).send({ error: 'Serviço inválido.' });
        await persistOneItem(contractId, row, {
          description: entry?.description ?? null,
          performedAt: performedAt || null,
          invoiceId: null,
        });
      }
      await recomputeContractTotal(contractId);
      reply.code(201);
      return loadFullContract(contractId);
    }

    // Single item (legacy).
    const row = await snapshotOne({ serviceVersionId: Number(serviceVersionId), quantity, discountPercent, additionals });
    if (!row) return reply.code(400).send({ error: 'Serviço inválido.' });

    await persistOneItem(contractId, row, {
      description: description ?? null,
      performedAt: performedAt || null,
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
    if (!item || item.contractId !== contractId) return reply.code(404).send({ error: 'Item não encontrado.' });
    if (item.invoiceId) return reply.code(409).send({ error: 'item já faturado; não pode ser editado' });

    const { serviceVersionId, additionals, description, performedAt, discountPercent } = req.body ?? {};
    if (serviceVersionId != null && parseId(serviceVersionId) === null) return badRequest(reply, 'Serviço inválido.');
    if (optionalDate(performedAt) === false) return badRequest(reply, 'Data inválida (data de realização).');
    const row = await snapshotOne({
      serviceVersionId: Number(serviceVersionId ?? item.serviceVersionId),
      quantity: item.quantity, // single-unit model: quantity is not changed here
      discountPercent: discountPercent ?? item.discountPercent,
      additionals,
    });
    if (!row) return reply.code(400).send({ error: 'Serviço inválido.' });

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
        performedAt: performedAt || null,
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
    if (!item) return reply.code(404).send({ error: 'Item não encontrado.' });
    if (item.invoiceId) return reply.code(409).send({ error: 'item já faturado; exclua a fatura primeiro' });
    await db.delete(schema.contractItems).where(eq(schema.contractItems.id, itemId));
    await recomputeContractTotal(contractId);
    return loadFullContract(contractId);
  });

  // Create an invoice from selected (unbilled) performed services.
  // Body: { reference?, comments?, itemIds: number[], modifiers?: [{name,price,discountPercent}] }
  app.post('/api/contracts/:id/invoices', async (req: any, reply) => {
    const contractId = parseId(req.params.id);
    if (contractId === null) return badRequest(reply, 'Identificador inválido.');
    const { itemIds } = req.body ?? {};
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return reply.code(400).send({ error: 'selecione ao menos um serviço' });
    }
    const invError = invoiceBodyError(req.body);
    if (invError) return badRequest(reply, invError);

    const [contract] = await db.select().from(schema.contracts).where(eq(schema.contracts.id, contractId));
    if (!contract) return reply.code(404).send({ error: 'Contrato não encontrado.' });

    const minInst = await getMinInstallmentValue(); // read before the transaction
    const creditRequests = parseCreditRequests(req.body) ?? [];
    try {
      // The in-process mutex serializes reference allocation on this server; the
      // contract row lock (same order as invoice edit/delete: contract, payments,
      // credits) serializes invoices on one contract; the unique index + retry
      // arbitrate between machines.
      await withMutex('invoice-ref', () =>
        withNumberRetry(() =>
          db.transaction(async (tx) => {
            const [locked] = await tx
              .select()
              .from(schema.contracts)
              .where(eq(schema.contracts.id, contractId))
              .for('update');
            if (!locked) throw new HttpError(404, 'Contrato não encontrado.');

            // Only bill items that belong to this contract and are still unbilled
            // (re-read under the lock).
            const items = await tx
              .select()
              .from(schema.contractItems)
              .where(inArray(schema.contractItems.id, itemIds.map((n: any) => Number(n))));
            const billable = items.filter((it) => it.contractId === contractId && !it.invoiceId);
            if (billable.length === 0) throw new HttpError(400, 'nenhum item válido para faturar');

            const invRes: any = await tx
              .insert(schema.invoices)
              .values({
                contractId,
                refNumber: await nextInvoiceRefNumber(tx),
                discountPercent: '0',
                installments: 0,
                total: '0',
              })
              .$returningId();
            const invoiceId = invRes[0].id;

            await composeInvoice(
              invoiceId,
              contractId,
              locked.customerId,
              { ...req.body, credits: creditRequests },
              billable,
              true,
              tx,
              minInst
            );
            await recomputeContractTotal(contractId, tx);
          })
        )
      );
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
    reply.code(201);
    return loadFullContract(contractId);
  });

  // Edit a generated invoice: change reference/comments/discount/modifiers/items/
  // credit and re-plan installments. Items removed from the invoice are unbilled
  // (returned to the open list); the previously applied credit is reinstated and
  // recomputed. Blocked once any installment has been received.
  app.put('/api/invoices/:id', async (req: any, reply) => {
    const invoiceId = parseId(req.params.id);
    if (invoiceId === null) return badRequest(reply, 'Identificador inválido.');
    const { itemIds } = req.body ?? {};
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!inv) return reply.code(404).send({ error: 'Registro não encontrado.' });
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return reply.code(400).send({ error: 'selecione ao menos um serviço' });
    }
    const invError = invoiceBodyError(req.body);
    if (invError) return badRequest(reply, invError);
    const minInst = await getMinInstallmentValue(); // read before the transaction
    const creditRequests = parseCreditRequests(req.body) ?? []; // full list: replaces the old credits
    try {
      await withNumberRetry(() =>
        db.transaction(async (tx) => {
          // Lock order everywhere: contract row, then payments, then credits. Re-reading
          // everything under the contract lock makes a concurrent contract delete or
          // invoice edit wait (so a credit can't be reinstated twice).
          const [contract] = await tx
            .select()
            .from(schema.contracts)
            .where(eq(schema.contracts.id, inv.contractId))
            .for('update');
          if (!contract) throw new HttpError(404, 'Contrato não encontrado.');
          const [cur] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
          if (!cur) throw new HttpError(404, 'Registro não encontrado.');

          // Cannot edit once money has come in: any installment already received/sent.
          if ((await countSettledPayments({ invoiceIds: [invoiceId] }, tx)) > 0) {
            throw new HttpError(409, 'fatura com parcela já recebida não pode ser editada');
          }

          // Candidate items: belong to this contract AND are either unbilled or already
          // on THIS invoice (validate before mutating anything).
          const chosen = await tx
            .select()
            .from(schema.contractItems)
            .where(inArray(schema.contractItems.id, itemIds.map((n: any) => Number(n))));
          const billable = chosen.filter(
            (it) => it.contractId === cur.contractId && (!it.invoiceId || it.invoiceId === invoiceId)
          );
          if (billable.length === 0) throw new HttpError(400, 'nenhum item válido para faturar');

          // Undo the old composition: reinstate applied credit, unbill its items, drop
          // its payments/modifiers/generated documents (all stale after an edit).
          // (the new credits are applied by composeInvoice; every credit involved is locked
          // up front, in ascending id order)
          const oldCredits = await readAppliedCredits({ invoiceId }, cur, tx);
          await lockCredits(
            [...oldCredits.map((u) => u.creditId), ...(creditRequests ?? []).map((r) => r.creditId)],
            tx
          );
          await reinstateCredits(oldCredits, tx);
          await tx
            .update(schema.contractItems)
            .set({ invoiceId: null })
            .where(eq(schema.contractItems.invoiceId, invoiceId));
          await tx.delete(schema.payments).where(eq(schema.payments.invoiceId, invoiceId));
          await tx.delete(schema.invoiceModifiers).where(eq(schema.invoiceModifiers.invoiceId, invoiceId));
          await tx.delete(schema.contractDocuments).where(eq(schema.contractDocuments.invoiceId, invoiceId));

          await composeInvoice(
            invoiceId,
            cur.contractId,
            contract.customerId,
            { ...req.body, credits: creditRequests },
            billable,
            false,
            tx,
            minInst
          );
          await recomputeContractTotal(cur.contractId, tx);
        })
      );
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
    reply.code(200);
    return loadFullContract(inv.contractId);
  });

  // Delete an invoice: reinstate any applied credit, unbill its items, remove its
  // documents + payments (cascade) + the invoice.
  app.delete('/api/invoices/:id', async (req: any, reply) => {
    const invoiceId = parseId(req.params.id);
    if (invoiceId === null) return badRequest(reply, 'Identificador inválido.');
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!inv) return reply.code(404).send({ error: 'Registro não encontrado.' });
    try {
      await withNumberRetry(() =>
        db.transaction(async (tx) => {
          // Same lock order as contract delete / invoice edit: contract row first, then
          // re-read the invoice (it may have been deleted/edited meanwhile).
          await tx.select().from(schema.contracts).where(eq(schema.contracts.id, inv.contractId)).for('update');
          const [cur] = await tx.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
          if (!cur) return; // already gone: nothing to reinstate twice
          if ((await countSettledPayments({ invoiceIds: [invoiceId] }, tx)) > 0) {
            throw new HttpError(
              409,
              'Não é possível excluir: já há pagamento(s) recebido(s) nesta fatura. Para cancelar uma fatura com pagamentos recebidos será necessário o processo de rescisão (ainda não implementado).'
            );
          }
          await reinstateCredits(await readAppliedCredits({ invoiceId }, cur, tx), tx);
          await tx
            .update(schema.contractItems)
            .set({ invoiceId: null })
            .where(eq(schema.contractItems.invoiceId, invoiceId));
          await tx.delete(schema.invoices).where(eq(schema.invoices.id, invoiceId)); // cascades documents + payments
          await recomputeContractTotal(cur.contractId, tx);
        })
      );
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.status).send({ error: e.message });
      throw e;
    }
    return reply.code(204).send();
  });

  // Generate an invoice .docx listing the billed services WITH their descriptions.
  app.post('/api/invoices/:id/generate', async (req: any, reply) => {
    const invoiceId = Number(req.params.id);
    const [inv] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, invoiceId));
    if (!inv) return reply.code(404).send({ error: 'Fatura não encontrada.' });
    const full = await loadFullContract(inv.contractId);
    if (!full) return reply.code(404).send({ error: 'Contrato não encontrado.' });

    const c = full.customer;
    const now = new Date();
    const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const invItems = full.items.filter((it) => it.invoiceId === invoiceId);
    const invCredits = full.invoices.find((i) => i.id === invoiceId)?.credits ?? [];

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
      // {credit_description}: the descriptions of all credits used, joined with ', '.
      credit_description: invCredits.map((cr) => cr.description).join(', '),
      total_after_credit: brl(Number(inv.total) - Number(inv.creditApplied ?? 0)),
      // One row per credit used: {#credits}{credit_description} {credit_amount}{/credits}
      // ({credit_amount} is POSITIVE, unlike the negative {credit_applied} total).
      credits: invCredits.map((cr) => ({ credit_description: cr.description, credit_amount: brl(cr.amount) })),
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

    // File name: fatura_{apelido}_{referência}. `||` (not `??`) so an empty reference
    // falls back to the sequential number, then the id. If ANOTHER invoice already owns
    // that file name (same customer + same reference), the invoice's own number is
    // appended so one fatura never overwrites another's file.
    const nick = sanitize(c?.nickname || c?.name || 'cliente') || 'cliente';
    const refPart = sanitize(inv.reference || '') || sanitize(inv.refNumber || '') || String(invoiceId);
    let baseName = `fatura_${nick}_${refPart}`;
    const taken = await db
      .select({ id: schema.contractDocuments.id })
      .from(schema.contractDocuments)
      .where(
        and(
          inArray(schema.contractDocuments.fileName, [`${sanitize(baseName)}.docx`, `${sanitize(baseName)}.odt`]),
          ne(schema.contractDocuments.invoiceId, invoiceId)
        )
      )
      .limit(1);
    if (taken.length > 0) {
      baseName += `_${sanitize(inv.refNumber || '') || invoiceId}`;
    }
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
    return publicDocument(record);
  });

  // Generate a document (.docx or .odt, following the chosen model) from the contract. Body: { comments? } (extra popup note).
  app.post('/api/contracts/:id/generate', async (req: any, reply) => {
    const id = Number(req.params.id);
    const full = await loadFullContract(id);
    if (!full) return reply.code(404).send({ error: 'Contrato não encontrado.' });

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
      // {credit_description}: the descriptions of all credits used, joined with ', '.
      credit_description: full.credits.map((cr) => cr.description).join(', '),
      total_after_credit: brl(Number(full.total) - Number(full.creditApplied ?? 0)),
      // One row per credit used: {#credits}{credit_description} {credit_amount}{/credits}
      // ({credit_amount} is POSITIVE, unlike the negative {credit_applied} total).
      credits: full.credits.map((cr) => ({ credit_description: cr.description, credit_amount: brl(cr.amount) })),
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
    const nick = sanitize(c?.nickname || c?.name || 'cliente') || 'cliente';
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
    return publicDocument(record);
  });

  // Download a generated document.
  app.get('/api/contract-documents/:id/download', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(reply, 'Identificador inválido.');
    const [row] = await db
      .select()
      .from(schema.contractDocuments)
      .where(eq(schema.contractDocuments.id, id));
    if (!row) return reply.code(404).send({ error: 'Documento não encontrado.' });
    const file = documentPath(row.fileName);
    if (!file) return badRequest(reply, 'Nome de arquivo do documento inválido.');
    if (!fs.existsSync(file)) {
      return reply.code(410).send({ error: 'O arquivo não está mais neste computador. Gere o documento novamente.' });
    }
    reply.header('Content-Disposition', contentDisposition(row.fileName));
    reply.type(docMime(formatOfFileName(row.fileName)));
    return reply.send(fs.createReadStream(file));
  });

  // Download the same document converted to PDF — generated on the fly from the
  // stored .docx/.odt and never saved in the project folder.
  app.get('/api/contract-documents/:id/pdf', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(reply, 'Identificador inválido.');
    const [row] = await db
      .select()
      .from(schema.contractDocuments)
      .where(eq(schema.contractDocuments.id, id));
    if (!row) return reply.code(404).send({ error: 'Documento não encontrado.' });
    const file = documentPath(row.fileName);
    if (!file) return badRequest(reply, 'Nome de arquivo do documento inválido.');
    if (!fs.existsSync(file)) {
      return reply.code(410).send({ error: 'O arquivo não está mais neste computador. Gere o documento novamente.' });
    }
    let pdf: Buffer;
    try {
      const doc = await fs.promises.readFile(file);
      pdf = await officeToPdf(doc, formatOfFileName(row.fileName));
    } catch (err: any) {
      return reply.code(500).send({ error: err.message });
    }
    const pdfName = row.fileName.replace(/\.(docx|odt)$/i, '') + '.pdf';
    reply.header('Content-Disposition', contentDisposition(pdfName));
    reply.type('application/pdf');
    return reply.send(pdf);
  });

  // Delete a generated document — removes the DB record AND the file on disk.
  app.delete('/api/contract-documents/:id', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badRequest(reply, 'Identificador inválido.');
    const [row] = await db
      .select()
      .from(schema.contractDocuments)
      .where(eq(schema.contractDocuments.id, id));
    if (!row) return reply.code(204).send();
    // Only ever delete the file inside the contracts folder. A record whose name
    // resolves elsewhere is removed without touching the disk.
    const file = documentPath(row.fileName);
    if (file && fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore filesystem errors; still remove the record */
      }
    }
    await db.delete(schema.contractDocuments).where(eq(schema.contractDocuments.id, id));
    return reply.code(204).send();
  });
}
