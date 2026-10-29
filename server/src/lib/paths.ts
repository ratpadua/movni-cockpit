import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root derived from this file's location (server/src/lib -> ../../..), so
// it does not depend on the process working directory (same approach as env.ts).
const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..', '..');
