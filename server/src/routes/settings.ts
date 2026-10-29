import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { badRequest } from '../lib/validate.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
// Logo: base64 text of an image (~3 MB of image data) and a known image type.
const MAX_LOGO_BASE64 = 4 * 1024 * 1024;
const LOGO_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon'];

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
  app.put('/api/settings', async (req: any, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return badRequest(reply, 'Dados inválidos.');
    }
    const {
      menuColor,
      accentColor,
      bgColor,
      buttonColor,
      buttonHoverColor,
      editWindowDays,
      previewWindowDays,
      minInstallmentValue,
    } = body;

    // Colours: "#rrggbb" (an empty value resets to the default).
    const colors: Record<string, string | null> = {};
    for (const [key, label, v] of [
      ['menuColor', 'do menu', menuColor],
      ['accentColor', 'de destaque', accentColor],
      ['bgColor', 'de fundo', bgColor],
      ['buttonColor', 'dos botões', buttonColor],
      ['buttonHoverColor', 'dos botões (hover)', buttonHoverColor],
    ] as const) {
      if (v === undefined) continue;
      if (v === null || v === '') colors[key] = null;
      else if (typeof v === 'string' && COLOR_RE.test(v)) colors[key] = v;
      else if (typeof v === 'string' && /^#[0-9a-f]{3}$/i.test(v)) {
        colors[key] = '#' + [...v.slice(1)].map((c) => c + c).join(''); // #fff -> #ffffff
      }
      else return badRequest(reply, `Cor ${label} inválida (use o formato #RRGGBB).`);
    }

    // Day counts: finite numbers (non-numeric text counted as 0 before; now a 400).
    const days: Record<string, number> = {};
    for (const [key, label, v] of [
      ['editWindowDays', 'Em edição', editWindowDays],
      ['previewWindowDays', 'Enviado', previewWindowDays],
    ] as const) {
      if (v === undefined) continue;
      const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
      if (!Number.isFinite(n) || n > 3650) return badRequest(reply, `Prazo "${label}" inválido.`);
      days[key] = Math.max(0, Math.floor(n));
    }

    let minInst: string | undefined;
    if (minInstallmentValue !== undefined) {
      const n = typeof minInstallmentValue === 'number' || typeof minInstallmentValue === 'string' ? Number(minInstallmentValue) : NaN;
      if (!Number.isFinite(n) || n > 1e7) return badRequest(reply, 'Valor mínimo da parcela inválido.');
      // Must stay positive: it is the divisor of the installment-count limit.
      minInst = String(Math.max(1, n || DEFAULTS.minInstallmentValue));
    }

    await ensureRow();
    const set = { ...colors, ...days, ...(minInst !== undefined ? { minInstallmentValue: minInst } : {}) };
    if (Object.keys(set).length > 0) {
      await db.update(schema.settings).set(set).where(eq(schema.settings.id, 1));
    }
    return present(await getRow());
  });

  // Set the logo. Body: { content (base64), mime }
  app.post('/api/settings/logo', async (req: any, reply) => {
    const { content, mime } = req.body ?? {};
    if (!content) return reply.code(400).send({ error: 'imagem (base64) é obrigatória' });
    if (typeof content !== 'string' || !/^[A-Za-z0-9+/=\s]+$/.test(content)) {
      return badRequest(reply, 'Imagem inválida.');
    }
    if (content.length > MAX_LOGO_BASE64) {
      return badRequest(reply, 'A imagem é grande demais (máximo de cerca de 3 MB).');
    }
    const logoMime = mime == null || mime === '' ? 'image/png' : mime;
    if (typeof logoMime !== 'string' || !LOGO_MIMES.includes(logoMime.toLowerCase())) {
      return badRequest(reply, 'Tipo de imagem não suportado (use PNG, JPEG, GIF, WebP ou SVG).');
    }
    await ensureRow();
    await db
      .update(schema.settings)
      .set({ logo: content, logoMime: logoMime.toLowerCase() })
      .where(eq(schema.settings.id, 1));
    return present(await getRow());
  });

  app.delete('/api/settings/logo', async () => {
    await ensureRow();
    await db.update(schema.settings).set({ logo: null, logoMime: null }).where(eq(schema.settings.id, 1));
    return present(await getRow());
  });
}
