import type { FastifyInstance } from 'fastify';
import { eq, and, gt, desc, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { badId, parseId, parseMoney } from '../lib/validate.js';

export function registerCustomerRoutes(app: FastifyInstance) {
  // List a customer's credits. ?all=1 includes fully-used ones (remaining = 0).
  app.get('/api/customers/:id/credits', async (req: any, reply) => {
    const customerId = parseId(req.params.id);
    if (customerId === null) return badId(reply);
    const all = String(req.query?.all ?? '') === '1' || req.query?.all === 'true';
    const conds: any[] = [eq(schema.customerCredits.customerId, customerId)];
    if (!all) conds.push(gt(schema.customerCredits.remaining, '0'));
    return db
      .select()
      .from(schema.customerCredits)
      .where(and(...conds))
      .orderBy(desc(schema.customerCredits.id));
  });

  // Add a credit. Body: { description, value }
  app.post('/api/customers/:id/credits', async (req: any, reply) => {
    const customerId = parseId(req.params.id);
    if (customerId === null) return badId(reply);
    const { description, value } = req.body ?? {};
    if (!description) return reply.code(400).send({ error: 'A descrição é obrigatória.' });
    if (typeof description !== 'string' || description.length > 255) {
      return reply.code(400).send({ error: 'Descrição inválida (máximo 255 caracteres).' });
    }
    const v = parseMoney(value);
    if (v === null) return reply.code(400).send({ error: 'Valor inválido.' });
    if (v <= 0) return reply.code(400).send({ error: 'O valor deve ser maior que zero.' });
    const res: any = await db
      .insert(schema.customerCredits)
      .values({ customerId, description, value: String(v), remaining: String(v) })
      .$returningId();
    const [row] = await db.select().from(schema.customerCredits).where(eq(schema.customerCredits.id, res[0].id));
    return reply.code(201).send(row);
  });

  // Delete a credit — only if untouched (nothing spent yet).
  app.delete('/api/customers/:id/credits/:creditId', async (req: any, reply) => {
    const creditId = parseId(req.params.creditId);
    if (creditId === null) return badId(reply);
    const [c] = await db.select().from(schema.customerCredits).where(eq(schema.customerCredits.id, creditId));
    if (!c) return reply.code(204).send();
    if (Number(c.remaining) !== Number(c.value)) {
      return reply.code(409).send({ error: 'Crédito já utilizado — não pode ser excluído.' });
    }
    await db.delete(schema.customerCredits).where(eq(schema.customerCredits.id, creditId));
    return reply.code(204).send();
  });

  // Pending charges = open entrada payments for this customer (direct or via contract).
  app.get('/api/customers/:id/charges', async (req: any, reply) => {
    const customerId = parseId(req.params.id);
    if (customerId === null) return badId(reply);
    return db
      .select({
        id: schema.payments.id,
        description: schema.payments.description,
        amount: schema.payments.amount,
        dueDate: schema.payments.dueDate,
        contractNumber: schema.contracts.number,
      })
      .from(schema.payments)
      .leftJoin(schema.contracts, eq(schema.payments.contractId, schema.contracts.id))
      .where(
        and(
          eq(schema.payments.flow, 'in'),
          eq(schema.payments.receiptStatus, 'open'),
          sql`coalesce(${schema.payments.customerId}, ${schema.contracts.customerId}) = ${customerId}`
        )
      )
      .orderBy(schema.payments.dueDate);
  });
}
