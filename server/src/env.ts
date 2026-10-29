import { config } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load the project-root .env no matter what the process working directory is
// (server scripts run with cwd = server/, so a bare `dotenv/config` would miss
// the root file). server/src/env.ts -> ../../.env == <project root>/.env
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
config({ path: path.resolve(root, '.env') });
// Optional, gitignored, NOT shipped: holds DB_USER/DB_PASS for CLI scripts
// (migrate/seed/reset). The running app never needs it — credentials come from
// the login screen instead.
config({ path: path.resolve(root, '.env.local'), override: true });
// Opt-in (DB_TARGET=local): gitignored .env.test points at the local Docker MySQL used for tests.
if (process.env.DB_TARGET === 'local') config({ path: path.resolve(root, '.env.test'), override: true });
