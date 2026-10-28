import '../env.js';
import mysql from 'mysql2/promise';

// Drops ALL tables in the target database. Safe for dev only.
// Credentials come from .env.local (DB_USER/DB_PASS); target from .env.
async function main() {
  const host = process.env.DB_HOST;
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASS;
  const port = Number(process.env.DB_PORT ?? 3306);
  if (!host || !database || !user || !password) {
    throw new Error(
      'DB_HOST/DB_NAME (do .env) e DB_USER/DB_PASS (do .env.local) são obrigatórios para o reset.'
    );
  }

  const conn = await mysql.createConnection({ host, port, database, user, password });

  console.log(`Dropping all tables in "${database}"...`);
  const [rows] = await conn.query<any[]>(
    'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ?',
    [database]
  );

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const r of rows) {
    const table = r.t ?? r.table_name ?? r.TABLE_NAME;
    await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
    console.log(`  dropped ${table}`);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  console.log('Done.');
  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
