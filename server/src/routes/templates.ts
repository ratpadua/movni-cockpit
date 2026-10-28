import type { FastifyInstance } from 'fastify';
import { eq, desc } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { detectDocFormat, docMime } from '../lib/contract.js';

const KINDS = ['contract', 'invoice', 'receipt'] as const;
type Kind = (typeof KINDS)[number];

// Buffer for a specific template id.
export async function loadTemplateById(id: number | null | undefined): Promise<Buffer | null> {
  if (!id) return null;
  const [t] = await db.select().from(schema.templates).where(eq(schema.templates.id, id));
  return t ? Buffer.from(t.content, 'base64') : null;
}

// Templates are stored exactly as uploaded: Word (.docx) or LibreOffice (.odt).
// An .odt is never converted — documents generated from it stay .odt and are
// exported to PDF from that native format. The format is judged by the file's
// contents, not its name. Throws a user-facing message when the file is invalid.
function checkTemplate(content: string): void {
  if (detectDocFormat(Buffer.from(content, 'base64')) === null) {
    throw new Error('o arquivo não parece ser um .docx ou .odt válido (modelos .ott devem ser salvos como .odt)');
  }
}

export function registerTemplateRoutes(app: FastifyInstance) {
  // List templates (metadata only), newest first.
  app.get('/api/templates', async () => {
    return db
      .select({
        id: schema.templates.id,
        kind: schema.templates.kind,
        name: schema.templates.name,
        fileName: schema.templates.fileName,
        updatedAt: schema.templates.updatedAt,
      })
      .from(schema.templates)
      .orderBy(desc(schema.templates.id));
  });

  // Add a template. Body: { kind, name, fileName, content (base64) }
  app.post('/api/templates', async (req: any, reply) => {
    const { kind, name, fileName, content: rawContent } = req.body ?? {};
    if (!KINDS.includes(kind)) return reply.code(400).send({ error: 'tipo de modelo inválido' });
    if (!rawContent) return reply.code(400).send({ error: 'envie o arquivo do modelo' });

    try {
      checkTemplate(rawContent);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }

    const res: any = await db
      .insert(schema.templates)
      .values({ kind, name: name || `Modelo ${kind}`, fileName: fileName ?? `${kind}.docx`, content: rawContent })
      .$returningId();

    reply.code(201);
    return { id: res[0].id, kind, name };
  });

  // Update name only. Body: { name? }
  app.put('/api/templates/:id', async (req: any, reply) => {
    const id = Number(req.params.id);
    const [t] = await db.select().from(schema.templates).where(eq(schema.templates.id, id));
    if (!t) return reply.code(404).send({ error: 'not found' });
    const { name } = req.body ?? {};
    if (name !== undefined) {
      await db.update(schema.templates).set({ name }).where(eq(schema.templates.id, id));
    }
    const [row] = await db.select().from(schema.templates).where(eq(schema.templates.id, id));
    return row;
  });

  // Download a template by id.
  app.get('/api/templates/:id/download', async (req: any, reply) => {
    const [t] = await db.select().from(schema.templates).where(eq(schema.templates.id, Number(req.params.id)));
    if (!t) return reply.code(404).send({ error: 'not found' });
    const buf = Buffer.from(t.content, 'base64');
    reply.header('Content-Disposition', `attachment; filename="${t.fileName}"`);
    reply.type(docMime(detectDocFormat(buf) ?? 'docx'));
    return reply.send(buf);
  });

  // Replace a template's file IN PLACE (same id, so every contract/invoice that
  // references it keeps working and now uses the new content). This is how a
  // template is updated.
  // Body: { content (base64), fileName? }
  app.put('/api/templates/:id/content', async (req: any, reply) => {
    const id = Number(req.params.id);
    const [t] = await db.select().from(schema.templates).where(eq(schema.templates.id, id));
    if (!t) return reply.code(404).send({ error: 'not found' });
    const { content: rawContent, fileName: rawFileName } = req.body ?? {};
    if (!rawContent) return reply.code(400).send({ error: 'envie o arquivo do modelo' });
    try {
      checkTemplate(rawContent);
    } catch (e: any) {
      return reply.code(400).send({ error: e.message });
    }
    await db
      .update(schema.templates)
      .set({ content: rawContent, ...(rawFileName ? { fileName: rawFileName } : {}) })
      .where(eq(schema.templates.id, id));
    const [row] = await db
      .select({
        id: schema.templates.id,
        kind: schema.templates.kind,
        name: schema.templates.name,
        fileName: schema.templates.fileName,
        updatedAt: schema.templates.updatedAt,
      })
      .from(schema.templates)
      .where(eq(schema.templates.id, id));
    return row;
  });

  // Delete a template. If it is referenced by contracts/invoices, deletion is
  // blocked — the user should replace its file instead (PUT :id/content), which
  // keeps references intact.
  app.delete('/api/templates/:id', async (req: any, reply) => {
    const id = Number(req.params.id);
    const [t] = await db.select().from(schema.templates).where(eq(schema.templates.id, id));
    if (!t) return reply.code(204).send();

    const inUse = await countReferences(t.kind as Kind, id);
    if (inUse > 0) {
      return reply.code(409).send({
        error: `Modelo em uso por ${inUse} contrato(s). Use “Substituir” para trocar o arquivo mantendo os vínculos.`,
        inUse,
      });
    }

    await db.delete(schema.templates).where(eq(schema.templates.id, id));
    return reply.code(204).send();
  });
}

// Count contracts referencing this template (by kind: contract, invoice or receipt template).
async function countReferences(kind: Kind, id: number): Promise<number> {
  const field =
    kind === 'invoice'
      ? schema.contracts.invoiceTemplateId
      : kind === 'receipt'
        ? schema.contracts.receiptTemplateId
        : schema.contracts.templateId;
  const rows = await db.select({ id: schema.contracts.id }).from(schema.contracts).where(eq(field, id));
  return rows.length;
}
