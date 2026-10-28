import '../env.js';
import { connectFromEnv, disconnectDb, db, schema } from './client.js';

// Seeds a handful of default categories so the bank-import dropdown is useful
// out of the box. Safe to run repeatedly (skips names that already exist).
const DEFAULT_CATEGORIES: { name: string; flow: 'in' | 'out' | null }[] = [
  { name: 'Receita de serviço', flow: 'in' },
  { name: 'Recebimento de cliente', flow: 'in' },
  { name: 'Salários', flow: 'out' },
  { name: 'Impostos', flow: 'out' },
  { name: 'Fornecedores', flow: 'out' },
  { name: 'Aluguel', flow: 'out' },
  { name: 'Tarifas bancárias', flow: 'out' },
  { name: 'Operacional', flow: 'out' }, // operational costs not tied to a client/contract
  { name: 'Outros', flow: null },
];

async function main() {
  console.log('Seeding categories...');
  await connectFromEnv();
  const existing = await db.select({ name: schema.categories.name }).from(schema.categories);
  const have = new Set(existing.map((c) => c.name));
  const toInsert = DEFAULT_CATEGORIES.filter((c) => !have.has(c.name));
  if (toInsert.length > 0) {
    await db.insert(schema.categories).values(toInsert);
  }
  console.log(`Seed complete (${toInsert.length} new categories).`);
  await disconnectDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
