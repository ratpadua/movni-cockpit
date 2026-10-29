import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, desc, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { FREQUENCIES, MAX_OCCURRENCES, recurrenceDates } from '../lib/recurrence.js';
import {
  FLOWS,
  PAYMENT_STATUSES,
  RECEIPT_STATUSES,
  badId,
  badRequest,
  isOneOf,
  optionalDate,
  optionalId,
  parseId,
  parseIsoDateStrict,
  parseMoney,
} from '../lib/validate.js';

// Fields a series-wide edit copies to the other payments of the series.
const SERIES_SHARED_FIELDS = ['description', 'amount', 'categoryId', 'customerId', 'contractId'] as const;

const ID_FIELDS = [
  ['customerId', 'Cliente'],
  ['contractId', 'Contrato'],
  ['invoiceId', 'Fatura'],
  ['categoryId', 'Categoria'],
] as const;
const DATE_FIELDS = [
  ['dueDate', 'vencimento'],
  ['paidDate', 'data de pagamento'],
  ['receivedDate', 'data de recebimento'],
] as const;

// Validate + pick only the known columns from the body (the decimal amount becomes a
// string). `partial` = update (every field optional); on create description and amount
// are required. Returns the clean data or a pt-BR error message for a 400.
function clean(body: any, partial: boolean): { data: Record<string, any> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Dados inválidos.' };
  const out: Record<string, any> = {};

  for (const [k, label] of ID_FIELDS) {
    const v = optionalId(body[k]);
    if (v === false) return { error: `${label} inválido.` };
    if (v !== undefined) out[k] = v;
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.trim() === '') {
      return { error: 'A descrição é obrigatória.' };
    }
    if (body.description.length > 255) return { error: 'A descrição excede 255 caracteres.' };
    out.description = body.description.trim();
  } else if (!partial) {
    return { error: 'A descrição é obrigatória.' };
  }

  if (body.amount !== undefined) {
    const amount = parseMoney(body.amount, { emptyAs: 0 });
    if (amount === null) return { error: 'Valor inválido.' };
    // User-facing create: amount must be > 0. (On update the route compares with the
    // stored amount, so legacy 0/negative payments can still have other fields edited.)
    if (!partial && amount <= 0) return { error: 'Informe um valor maior que zero.' };
    out.amount = String(amount);
  } else if (!partial) {
    return { error: 'O valor é obrigatório.' };
  }

  if (body.flow !== undefined) {
    if (!isOneOf(FLOWS, body.flow)) return { error: 'Tipo inválido (use entrada ou saída).' };
    out.flow = body.flow;
  }
  if (body.status !== undefined) {
    if (!isOneOf(PAYMENT_STATUSES, body.status)) return { error: 'Situação inválida.' };
    out.status = body.status;
  }
  if (body.receiptStatus !== undefined) {
    if (!isOneOf(RECEIPT_STATUSES, body.receiptStatus)) return { error: 'Situação do recibo inválida.' };
    out.receiptStatus = body.receiptStatus;
  }

  for (const k of ['installmentNumber', 'installmentCount'] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (v === null || v === '') out[k] = null;
    else {
      const n = parseId(v);
      if (n === null) return { error: 'Número de parcelas inválido.' };
      out[k] = n;
    }
  }

  for (const [k, label] of DATE_FIELDS) {
    const v = optionalDate(body[k]);
    if (v === false) return { error: `Data inválida (${label}).` };
    if (v !== undefined) out[k] = v;
  }
  return { data: out };
}

