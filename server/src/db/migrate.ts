import '../env.js';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { connectFromEnv, disconnectDb, requireDb } from './client.js';

async function main() {
  console.log('Running migrations...');
  await connectFromEnv();
  await migrate(requireDb(), { migrationsFolder: './drizzle' });
  console.log('Migrations complete.');
  await disconnectDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
