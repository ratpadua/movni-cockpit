import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { parseId, badId, badRequest, isOneOf } from './validate.js';

// Whitelist entry for one column of a CRUD resource. Anything not listed (id,
// createdAt, ...) is ignored, so a request can never set it (no mass assignment).
export type FieldSpec =
  | { kind: 'string'; label: string; max: number; required?: boolean }
  | { kind: 'enum'; label: string; values: readonly string[] };

// Validate + pick the whitelisted fields from `body`. On create (`partial` false)
// required fields must be present. Empty strings become null (like the client does).
function pickFields(
  fields: Record<string, FieldSpec>,
  body: any,
  partial: boolean
): { data: Record<string, any> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Dados inválidos.' };
  }
  const data: Record<string, any> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const raw = body[key];
    if (raw === undefined) {
      if (!partial && spec.kind === 'string' && spec.required) return { error: `${spec.label} é obrigatório.` };
      continue;
    }
    if (spec.kind === 'enum') {
      if (raw === null || raw === '') data[key] = null;
      else if (isOneOf(spec.values, raw)) data[key] = raw;
      else return { error: `${spec.label} inválido.` };
      continue;
    }
    if (raw === null || raw === '') {
      if (spec.required) return { error: `${spec.label} é obrigatório.` };
      data[key] = null;
      continue;
    }
    if (typeof raw !== 'string') return { error: `${spec.label} inválido.` };
    if (spec.required && raw.trim() === '') return { error: `${spec.label} é obrigatório.` };
    if (raw.length > spec.max) return { error: `${spec.label} excede ${spec.max} caracteres.` };
    data[key] = raw;
  }
  return { data };
}

// Registers standard REST endpoints for a Drizzle table:
//   GET    /            list all
//   GET    /:id         get one
//   POST   /            create
//   PUT    /:id         update
//   DELETE /:id         delete
//
// `table` is a Drizzle mysqlTable and `fields` the whitelist of writable columns.
// Typing is kept loose on purpose so this single helper can serve every simple resource.
// MySQL has no RETURNING, so create/update insert-or-update then re-select.
//
// Optional `beforeDelete(id)` guard: return a pt-BR message to refuse the delete with
// HTTP 409 (nothing is deleted), or null/undefined to let it proceed.
export function registerCrud(
  app: FastifyInstance,
  prefix: string,
  table: any,
  fields: Record<string, FieldSpec>,
  opts: { beforeDelete?: (id: number) => Promise<string | null | undefined> } = {}
) {
  const byId = (id: number) => db.select().from(table).where(eq(table.id, id));

  app.get(prefix, async () => {
    return db.select().from(table).orderBy(table.id);
  });

  app.get(`${prefix}/:id`, async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id == null) return badId(reply);
    const rows = await byId(id);
    if (rows.length === 0) return reply.code(404).send({ error: 'Registro não encontrado.' });
    return rows[0];
  });

  app.post(prefix, async (req: any, reply) => {
    const picked = pickFields(fields, req.body, false);
    if ('error' in picked) return badRequest(reply, picked.error);
    if (Object.keys(picked.data).length === 0) return badRequest(reply, 'Nenhum campo informado.');
    const res: any = await db.insert(table).values(picked.data).$returningId();
    const id = res[0]?.id;
    const [row] = await byId(id);
    return reply.code(201).send(row);
  });

  app.put(`${prefix}/:id`, async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id == null) return badId(reply);
    const picked = pickFields(fields, req.body, true);
    if ('error' in picked) return badRequest(reply, picked.error);
    if (Object.keys(picked.data).length === 0) return badRequest(reply, 'Nenhum campo informado.');
    await db.update(table).set(picked.data).where(eq(table.id, id));
    const [row] = await byId(id);
    if (!row) return reply.code(404).send({ error: 'Registro não encontrado.' });
    return row;
  });

  app.delete(`${prefix}/:id`, async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id == null) return badId(reply);
    if (opts.beforeDelete) {
      const blocked = await opts.beforeDelete(id);
      if (blocked) return reply.code(409).send({ error: blocked });
    }
    await db.delete(table).where(eq(table.id, id));
    return reply.code(204).send();
  });
}