export function registerPaymentRoutes(app: FastifyInstance) {
  // Joined list: customer (name/nickname), contract number, category name.
  app.get('/api/payments', async () => {
    return db
      .select({
        id: schema.payments.id,
        contractId: schema.payments.contractId,
        invoiceId: schema.payments.invoiceId,
        customerId: schema.payments.customerId,
        categoryId: schema.payments.categoryId,
        description: schema.payments.description,
        amount: schema.payments.amount,
        flow: schema.payments.flow,
        status: schema.payments.status,
        receiptStatus: schema.payments.receiptStatus,
        installmentNumber: schema.payments.installmentNumber,
        installmentCount: schema.payments.installmentCount,
        dueDate: schema.payments.dueDate,
        paidDate: schema.payments.paidDate,
        receivedDate: schema.payments.receivedDate,
        recurrenceId: schema.payments.recurrenceId,
        customerName: schema.customers.name,
        customerNickname: schema.customers.nickname,
        contractNumber: schema.contracts.number,
        categoryName: schema.categories.name,
      })
      .from(schema.payments)
      .leftJoin(schema.customers, eq(schema.payments.customerId, schema.customers.id))
      .leftJoin(schema.contracts, eq(schema.payments.contractId, schema.contracts.id))
      .leftJoin(schema.categories, eq(schema.payments.categoryId, schema.categories.id))
      .orderBy(desc(schema.payments.id));
  });

  // Create a payment. With `recurrence: { frequency, until }` it instead creates one
  // payment per due date from `dueDate` up to `until` (inclusive), all open and sharing
  // a recurrenceId so the series can be edited/deleted together later.
  app.post('/api/payments', async (req: any, reply) => {
    const rec = req.body?.recurrence;
    if (rec) {
      const first = req.body?.dueDate;
      if (!FREQUENCIES.includes(rec.frequency) || !first || !rec.until) {
        return reply.code(400).send({ error: 'Informe a frequência, o vencimento e a data final da recorrência.' });
      }
      // Real calendar dates only (2026-02-31 would otherwise silently roll over).
      if (parseIsoDateStrict(first) === null || parseIsoDateStrict(rec.until) === null) {
        return badRequest(reply, 'Data inválida na recorrência: informe datas reais do calendário.');
      }
      const dates = recurrenceDates(first, rec.frequency, rec.until);
      if (dates.length === 0) {
        return reply.code(400).send({ error: 'A data final deve ser igual ou posterior ao primeiro vencimento.' });
      }
      if (dates.length > MAX_OCCURRENCES) {
        return reply.code(400).send({ error: `A recorrência geraria mais de ${MAX_OCCURRENCES} pagamentos. Reduza o período.` });
      }
      const recurrenceId = randomUUID();
      const cleaned = clean(req.body, false);
      if ('error' in cleaned) return badRequest(reply, cleaned.error);
      const base = cleaned.data;
      // Every payment of a new series starts open (to pay / to receive).
      const rows = dates.map((dueDate) => ({
        ...base,
        dueDate,
        recurrenceId,
        status: 'upcoming',
        receiptStatus: 'open',
        paidDate: null,
        receivedDate: null,
      }));
      for (let i = 0; i < rows.length; i += 200) {
        await db.insert(schema.payments).values(rows.slice(i, i + 200) as any);
      }
      return reply.code(201).send({ recurrenceId, count: rows.length });
    }

    const cleaned = clean(req.body, false);
    if ('error' in cleaned) return badRequest(reply, cleaned.error);
    const res: any = await db.insert(schema.payments).values(cleaned.data as any).$returningId();
    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.id, res[0].id));
    return reply.code(201).send(row);
  });

  // Other payments of the same recurrence that a series-wide edit/delete affects.
  // `following` = from this payment's due date onward; `all` = the whole series.
  // Payments already paid/received are never touched (history stays), and the
  // clicked payment itself is not included (the caller handles it).
  async function seriesTargets(clicked: typeof schema.payments.$inferSelect, scope: string): Promise<number[]> {
    if (!clicked.recurrenceId || (scope !== 'following' && scope !== 'all')) return [];
    const series = await db.select().from(schema.payments).where(eq(schema.payments.recurrenceId, clicked.recurrenceId));
    return series
      .filter((p) => p.id !== clicked.id)
      .filter((p) => (p.flow === 'in' ? p.receiptStatus === 'open' : p.status === 'upcoming'))
      .filter((p) => scope === 'all' || (p.dueDate ?? '') >= (clicked.dueDate ?? ''))
      .map((p) => p.id);
  }

  // Update a payment. For a recurring one, `scope: 'following' | 'all'` also applies the
  // shared fields (description, amount, category, customer, contract) to the other open
  // payments of the series; each keeps its own due date and situation.
  app.put('/api/payments/:id', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badId(reply);
    const [before] = await db.select().from(schema.payments).where(eq(schema.payments.id, id));
    if (!before) return reply.code(404).send({ error: 'Pagamento não encontrado.' });

    const cleaned = clean(req.body, true);
    if ('error' in cleaned) return badRequest(reply, cleaned.error);
    const data = cleaned.data;
    // Amount must be > 0 when it is being changed; an unchanged legacy 0/negative is left alone.
    if (data.amount !== undefined && Number(data.amount) <= 0 && Number(data.amount) !== Number(before.amount)) {
      return badRequest(reply, 'Informe um valor maior que zero.');
    }
    // Nothing to change (e.g. only `scope` was sent): never call set({}).
    if (Object.keys(data).length > 0) {
      await db.update(schema.payments).set(data).where(eq(schema.payments.id, id));
    }

    const others = await seriesTargets(before, String(req.body?.scope ?? ''));
    if (others.length > 0) {
      const shared: Record<string, any> = {};
      for (const k of SERIES_SHARED_FIELDS) if (data[k] !== undefined) shared[k] = data[k];
      if (Object.keys(shared).length > 0) {
        await db.update(schema.payments).set(shared).where(inArray(schema.payments.id, others));
      }
    }

    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.id, id));
    return row;
  });

  // Delete a payment; `?scope=following|all` also deletes the other open payments of its series.
  app.delete('/api/payments/:id', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badId(reply);
    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.id, id));
    const ids = row ? [id, ...(await seriesTargets(row, String(req.query?.scope ?? '')))] : [id];
    await db.delete(schema.payments).where(inArray(schema.payments.id, ids));
    return reply.code(204).send();
  });
}
