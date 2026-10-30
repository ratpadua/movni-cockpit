import './env.js';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { schema, isConnected } from './db/client.js';
import { PROJECT_ROOT } from './lib/paths.js';
import { CONTACT_METHODS, FLOWS, parseId } from './lib/validate.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCustomerRoutes, customerDeleteBlock } from './routes/customers.js';
import { registerCrud } from './lib/crud.js';
import { registerBankRoutes } from './routes/bank.js';
import { registerContractRoutes } from './routes/contracts.js';
import { registerServiceRoutes } from './routes/services.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerReceiptRoutes } from './routes/receipts.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerPaymentRoutes } from './routes/payments.js';

const PORT = Number(process.env.PORT ?? 5178);

const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });

// ---- Local-only access control ------------------------------------------------
// The server only listens on 127.0.0.1, but a web page opened in the user's browser
// could still call it (CSRF / DNS rebinding). So: only our own origins may call the
// API, and only requests addressed to localhost/127.0.0.1 are served. The Vite dev
// client (port 5173) proxies /api here and forwards its own Host/Origin.
// ([::1] and LAN-IP hosts are intentionally blocked.)
const DEV_CLIENT_PORT = 5173;
const ALLOWED_ORIGINS = [
  `http://localhost:${DEV_CLIENT_PORT}`,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${DEV_CLIENT_PORT}`,
  `http://127.0.0.1:${PORT}`,
];
const ALLOWED_HOSTS = new Set(ALLOWED_ORIGINS.map((o) => o.replace('http://', '')));

// Registered before CORS so it also guards preflight requests.
app.addHook('onRequest', async (req, reply) => {
  const host = String(req.headers.host ?? '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return reply.code(403).send({ error: 'Acesso negado: endereço não permitido.' });
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.includes(String(origin).toLowerCase())) {
    return reply.code(403).send({ error: 'Acesso negado: origem não permitida.' });
  }
});

await app.register(cors, { origin: ALLOWED_ORIGINS });

// ---- /api guard ------------------------------------------------------------------
// Everything under /api needs an open DB session (i.e. a login), except these.
const OPEN_API = new Set(['/api/health', '/api/session', '/api/login', '/api/logout']);
// Every route parameter in this app is a numeric row id.
const ID_PARAMS = ['id', 'itemId', 'addId', 'creditId'];
app.addHook('preHandler', async (req, reply) => {
  const p = (req.raw.url ?? '').split('?')[0];
  if (!p.startsWith('/api/') || OPEN_API.has(p)) return;
  if (!isConnected()) {
    return reply.code(401).send({ error: 'Sessão não iniciada. Faça login novamente.' });
  }
  const params: any = req.params ?? {};
  for (const k of ID_PARAMS) {
    if (params[k] !== undefined && parseId(params[k]) == null) {
      return reply.code(400).send({ error: 'Identificador inválido.' });
    }
  }
});

// ---- Global error handler ----------------------------------------------------------
// Never echo raw DB/SQL/driver text to the client: log it here and answer with a
// generic pt-BR message. Explicit `reply.code(4xx).send(...)` in routes bypasses this.
app.setErrorHandler((err: any, req, reply) => {
  req.log.error({ err }, 'request failed');
  const db = err?.cause ?? err; // drizzle may wrap the mysql2 error in `cause`
  const code: string | undefined = db?.code ?? err?.code;
  if (code === 'ER_DUP_ENTRY') {
    return reply.code(409).send({ error: 'Já existe um registro com esses dados.' });
  }
  if (code === 'ER_ROW_IS_REFERENCED' || code === 'ER_ROW_IS_REFERENCED_2') {
    return reply.code(409).send({ error: 'Este registro está em uso e não pode ser excluído.' });
  }
  if (code === 'ER_NO_REFERENCED_ROW' || code === 'ER_NO_REFERENCED_ROW_2') {
    return reply.code(400).send({ error: 'Registro relacionado não encontrado.' });
  }
  if (
    code === 'ER_DATA_TOO_LONG' ||
    code === 'ER_BAD_NULL_ERROR' ||
    code === 'ER_TRUNCATED_WRONG_VALUE' ||
    code === 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD' ||
    code === 'ER_WARN_DATA_OUT_OF_RANGE' ||
    code === 'ER_DATA_OUT_OF_RANGE' ||
    code === 'WARN_DATA_TRUNCATED'
  ) {
    return reply.code(400).send({ error: 'Um dos campos tem valor inválido ou grande demais.' });
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'ER_ACCESS_DENIED_ERROR'
  ) {
    return reply.code(503).send({ error: 'Não foi possível comunicar com o banco de dados.' });
  }
  const status = Number(err?.statusCode);
  if (status === 413) return reply.code(413).send({ error: 'Os dados enviados são grandes demais.' });
  if (status >= 400 && status < 500) return reply.code(status).send({ error: 'Requisição inválida.' });
  return reply.code(500).send({ error: 'Erro interno do servidor. Tente novamente.' });
});

app.get('/api/health', async () => ({ ok: true, service: 'movni-cockpit' }));

// Session + login (opens the DB connection with the user's credentials).
registerAuthRoutes(app);

// Simple resources via the generic CRUD helper.
registerCrud(app, '/api/customers', schema.customers, {
  name: { kind: 'string', label: 'Nome', max: 255, required: true },
  nickname: { kind: 'string', label: 'Apelido', max: 255 },
  address: { kind: 'string', label: 'Endereço', max: 512 },
  neighborhood: { kind: 'string', label: 'Bairro', max: 255 },
  city: { kind: 'string', label: 'Cidade', max: 255 },
  state: { kind: 'string', label: 'Estado', max: 64 },
  email: { kind: 'string', label: 'E-mail', max: 255 },
  phone: { kind: 'string', label: 'Telefone', max: 64 },
  whatsapp: { kind: 'string', label: 'WhatsApp', max: 64 },
  preferredContact: { kind: 'enum', label: 'Contato preferido', values: CONTACT_METHODS },
  document: { kind: 'string', label: 'Documento', max: 64 },
}, {
  // Business rule: a customer with contracts, payments or credits cannot be deleted.
  beforeDelete: customerDeleteBlock,
});
registerCrud(app, '/api/categories', schema.categories, {
  name: { kind: 'string', label: 'Nome', max: 255, required: true },
  flow: { kind: 'enum', label: 'Tipo', values: FLOWS },
});

// Customer credits + pending charges.
registerCustomerRoutes(app);

// Feature-specific routes.
registerServiceRoutes(app); // catalog with versions + modifiers
registerBankRoutes(app);
registerContractRoutes(app);
registerPaymentRoutes(app);
registerTemplateRoutes(app);
registerReceiptRoutes(app);
registerSettingsRoutes(app);

// Serve the built client if present (production / `npm start`).
const clientDist = path.resolve(PROJECT_ROOT, 'client', 'dist');
if (fs.existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist });
  app.setNotFoundHandler((req, reply) => {
    // SPA fallback for non-API routes.
    if (req.raw.url?.startsWith('/api')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

try {
  await app.listen({ port: PORT, host: '127.0.0.1' });
  const url = `http://localhost:${PORT}`;
  app.log.info(`movni-cockpit running at ${url}`);
  // Opt-in: only the portable bundle's start.cmd sets OPEN_BROWSER=1.
  if (process.env.OPEN_BROWSER === '1' && fs.existsSync(clientDist) && process.env.NODE_ENV !== 'test') {
    const opener =
      process.platform === 'win32'
        ? `start "" "${url}"`
        : process.platform === 'darwin'
          ? `open "${url}"`
          : `xdg-open "${url}"`;
    exec(opener);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
