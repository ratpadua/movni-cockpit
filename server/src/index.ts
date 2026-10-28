import './env.js';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { schema } from './db/client.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCustomerRoutes } from './routes/customers.js';
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

await app.register(cors, { origin: true });

app.get('/api/health', async () => ({ ok: true, service: 'movni-cockpit' }));

// Session + login (opens the DB connection with the user's credentials).
registerAuthRoutes(app);

// Simple resources via the generic CRUD helper.
registerCrud(app, '/api/customers', schema.customers);
registerCrud(app, '/api/categories', schema.categories);

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
const clientDist = path.resolve(process.cwd(), '..', 'client', 'dist');
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
  // Auto-open the browser only when serving the built app.
  if (fs.existsSync(clientDist) && process.env.NODE_ENV !== 'test') {
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
