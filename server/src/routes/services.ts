import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { badId, badRequest, parseId, parseMoney } from '../lib/validate.js';

// Load one service version + its additionals.
async function loadVersionWithAdditionals(versionId: number) {
  const [version] = await db
    .select()
    .from(schema.serviceVersions)
    .where(eq(schema.serviceVersions.id, versionId));
  if (!version) return null;
  const additionals = await db
    .select()
    .from(schema.serviceAdditionals)
    .where(eq(schema.serviceAdditionals.versionId, versionId));
  return { ...version, additionals };
}

async function currentVersion(serviceId: number) {
  const [v] = await db
    .select()
    .from(schema.serviceVersions)
    .where(
      and(eq(schema.serviceVersions.serviceId, serviceId), eq(schema.serviceVersions.active, true))
    )
    .orderBy(desc(schema.serviceVersions.version))
    .limit(1);
  return v ? loadVersionWithAdditionals(v.id) : null;
}

interface AdditionalRow {
  name: string;
  price: string;
}

// Validate a list of additionals ({name, price}); entries without a name are dropped
// (as before). Returns the clean rows or a pt-BR error message.
function parseAdditionals(additionals: unknown): { rows: AdditionalRow[] } | { error: string } {
  if (additionals === undefined || additionals === null) return { rows: [] };
  if (!Array.isArray(additionals)) return { error: 'Lista de adicionais inválida.' };
  const rows: AdditionalRow[] = [];
  for (const m of additionals) {
    if (!m || !m.name) continue;
    if (typeof m.name !== 'string') return { error: 'Nome do adicional inválido.' };
    if (m.name.length > 255) return { error: 'O nome do adicional excede 255 caracteres.' };
    const price = parseMoney(m.price, { emptyAs: 0 });
    if (price === null) return { error: `Preço inválido no adicional "${m.name}".` };
    rows.push({ name: m.name, price: String(price) });
  }
  return { rows };
}

// Optional free-text field with a max length: undefined stays undefined, null/'' -> null.
function textField(v: unknown, max: number): string | null | undefined | false {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > max) return false;
  return v;
}

async function insertAdditionals(versionId: number, rows: AdditionalRow[]) {
  if (rows.length > 0) {
    await db.insert(schema.serviceAdditionals).values(rows.map((m) => ({ versionId, name: m.name, price: m.price })));
  }
}

