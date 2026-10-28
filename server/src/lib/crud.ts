import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';

// Registers standard REST endpoints for a Drizzle table:
//   GET    /            list all
//   GET    /:id         get one
//   POST   /            create
//   PUT    /:id         update
//   DELETE /:id         delete
//
// `table` is a Drizzle mysqlTable. Typing is kept loose on purpose so this
// single helper can serve every simple resource in the app.
// MySQL has no RETURNING, so create/update insert-or-update then re-select.
export function registerCrud(app: FastifyInstance, prefix: string, table: any) {
  const byId = (id: number) => db.select().from(table).where(eq(table.id, id));

  app.get(prefix, async () => {
    return db.select().from(table).orderBy(table.id);
  });

  app.get(`${prefix}/:id`, async (req: any, reply) => {
    const rows = await byId(Number(req.params.id));
    if (rows.length === 0) return reply.code(404).send({ error: 'not found' });
    return rows[0];
  });

  app.post(prefix, async (req: any, reply) => {
    const res: any = await db.insert(table).values(req.body).$returningId();
    const id = res[0]?.id;
    const [row] = await byId(id);
    return reply.code(201).send(row);
  });

  app.put(`${prefix}/:id`, async (req: any, reply) => {
    const id = Number(req.params.id);
    await db.update(table).set(req.body).where(eq(table.id, id));
    const [row] = await byId(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    return row;
  });

  app.delete(`${prefix}/:id`, async (req: any, reply) => {
    const id = Number(req.params.id);
    await db.delete(table).where(eq(table.id, id));
    return reply.code(204).send();
  });
}
