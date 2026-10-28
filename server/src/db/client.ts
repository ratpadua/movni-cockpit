import '../env.js';
import mysql from 'mysql2/promise';
import { drizzle, type MySql2Database } from 'drizzle-orm/mysql2';
import * as schema from './schema.js';

export { schema };

type DrizzleDb = MySql2Database<typeof schema>;

// The connection is NOT opened at startup. Credentials are supplied at login
// (POST /api/login) so they never live in .env or the shipped bundle.
let activePool: mysql.Pool | null = null;
let activeDb: DrizzleDb | null = null;

// Non-secret connection target (host/port/database) comes from .env.
export function dbConfig() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    database: process.env.DB_NAME,
  };
}

// Open (or replace) the active connection with the given credentials. Verifies
// connectivity with a SELECT 1 before adopting the pool; throws on failure.
export async function connectDb(user: string, password: string): Promise<void> {
  const cfg = dbConfig();
  if (!cfg.host || !cfg.database) {
    throw new Error('DB_HOST/DB_NAME não configurados no .env.');
  }
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user,
    password,
    connectionLimit: 8,
  });
  // Verify before adopting so a bad password doesn't leave a broken pool active.
  const conn = await pool.getConnection();
  try {
    await conn.query('select 1');
  } finally {
    conn.release();
  }
  const old = activePool;
  activePool = pool;
  activeDb = drizzle(pool, { schema, mode: 'default' });
  if (old) await old.end().catch(() => {});
}

// For CLI scripts (migrate/seed/reset): connect using DB_USER/DB_PASS from
// .env.local. The running app never calls this.
export async function connectFromEnv(): Promise<void> {
  const user = process.env.DB_USER;
  const password = process.env.DB_PASS;
  if (!user || !password) {
    throw new Error(
      'DB_USER/DB_PASS ausentes. Crie um arquivo .env.local (não versionado) com as credenciais para rodar scripts.'
    );
  }
  await connectDb(user, password);
}

export async function disconnectDb(): Promise<void> {
  const old = activePool;
  activePool = null;
  activeDb = null;
  if (old) await old.end().catch(() => {});
}

export function isConnected(): boolean {
  return activeDb != null;
}

// Live connectivity check used by /api/session.
export async function pingDb(): Promise<boolean> {
  if (!activePool) return false;
  try {
    const conn = await activePool.getConnection();
    try {
      await conn.query('select 1');
    } finally {
      conn.release();
    }
    return true;
  } catch {
    return false;
  }
}

// Raw active instance for tools (migrator) that need the concrete object.
export function requireDb(): DrizzleDb {
  if (!activeDb) throw new Error('Banco de dados não conectado.');
  return activeDb;
}

// Proxy so existing `import { db }` across all routes keeps working unchanged.
// Any query before login throws a clear error instead of using stale creds.
export const db = new Proxy({} as DrizzleDb, {
  get(_t, prop) {
    if (!activeDb) throw new Error('Banco de dados não conectado. Faça login.');
    const v = (activeDb as any)[prop];
    return typeof v === 'function' ? v.bind(activeDb) : v;
  },
});