export function registerServiceRoutes(app: FastifyInstance) {
  // List catalog services, each with its current (active) version + additionals.
  app.get('/api/services', async () => {
    const svcs = await db.select().from(schema.services).orderBy(schema.services.id);
    const out = [];
    for (const s of svcs) {
      out.push({ ...s, currentVersion: await currentVersion(s.id) });
    }
    return out;
  });

  // Full detail: service + all versions (with additionals), newest first.
  app.get('/api/services/:id', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badId(reply);
    const [service] = await db.select().from(schema.services).where(eq(schema.services.id, id));
    if (!service) return reply.code(404).send({ error: 'Serviço não encontrado.' });
    const versions = await db
      .select()
      .from(schema.serviceVersions)
      .where(eq(schema.serviceVersions.serviceId, id))
      .orderBy(desc(schema.serviceVersions.version));
    const withAdds = [];
    for (const v of versions) withAdds.push(await loadVersionWithAdditionals(v.id));
    return { ...service, versions: withAdds };
  });

  // Create a new catalog service with its first version + additionals.
  // Body: { name, description?, basePrice?, notes?, additionals?: [{name, price}] }
  app.post('/api/services', async (req: any, reply) => {
    const { name, description, basePrice, notes, additionals } = req.body ?? {};
    if (!name) return badRequest(reply, 'O nome é obrigatório.');
    if (typeof name !== 'string' || name.length > 255) return badRequest(reply, 'Nome inválido (máximo 255 caracteres).');
    const descVal = textField(description, 65535);
    if (descVal === false) return badRequest(reply, 'Descrição inválida.');
    const notesVal = textField(notes, 512);
    if (notesVal === false) return badRequest(reply, 'Observações inválidas (máximo 512 caracteres).');
    const price = parseMoney(basePrice, { emptyAs: 0 });
    if (price === null) return badRequest(reply, 'Preço base inválido.');
    const adds = parseAdditionals(additionals);
    if ('error' in adds) return badRequest(reply, adds.error);

    const svcRes: any = await db
      .insert(schema.services)
      .values({ name, description: descVal ?? null })
      .$returningId();
    const serviceId = svcRes[0].id;

    const verRes: any = await db
      .insert(schema.serviceVersions)
      .values({ serviceId, version: 1, basePrice: String(price), notes: notesVal ?? null, active: true })
      .$returningId();
    const versionId = verRes[0].id;

    await insertAdditionals(versionId, adds.rows);

    reply.code(201);
    return { id: serviceId, currentVersion: await loadVersionWithAdditionals(versionId) };
  });

  // Create a NEW version of an existing service (price/additional change).
  // Previous versions are retained but deactivated, so contracts keep their prices.
  // Body: { basePrice, notes?, additionals?: [{name, price}] }
  app.post('/api/services/:id/version', async (req: any, reply) => {
    const serviceId = parseId(req.params.id);
    if (serviceId === null) return badId(reply);
    const [service] = await db.select().from(schema.services).where(eq(schema.services.id, serviceId));
    if (!service) return reply.code(404).send({ error: 'Serviço não encontrado.' });

    const { basePrice, notes, additionals } = req.body ?? {};
    const notesVal = textField(notes, 512);
    if (notesVal === false) return badRequest(reply, 'Observações inválidas (máximo 512 caracteres).');
    const price = parseMoney(basePrice, { emptyAs: 0 });
    if (price === null) return badRequest(reply, 'Preço base inválido.');
    const adds = parseAdditionals(additionals);
    if ('error' in adds) return badRequest(reply, adds.error);

    const [{ maxV }] = await db
      .select({ maxV: sql<number>`coalesce(max(${schema.serviceVersions.version}), 0)` })
      .from(schema.serviceVersions)
      .where(eq(schema.serviceVersions.serviceId, serviceId));

    await db
      .update(schema.serviceVersions)
      .set({ active: false })
      .where(eq(schema.serviceVersions.serviceId, serviceId));

    const verRes: any = await db
      .insert(schema.serviceVersions)
      .values({
        serviceId,
        version: Number(maxV) + 1,
        basePrice: String(price),
        notes: notesVal ?? null,
        active: true,
      })
      .$returningId();
    const versionId = verRes[0].id;

    await insertAdditionals(versionId, adds.rows);

    reply.code(201);
    return { id: serviceId, currentVersion: await loadVersionWithAdditionals(versionId) };
  });

  // Add an additional to the service's CURRENT version — no new version.
  // Safe: existing contracts snapshot their chosen additionals, so they are
  // unaffected; this only makes a new option available going forward.
  // Body: { name, price? }
  app.post('/api/services/:id/additionals', async (req: any, reply) => {
    const serviceId = parseId(req.params.id);
    if (serviceId === null) return badId(reply);
    const cur = await currentVersion(serviceId);
    if (!cur) return reply.code(404).send({ error: 'Serviço/versão não encontrado.' });
    const { name, price } = req.body ?? {};
    if (!name) return badRequest(reply, 'O nome é obrigatório.');
    if (typeof name !== 'string' || name.length > 255) return badRequest(reply, 'Nome inválido (máximo 255 caracteres).');
    const priceVal = parseMoney(price, { emptyAs: 0 });
    if (priceVal === null) return badRequest(reply, 'Preço inválido.');
    await db
      .insert(schema.serviceAdditionals)
      .values({ versionId: cur.id, name, price: String(priceVal) });
    reply.code(201);
    return loadVersionWithAdditionals(cur.id);
  });

  // Remove an additional from the current version (does not touch existing contracts).
  app.delete('/api/services/:id/additionals/:addId', async (req: any, reply) => {
    const addId = parseId(req.params.addId);
    if (addId === null) return badId(reply);
    await db.delete(schema.serviceAdditionals).where(eq(schema.serviceAdditionals.id, addId));
    return reply.code(204).send();
  });

  // Update identity fields only (name/description/active). Prices are versioned.
  app.put('/api/services/:id', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badId(reply);
    const { name, description, active } = req.body ?? {};
    if (name !== undefined && (typeof name !== 'string' || name.trim() === '' || name.length > 255)) {
      return badRequest(reply, 'Nome inválido (obrigatório, máximo 255 caracteres).');
    }
    const descVal = textField(description, 65535);
    if (descVal === false) return badRequest(reply, 'Descrição inválida.');
    if (active !== undefined && typeof active !== 'boolean') return badRequest(reply, 'Valor inválido para "ativo".');
    const set = {
      ...(name !== undefined ? { name } : {}),
      ...(descVal !== undefined ? { description: descVal } : {}),
      ...(active !== undefined ? { active } : {}),
    };
    if (Object.keys(set).length > 0) {
      await db.update(schema.services).set(set).where(eq(schema.services.id, id));
    }
    const [row] = await db.select().from(schema.services).where(eq(schema.services.id, id));
    if (!row) return reply.code(404).send({ error: 'Serviço não encontrado.' });
    return row;
  });

  app.delete('/api/services/:id', async (req: any, reply) => {
    const id = parseId(req.params.id);
    if (id === null) return badId(reply);
    await db.delete(schema.services).where(eq(schema.services.id, id));
    return reply.code(204).send();
  });
}
