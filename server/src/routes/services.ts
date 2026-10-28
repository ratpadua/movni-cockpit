import type { FastifyInstance } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

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

async function insertAdditionals(versionId: number, additionals: any[] | undefined) {
  if (Array.isArray(additionals) && additionals.length > 0) {
    await db.insert(schema.serviceAdditionals).values(
      additionals
        .filter((m) => m && m.name)
        .map((m) => ({ versionId, name: m.name, price: String(m.price ?? 0) }))
    );
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
    const id = Number(req.params.id);
    const [service] = await db.select().from(schema.services).where(eq(schema.services.id, id));
    if (!service) return reply.code(404).send({ error: 'not found' });
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
    if (!name) return reply.code(400).send({ error: 'name is required' });

    const svcRes: any = await db
      .insert(schema.services)
      .values({ name, description: description ?? null })
      .$returningId();
    const serviceId = svcRes[0].id;

    const verRes: any = await db
      .insert(schema.serviceVersions)
      .values({ serviceId, version: 1, basePrice: String(basePrice ?? 0), notes: notes ?? null, active: true })
      .$returningId();
    const versionId = verRes[0].id;

    await insertAdditionals(versionId, additionals);

    reply.code(201);
    return { id: serviceId, currentVersion: await loadVersionWithAdditionals(versionId) };
  });

  // Create a NEW version of an existing service (price/additional change).
  // Previous versions are retained but deactivated, so contracts keep their prices.
  // Body: { basePrice, notes?, additionals?: [{name, price}] }
  app.post('/api/services/:id/version', async (req: any, reply) => {
    const serviceId = Number(req.params.id);
    const [service] = await db.select().from(schema.services).where(eq(schema.services.id, serviceId));
    if (!service) return reply.code(404).send({ error: 'service not found' });

    const { basePrice, notes, additionals } = req.body ?? {};

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
        basePrice: String(basePrice ?? 0),
        notes: notes ?? null,
        active: true,
      })
      .$returningId();
    const versionId = verRes[0].id;

    await insertAdditionals(versionId, additionals);

    reply.code(201);
    return { id: serviceId, currentVersion: await loadVersionWithAdditionals(versionId) };
  });

  // Add an additional to the service's CURRENT version — no new version.
  // Safe: existing contracts snapshot their chosen additionals, so they are
  // unaffected; this only makes a new option available going forward.
  // Body: { name, price? }
  app.post('/api/services/:id/additionals', async (req: any, reply) => {
    const serviceId = Number(req.params.id);
    const cur = await currentVersion(serviceId);
    if (!cur) return reply.code(404).send({ error: 'service/version not found' });
    const { name, price } = req.body ?? {};
    if (!name) return reply.code(400).send({ error: 'name is required' });
    await db
      .insert(schema.serviceAdditionals)
      .values({ versionId: cur.id, name, price: String(price ?? 0) });
    reply.code(201);
    return loadVersionWithAdditionals(cur.id);
  });

  // Remove an additional from the current version (does not touch existing contracts).
  app.delete('/api/services/:id/additionals/:addId', async (req: any, reply) => {
    const addId = Number(req.params.addId);
    await db.delete(schema.serviceAdditionals).where(eq(schema.serviceAdditionals.id, addId));
    return reply.code(204).send();
  });

  // Update identity fields only (name/description/active). Prices are versioned.
  app.put('/api/services/:id', async (req: any, reply) => {
    const id = Number(req.params.id);
    const { name, description, active } = req.body ?? {};
    await db
      .update(schema.services)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(active !== undefined ? { active } : {}),
      })
      .where(eq(schema.services.id, id));
    const [row] = await db.select().from(schema.services).where(eq(schema.services.id, id));
    if (!row) return reply.code(404).send({ error: 'not found' });
    return row;
  });

  app.delete('/api/services/:id', async (req: any, reply) => {
    const id = Number(req.params.id);
    await db.delete(schema.services).where(eq(schema.services.id, id));
    return reply.code(204).send();
  });
}
