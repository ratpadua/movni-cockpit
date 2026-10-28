import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, desc, inArray } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { FREQUENCIES, MAX_OCCURRENCES, recurrenceDates } from '../lib/recurrence.js';

// Fields a series-wide edit copies to the other payments of the series.
const SERIES_SHARED_FIELDS = ['description', 'amount', 'categoryId', 'customerId', 'contractId'] as const;

const ALLOWED = [
  'customerId', 'contractId', 'invoiceId', 'categoryId', 'description', 'amount', 'flow',
  'status', 'receiptStatus', 'installmentNumber', 'installmentCount', 'dueDate', 'paidDate', 'receivedDate',
] as const;

// Pick only known columns from the body; coerce the decimal amount to a string.
function clean(body: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of ALLOWED) {
    if (body?.[k] !== undefined) out[k] = k === 'amount' ? String(body[k] ?? 0) : body[k];
  }
  return out;
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
      const dates = recurrenceDates(first, rec.frequency, rec.until);
      if (dates.length === 0) {
        return reply.code(400).send({ error: 'A data final deve ser igual ou posterior ao primeiro vencimento.' });
      }
      if (dates.length > MAX_OCCURRENCES) {
        return reply.code(400).send({ error: `A recorrência geraria mais de ${MAX_OCCURRENCES} pagamentos. Reduza o período.` });
      }
      const recurrenceId = randomUUID();
      const base = clean(req.body);
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

    const res: any = await db.insert(schema.payments).values(clean(req.body) as any).$returningId();
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
    const id = Number(req.params.id);
    const [before] = await db.select().from(schema.payments).where(eq(schema.payments.id, id));
    if (!before) return reply.code(404).send({ error: 'not found' });

    const data = clean(req.body);
    await db.update(schema.payments).set(data).where(eq(schema.payments.id, id));

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
    const id = Number(req.params.id);
    const [row] = await db.select().from(schema.payments).where(eq(schema.payments.id, id));
    const ids = row ? [id, ...(await seriesTargets(row, String(req.query?.scope ?? '')))] : [id];
    await db.delete(schema.payments).where(inArray(schema.payments.id, ids));
    return reply.code(204).send();
  });
}
