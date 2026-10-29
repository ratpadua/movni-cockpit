import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

// Load the project-root .env (+ optional .env.local with credentials for CLI).
const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '..', '.env') });
config({ path: path.resolve(here, '..', '.env.local'), override: true });
if (process.env.DB_TARGET === 'local') config({ path: path.resolve(here, '..', '.env.test'), override: true });

// `db:generate` reads only the schema and needs no live connection. For
// `db:push`/introspect, provide DB_USER/DB_PASS via .env.local.
const url =
  process.env.DATABASE_URL ??
  `mysql://${process.env.DB_USER ?? ''}:${process.env.DB_PASS ?? ''}@${process.env.DB_HOST ?? 'localhost'}:${
    process.env.DB_PORT ?? 3306
  }/${process.env.DB_NAME ?? ''}`;

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'mysql',
  dbCredentials: { url },
});
