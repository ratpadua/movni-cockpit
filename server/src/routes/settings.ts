import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';

const DEFAULTS = {
  menuColor: '#ffffff',
  accentColor: '#228be6',
  bgColor: '#f8f9fa',
  buttonColor: '#228be6',
  buttonHoverColor: '#1c7ed6',
  editWindowDays: 20,
  previewWindowDays: 30,
  minInstallmentValue: 150, // R$ — smallest allowed installment
};

async function getRow() {
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.id, 1));
  return row ?? null;
}

// The configured minimum value of one installment (R$), 150 until the user changes it.
export async function getMinInstallmentValue(): Promise<number> {
  const n = Number((await getRow())?.minInstallmentValue);
  return n > 0 ? n : DEFAULTS.minInstallmentValue;
}

async function ensureRow() {
  const row = await getRow();
  if (!row) {
    await db
      .insert(schema.settings)
      .values({ id: 1, ...DEFAULTS, minInstallmentValue: String(DEFAULTS.minInstallmentValue) });
    return (await getRow())!;
  }
  return row;
}

function present(row: Awaited<ReturnType<typeof getRow>>) {
  return {
    menuColor: row?.menuColor || DEFAULTS.menuColor,
    accentColor: row?.accentColor || DEFAULTS.accentColor,
    bgColor: row?.bgColor || DEFAULTS.bgColor,
    buttonColor: row?.buttonColor || DEFAULTS.buttonColor,
    buttonHoverColor: row?.buttonHoverColor || DEFAULTS.buttonHoverColor,
    editWindowDays: row?.editWindowDays ?? DEFAULTS.editWindowDays,
    previewWindowDays: row?.previewWindowDays ?? DEFAULTS.previewWindowDays,
    minInstallmentValue: Number(row?.minInstallmentValue) > 0 ? Number(row?.minInstallmentValue) : DEFAULTS.minInstallmentValue,
    logo: row?.logo ?? null,
    logoMime: row?.logoMime ?? null,
  };
}

export function registerSettingsRoutes(app: FastifyInstance) {
  app.get('/api/settings', async () => present(await getRow()));

  // Update colors. Body: { menuColor?, accentColor?, bgColor? }
  app.put('/api/settings', async (req: any) => {
    await ensureRow();
    const {
      menuColor,
      accentColor,
      bgColor,
      buttonColor,
      buttonHoverColor,
      editWindowDays,
      previewWindowDays,
      minInstallmentValue,
    } = req.body ?? {};
    await db
      .update(schema.settings)
      .set({
        ...(menuColor !== undefined ? { menuColor } : {}),
        ...(accentColor !== undefined ? { accentColor } : {}),
        ...(bgColor !== undefined ? { bgColor } : {}),
        ...(buttonColor !== undefined ? { buttonColor } : {}),
        ...(buttonHoverColor !== undefined ? { buttonHoverColor } : {}),
        ...(editWindowDays !== undefined ? { editWindowDays: Math.max(0, Number(editWindowDays) || 0) } : {}),
        ...(previewWindowDays !== undefined
          ? { previewWindowDays: Math.max(0, Number(previewWindowDays) || 0) }
          : {}),
        // Must stay positive: it is the divisor of the installment-count limit.
        ...(minInstallmentValue !== undefined
          ? { minInstallmentValue: String(Math.max(1, Number(minInstallmentValue) || DEFAULTS.minInstallmentValue)) }
          : {}),
      })
      .where(eq(schema.settings.id, 1));
    return present(await getRow());
  });

  // Set the logo. Body: { content (base64), mime }
  app.post('/api/settings/logo', async (req: any, reply) => {
    const { content, mime } = req.body ?? {};
    if (!content) return reply.code(400).send({ error: 'imagem (base64) é obrigatória' });
    await ensureRow();
    await db
      .update(schema.settings)
      .set({ logo: content, logoMime: mime ?? 'image/png' })
      .where(eq(schema.settings.id, 1));
    return present(await getRow());
  });

  app.delete('/api/settings/logo', async () => {
    await ensureRow();
    await db.update(schema.settings).set({ logo: null, logoMime: null }).where(eq(schema.settings.id, 1));
    return present(await getRow());
  });
}
