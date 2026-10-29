import type { FastifyInstance } from 'fastify';
import { and, eq, gte, lte, desc, or, inArray, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { parseOfx } from '../lib/ofx.js';
import { todayIso } from '../lib/dates.js';
import { FLOWS, badRequest, isOneOf, optionalId, parseIsoDateStrict, parseMoney } from '../lib/validate.js';

// ---- text helpers for memo -> customer matching ----
function normalize(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A name token "hits" a memo word on an exact match or a shared prefix — bank
// memos routinely truncate the last name (e.g. "ANGELICA VIEIR" for "Vieira").
function tokenHit(word: string, token: string): boolean {
  if (word === token) return true;
  return (
    token.length >= 4 &&
    word.length >= 4 &&
    (word.startsWith(token) || token.startsWith(word))
  );
}

// True when the memo text contains the customer's name/nickname (a couple of
// significant tokens is enough — bank memos often truncate the last name).
function nameInMemo(memo: string, name?: string | null, nickname?: string | null): boolean {
  const words = normalize(memo).split(' ').filter(Boolean);
  for (const nm of [name, nickname]) {
    if (!nm) continue;
    const toks = normalize(nm).split(' ').filter((t) => t.length >= 3);
    if (toks.length === 0) continue;
    const hits = toks.filter((t) => words.some((w) => tokenHit(w, t))).length;
    if (hits >= Math.min(2, toks.length)) return true;
  }
  return false;
}

interface OpenPay {
  id: number;
  description: string;
  amount: number;
  customerName: string | null;
  customerNickname: string | null;
  contractNumber: string | null;
}

function payLabel(p: OpenPay): string {
  const who = p.customerNickname || p.customerName;
  const tail = [who, p.contractNumber ? `Contrato ${p.contractNumber}` : null]
    .filter(Boolean)
    .join(' · ');
  const val = p.amount.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const main = [p.description, tail].filter(Boolean).join(' — ');
  return `${main ? `${main} ` : ''}(R$ ${val})`;
}

// Load open receivables (entradas not yet received), resolving the customer via
// the payment directly or via its contract.
async function loadOpenReceivables(): Promise<OpenPay[]> {
  const rows = await db
    .select({
      id: schema.payments.id,
      description: schema.payments.description,
      amount: schema.payments.amount,
      customerName: schema.customers.name,
      customerNickname: schema.customers.nickname,
      contractNumber: schema.contracts.number,
    })
    .from(schema.payments)
    .leftJoin(schema.contracts, eq(schema.payments.contractId, schema.contracts.id))
    .leftJoin(
      schema.customers,
      sql`${schema.customers.id} = coalesce(${schema.payments.customerId}, ${schema.contracts.customerId})`
    )
    .where(and(eq(schema.payments.flow, 'in'), eq(schema.payments.receiptStatus, 'open')));

  return rows.map((r) => ({
    id: r.id,
    description: r.description,
    amount: Number(r.amount),
    customerName: r.customerName,
    customerNickname: r.customerNickname,
    contractNumber: r.contractNumber,
  }));
}

interface StatementLine {
  fitId: string | null;
  date: string | null;
  type: string;
  description: string; // bank memo
  amount: number; // signed
  flow: 'in' | 'out';
}

const cents = (n: number) => Number(n).toFixed(2);

// For each statement line, whether it was imported before (aligned with `lines`).
// Three sources, from most to least reliable:
//  1. lines recorded by earlier imports, matched on the bank's FITID + date + amount
//     (+ account);
//  2. recorded lines that carry no FITID, matched on date + amount + memo;
//  3. payments created by imports made BEFORE lines were recorded (same direction,
//     date, amount and description). Installments reconciled by an old import can't
//     be recognised this way.
async function flagAlreadyImported(lines: StatementLine[], accountId: string | null): Promise<boolean[]> {
  const seen = new Set<string>();
  const acct = accountId ?? '';
  const dates = lines.map((l) => l.date).filter((d): d is string => !!d).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];

  const fitIds = [...new Set(lines.map((l) => l.fitId).filter((f): f is string => !!f))];
  if (fitIds.length > 0) {
    const rows = await db
      .select({
        fitId: schema.transactions.fitId,
        // Original statement values; rows from before they were recorded fall back to the stored ones.
        date: sql<string>`DATE_FORMAT(COALESCE(${schema.transactions.origDate}, ${schema.transactions.date}), '%Y-%m-%d')`,
        amount: sql<string>`COALESCE(${schema.transactions.origAmount}, ${schema.transactions.amount})`,
        accountId: schema.bankImports.accountId,
      })
      .from(schema.transactions)
      .leftJoin(schema.bankImports, eq(schema.transactions.importId, schema.bankImports.id))
      .where(and(eq(schema.transactions.imported, true), inArray(schema.transactions.fitId, fitIds)));
    for (const r of rows) seen.add(`fit|${r.accountId ?? ''}|${r.fitId}|${r.date}|${cents(Number(r.amount))}`);
  }

  if (minDate) {
    const noFit = await db
      .select({
        date: sql<string>`DATE_FORMAT(COALESCE(${schema.transactions.origDate}, ${schema.transactions.date}), '%Y-%m-%d')`,
        amount: sql<string>`COALESCE(${schema.transactions.origAmount}, ${schema.transactions.amount})`,
        memo: schema.transactions.memo,
        accountId: schema.bankImports.accountId,
      })
      .from(schema.transactions)
      .leftJoin(schema.bankImports, eq(schema.transactions.importId, schema.bankImports.id))
      .where(
        and(
          eq(schema.transactions.imported, true),
          isNull(schema.transactions.fitId),
          sql`COALESCE(${schema.transactions.origDate}, ${schema.transactions.date}) >= ${minDate}`,
          sql`COALESCE(${schema.transactions.origDate}, ${schema.transactions.date}) <= ${maxDate}`
        )
      );
    for (const r of noFit) seen.add(`nofit|${r.accountId ?? ''}|${r.date}|${cents(Number(r.amount))}|${r.memo ?? ''}`);

    // Imports made before lines were recorded left only payments behind.
    const legacy = await db
      .select({
        flow: schema.payments.flow,
        amount: schema.payments.amount,
        description: schema.payments.description,
        dueDate: schema.payments.dueDate,
      })
      .from(schema.payments)
      .where(
        and(
          gte(schema.payments.dueDate, minDate),
          lte(schema.payments.dueDate, maxDate),
          isNull(schema.payments.installmentNumber),
          or(
            and(eq(schema.payments.flow, 'in'), inArray(schema.payments.receiptStatus, ['received', 'sent'])),
            and(eq(schema.payments.flow, 'out'), eq(schema.payments.status, 'done'))
          )
        )
      );
    for (const r of legacy) seen.add(`pay|${r.flow}|${r.dueDate}|${cents(Number(r.amount))}|${r.description}`);
  }

  return lines.map((l) => {
    if (!l.date) return false;
    if (l.fitId) {
      if (seen.has(`fit|${acct}|${l.fitId}|${l.date}|${cents(l.amount)}`)) return true;
    } else if (seen.has(`nofit|${acct}|${l.date}|${cents(l.amount)}|${l.description}`)) {
      return true;
    }
    return seen.has(`pay|${l.flow}|${l.date}|${cents(Math.abs(l.amount))}|${l.description || l.type}`);
  });
}

export function registerBankRoutes(app: FastifyInstance) {
  // Parse an OFX file WITHOUT persisting. Returns editable preview rows plus the
  // list of open receivables so the client can offer reconciliation options.
  app.post('/api/bank/parse', async (req: any, reply) => {
    const { fileName, content } = req.body ?? {};
    if (!content) return reply.code(400).send({ error: 'O conteúdo do extrato (OFX) é obrigatório.' });

    if (typeof content !== 'string') return reply.code(400).send({ error: 'Conteúdo do extrato inválido.' });

    const parsed = parseOfx(content);
    const open = await loadOpenReceivables();
    // Receivables already auto-assigned to an earlier line of this statement; a
    // payment can be reconciled by one line only.
    const claimed = new Set<number>();

    const rawItems = parsed.transactions
      // Drop running-balance pseudo-rows.
      .filter((t) => !normalize(t.name).startsWith('saldo'))
      .map((t) => {
        const flow: 'in' | 'out' = t.amount < 0 ? 'out' : 'in';
        const memo = t.memo ?? '';
        const abs = Math.abs(t.amount);

        let matchedPaymentId: number | null = null;
        let suggestions: { paymentId: number; reason: string; label: string }[] = [];

        if (flow === 'in') {
          const valueMatches = open.filter((p) => Math.abs(p.amount - abs) < 0.005);
          const nameHits = valueMatches.filter((p) =>
            nameInMemo(memo, p.customerName, p.customerNickname)
          );

          // Certain match: exactly one by value, or (when several share a value)
          // exactly one of those also matches the name.
          let certain: number | null = null;
          if (valueMatches.length === 1) {
            certain = valueMatches[0].id;
          } else if (valueMatches.length > 1 && nameHits.length === 1) {
            certain = nameHits[0].id;
          }
          // Duplicates are resolved below, once "already imported" lines are known.
          matchedPaymentId = certain;

          // Candidates to surface first: value matches, else name-only matches.
          const candidates =
            valueMatches.length > 0
              ? valueMatches
              : open.filter((p) => nameInMemo(memo, p.customerName, p.customerNickname));
          suggestions = candidates.map((p) => {
            const valOk = Math.abs(p.amount - abs) < 0.005;
            const nameOk = nameInMemo(memo, p.customerName, p.customerNickname);
            const reason = valOk && nameOk ? 'valor + nome' : valOk ? 'valor' : 'nome';
            return { paymentId: p.id, reason, label: payLabel(p) };
          });
        }

        return {
          fitId: t.fitId,
          date: t.date,
          type: t.name ?? '',
          description: memo,
          amount: t.amount,
          originalDate: t.date,
          originalAmount: t.amount,
          flow,
          categoryId: null as number | null,
          matchedPaymentId,
          selected: true,
          suggestions,
        };
      });

    // Lines already imported before come back flagged and NOT selected; the user
    // can still tick them to import again.
    const flags = await flagAlreadyImported(rawItems, parsed.accountId);
    const items = rawItems.map((it, i) => ({ ...it, alreadyImported: flags[i], selected: !flags[i] }));

    // A receivable can be auto-assigned to one line only. New lines claim first (in
    // statement order); an "already imported" line never takes one from them.
    for (const it of items) {
      if (it.alreadyImported || it.matchedPaymentId === null) continue;
      if (claimed.has(it.matchedPaymentId)) it.matchedPaymentId = null;
      else claimed.add(it.matchedPaymentId);
    }
    for (const it of items) {
      if (!it.alreadyImported || it.matchedPaymentId === null) continue;
      if (claimed.has(it.matchedPaymentId)) it.matchedPaymentId = null;
      else claimed.add(it.matchedPaymentId);
    }

    return {
      bankId: parsed.bankId,
      accountId: parsed.accountId,
      fileName,
      items,
      skipped: parsed.skipped,
      openPayments: open.map((p) => ({ value: String(p.id), label: payLabel(p) })),
    };
  });

  // Commit the selected preview rows into the payments ledger.
  //  - a chosen Referência (matchedPaymentId) -> mark that receivable as received
  //  - nothing chosen                          -> create a new payment
  app.post('/api/bank/import', async (req: any, reply) => {
    const { items } = req.body ?? {};
    if (!Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ error: 'Nenhum lançamento para importar.' });
    }
    if (items.length > 5000) {
      return reply.code(400).send({ error: 'Lançamentos demais em uma única importação (máximo 5000).' });
    }

    const today = todayIso();

    // ---- 1) Validate EVERY line before writing anything -------------------------
    interface Prepared {
      it: any;
      date: string;
      amount: number; // signed, as in the statement (possibly edited in the preview)
      origDate: string; // statement date as parsed (fingerprint)
      origAmount: number; // statement amount as parsed (fingerprint)
      flow: 'in' | 'out';
      matchedPaymentId: number | null;
      contractId: number | null;
      categoryId: number | null;
    }
    const prepared: Prepared[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const n = i + 1;
      if (!it || typeof it !== 'object') return badRequest(reply, `Lançamento ${n}: dados inválidos.`);
      const date = it.date == null || it.date === '' ? today : parseIsoDateStrict(it.date);
      if (!date) return badRequest(reply, `Lançamento ${n}: data inválida.`);
      const amount = parseMoney(it.amount);
      if (amount === null) return badRequest(reply, `Lançamento ${n}: valor inválido.`);
      if (it.flow != null && !isOneOf(FLOWS, it.flow)) return badRequest(reply, `Lançamento ${n}: tipo inválido.`);
      const flow: 'in' | 'out' = it.flow ?? (amount < 0 ? 'out' : 'in');
      // Original statement values (fingerprint); fall back to the (edited) ones if omitted.
      const origDate = it.originalDate == null || it.originalDate === '' ? date : parseIsoDateStrict(it.originalDate);
      if (!origDate) return badRequest(reply, `Lançamento ${n}: data original inválida.`);
      const origAmount = it.originalAmount == null || it.originalAmount === '' ? amount : parseMoney(it.originalAmount);
      if (origAmount === null) return badRequest(reply, `Lançamento ${n}: valor original inválido.`);
      const categoryId = optionalId(it.categoryId);
      const contractId = optionalId(it.contractId);
      const matched = optionalId(it.matchedPaymentId);
      if (categoryId === false) return badRequest(reply, `Lançamento ${n}: categoria inválida.`);
      if (contractId === false) return badRequest(reply, `Lançamento ${n}: contrato inválido.`);
      if (matched === false) return badRequest(reply, `Lançamento ${n}: referência inválida.`);
      prepared.push({
        it,
        date,
        amount,
        origDate,
        origAmount,
        flow,
        // A saída (cost) can never reconcile a receivable: ignore any reference.
        matchedPaymentId: flow === 'out' ? null : matched ?? null,
        contractId: contractId ?? null,
        categoryId: categoryId ?? null,
      });
    }

    // The payments chosen as Referência must exist, be entradas and still be open,
    // and each can be reconciled by one line only.
    const matchedIds = prepared.map((p) => p.matchedPaymentId).filter((x): x is number => x !== null);
    if (new Set(matchedIds).size !== matchedIds.length) {
      return badRequest(reply, 'O mesmo pagamento foi associado a mais de um lançamento.');
    }
    if (matchedIds.length > 0) {
      const rows = await db.select().from(schema.payments).where(inArray(schema.payments.id, matchedIds));
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (let i = 0; i < prepared.length; i++) {
        const id = prepared[i].matchedPaymentId;
        if (id === null) continue;
        const p = byId.get(id);
        if (!p || p.flow !== 'in' || p.receiptStatus !== 'open') {
          return badRequest(reply, `Lançamento ${i + 1}: o pagamento da Referência não está mais em aberto.`);
        }
      }
    }
    const contractIds = [...new Set(prepared.map((p) => p.contractId).filter((x): x is number => x !== null))];
    if (contractIds.length > 0) {
      const rows = await db
        .select({ id: schema.contracts.id })
        .from(schema.contracts)
        .where(inArray(schema.contracts.id, contractIds));
      if (rows.length !== contractIds.length) return badRequest(reply, 'Contrato associado não encontrado.');
    }
    const categoryIds = [...new Set(prepared.map((p) => p.categoryId).filter((x): x is number => x !== null))];
    if (categoryIds.length > 0) {
      const rows = await db
        .select({ id: schema.categories.id })
        .from(schema.categories)
        .where(inArray(schema.categories.id, categoryIds));
      if (rows.length !== categoryIds.length) return badRequest(reply, 'Categoria não encontrada.');
    }

    // ---- 2) Write ------------------------------------------------------------------
    let received = 0;
    let created = 0;

    // Record this import and each of its lines, so a later upload of the same
    // statement can flag them as "already imported".
    const { fileName, bankId, accountId } = req.body ?? {};
    const impRes: any = await db
      .insert(schema.bankImports)
      .values({
        fileName: String(fileName || 'extrato.ofx').slice(0, 512),
        bankId: bankId != null ? String(bankId).slice(0, 64) : null,
        accountId: accountId != null ? String(accountId).slice(0, 64) : null,
        itemCount: items.length,
      })
      .$returningId();
    const importId: number = impRes[0].id;
    const record = (pr: Prepared, paymentId: number | null) =>
      db.insert(schema.transactions).values({
        importId,
        fitId: pr.it.fitId ? String(pr.it.fitId).slice(0, 255) : null,
        date: pr.date,
        description: pr.it.type ? String(pr.it.type).slice(0, 512) : null,
        memo: pr.it.description ? String(pr.it.description).slice(0, 512) : null,
        amount: String(pr.amount),
        origDate: pr.origDate,
        origAmount: String(pr.origAmount),
        flow: pr.flow,
        categoryId: pr.categoryId,
        matchedPaymentId: paymentId,
        imported: true,
      });

    for (const pr of prepared) {
      const { it, date, flow } = pr;
      const amount = Math.abs(pr.amount);

      if (pr.matchedPaymentId !== null) {
        await db
          .update(schema.payments)
          .set({ receiptStatus: 'received', receivedDate: date })
          .where(eq(schema.payments.id, pr.matchedPaymentId));
        await record(pr, pr.matchedPaymentId);
        received++;
        continue;
      }

      const base: any = {
        description: String(it.description || it.type || 'Lançamento bancário').slice(0, 255),
        amount: String(amount),
        flow,
        categoryId: pr.categoryId,
        dueDate: date,
      };
      if (flow === 'in') {
        base.receiptStatus = 'received';
        base.receivedDate = date;
        base.status = 'upcoming';
      } else {
        base.status = 'done';
        base.paidDate = date;
      }
      // Associate the income to a contract as an EXTRA payment: linked to the
      // contract (and its customer) but with no installment, so it never changes
      // the contract's value or installments.
      if (pr.contractId !== null) {
        base.contractId = pr.contractId;
        const [ct] = await db
          .select({ customerId: schema.contracts.customerId })
          .from(schema.contracts)
          .where(eq(schema.contracts.id, pr.contractId));
        if (ct?.customerId) base.customerId = ct.customerId;
      }
      const payRes: any = await db.insert(schema.payments).values(base).$returningId();
      await record(pr, payRes[0].id);
      created++;
    }

    return reply.code(201).send({ received, created, imported: received + created });
  });

  // Effective date of a payment = when the money actually moved.
  const effDate = sql<string>`coalesce(${schema.payments.paidDate}, ${schema.payments.receivedDate}, ${schema.payments.dueDate})`;
  // Realized money only: received entradas + paid custos.
  const realized = or(
    and(eq(schema.payments.flow, 'in'), inArray(schema.payments.receiptStatus, ['received', 'sent'])),
    and(eq(schema.payments.flow, 'out'), eq(schema.payments.status, 'done'))
  );

  function reportConds(q: any, withFilters: boolean) {
    const conds: any[] = [realized];
    if (q.from) conds.push(gte(effDate, q.from));
    if (q.to) conds.push(lte(effDate, q.to));
    if (withFilters) {
      if (q.flow) conds.push(eq(schema.payments.flow, q.flow));
      if (q.categoryId) conds.push(eq(schema.payments.categoryId, Number(q.categoryId)));
    }
    return conds;
  }

  // Filtered list of realized payments (feeds the Relatórios page).
  app.get('/api/reports/entries', async (req: any) => {
    const conds = reportConds(req.query ?? {}, true);
    return db
      .select({
        id: schema.payments.id,
        date: effDate,
        description: schema.payments.description,
        amount: schema.payments.amount,
        flow: schema.payments.flow,
        categoryId: schema.payments.categoryId,
        categoryName: schema.categories.name,
        customerName: schema.customers.name,
        customerNickname: schema.customers.nickname,
        contractNumber: schema.contracts.number,
      })
      .from(schema.payments)
      .leftJoin(schema.contracts, eq(schema.payments.contractId, schema.contracts.id))
      .leftJoin(
        schema.customers,
        sql`${schema.customers.id} = coalesce(${schema.payments.customerId}, ${schema.contracts.customerId})`
      )
      .leftJoin(schema.categories, eq(schema.payments.categoryId, schema.categories.id))
      .where(and(...conds))
      .orderBy(desc(effDate), desc(schema.payments.id));
  });

  // Report summary: totals in / out / net for a filtered range.
  app.get('/api/reports/summary', async (req: any) => {
    const conds = reportConds(req.query ?? {}, false);
    const [row] = await db
      .select({
        totalIn: sql<string>`coalesce(sum(case when ${schema.payments.flow} = 'in' then ${schema.payments.amount} else 0 end), 0)`,
        totalOut: sql<string>`coalesce(sum(case when ${schema.payments.flow} = 'out' then ${schema.payments.amount} else 0 end), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(schema.payments)
      .where(and(...conds));

    const totalIn = Number(row.totalIn);
    const totalOutPos = Number(row.totalOut);
    return { totalIn, totalOut: -totalOutPos, net: totalIn - totalOutPos, count: Number(row.count) };
  });
}
