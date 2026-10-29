import '../env.js';
import mysql from 'mysql2/promise';
import { dbSslOption } from './client.js';

// Idempotent, non-destructive schema catch-up for an EXISTING database (e.g. the
// live production DB whose Drizzle migration history differs from dev). It only
// creates missing tables, adds missing columns, and adds missing foreign keys —
// it never drops or alters existing data, and does not touch the
// __drizzle_migrations table.
//
// Target comes from .env (DB_HOST/DB_PORT/DB_NAME); credentials from .env.local
// (DB_USER/DB_PASS). Point those at production, then: npm run db:add-columns

// New tables (created with their own-row FKs inline). CREATE TABLE IF NOT EXISTS
// is inherently idempotent.
const TABLES: { table: string; ddl: string }[] = [
  {
    table: 'customer_credits',
    ddl: `CREATE TABLE IF NOT EXISTS \`customer_credits\` (
      \`id\` int AUTO_INCREMENT NOT NULL,
      \`customer_id\` int NOT NULL,
      \`description\` varchar(255) NOT NULL,
      \`value\` decimal(12,2) NOT NULL DEFAULT '0',
      \`remaining\` decimal(12,2) NOT NULL DEFAULT '0',
      \`created_at\` timestamp NOT NULL DEFAULT (now()),
      CONSTRAINT \`customer_credits_id\` PRIMARY KEY(\`id\`),
      CONSTRAINT \`customer_credits_customer_id_customers_id_fk\`
        FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\`(\`id\`) ON DELETE cascade ON UPDATE no action
    )`,
  },
  {
    table: 'invoice_modifiers',
    ddl: `CREATE TABLE IF NOT EXISTS \`invoice_modifiers\` (
      \`id\` int AUTO_INCREMENT NOT NULL,
      \`invoice_id\` int NOT NULL,
      \`name\` varchar(255) NOT NULL,
      \`price\` decimal(12,2) NOT NULL DEFAULT '0',
      \`discount_percent\` decimal(5,2) NOT NULL DEFAULT '0',
      CONSTRAINT \`invoice_modifiers_id\` PRIMARY KEY(\`id\`),
      CONSTRAINT \`invoice_modifiers_invoice_id_invoices_id_fk\`
        FOREIGN KEY (\`invoice_id\`) REFERENCES \`invoices\`(\`id\`) ON DELETE cascade ON UPDATE no action
    )`,
  },
];

const COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'settings', column: 'button_color', ddl: 'ADD COLUMN `button_color` varchar(16) NULL' },
  { table: 'settings', column: 'button_hover_color', ddl: 'ADD COLUMN `button_hover_color` varchar(16) NULL' },
  { table: 'contracts', column: 'duration', ddl: 'ADD COLUMN `duration` varchar(128) NULL' },
  { table: 'contracts', column: 'quantity', ddl: 'ADD COLUMN `quantity` int NULL' },
  // 0002 — modifiers discount, customer credits, contract statuses, invoice ref + status windows.
  {
    table: 'contract_modifiers',
    column: 'discount_percent',
    ddl: "ADD COLUMN `discount_percent` decimal(5,2) NOT NULL DEFAULT '0'",
  },
  { table: 'contracts', column: 'credit_id', ddl: 'ADD COLUMN `credit_id` int NULL' },
  { table: 'contracts', column: 'credit_applied', ddl: "ADD COLUMN `credit_applied` decimal(12,2) NOT NULL DEFAULT '0'" },
  {
    table: 'contracts',
    column: 'status',
    ddl: "ADD COLUMN `status` enum('aguardando_pagamento','agendado','realizado','em_edicao','enviado','finalizado') NOT NULL DEFAULT 'aguardando_pagamento'",
  },
  {
    table: 'contracts',
    column: 'status_changed_at',
    ddl: 'ADD COLUMN `status_changed_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP',
  },
  { table: 'invoices', column: 'ref_number', ddl: 'ADD COLUMN `ref_number` varchar(16) NULL' },
  { table: 'invoices', column: 'credit_id', ddl: 'ADD COLUMN `credit_id` int NULL' },
  { table: 'invoices', column: 'credit_applied', ddl: "ADD COLUMN `credit_applied` decimal(12,2) NOT NULL DEFAULT '0'" },
  { table: 'settings', column: 'edit_window_days', ddl: 'ADD COLUMN `edit_window_days` int NOT NULL DEFAULT 20' },
  { table: 'settings', column: 'preview_window_days', ddl: 'ADD COLUMN `preview_window_days` int NOT NULL DEFAULT 30' },
  // Recurring payments: shared id of the payments created by one recurrence.
  { table: 'payments', column: 'recurrence_id', ddl: 'ADD COLUMN `recurrence_id` varchar(36) NULL' },
  // Configurable minimum value of one installment.
  {
    table: 'settings',
    column: 'min_installment_value',
    ddl: "ADD COLUMN `min_installment_value` decimal(12,2) NOT NULL DEFAULT '150'",
  },
  // Per-contract receipt model (multiple receipt templates are allowed).
  { table: 'contracts', column: 'receipt_template_id', ddl: 'ADD COLUMN `receipt_template_id` int NULL' },
  // Bank import: original statement date/amount (for "already imported" detection).
  { table: 'transactions', column: 'orig_date', ddl: 'ADD COLUMN `orig_date` date NULL' },
  { table: 'transactions', column: 'orig_amount', ddl: 'ADD COLUMN `orig_amount` decimal(12,2) NULL' },
];

// Cross-table FKs added after the columns/tables exist (credit_id -> customer_credits).
const CONSTRAINTS: { table: string; name: string; ddl: string }[] = [
  {
    table: 'contracts',
    name: 'contracts_credit_id_customer_credits_id_fk',
    ddl: 'ADD CONSTRAINT `contracts_credit_id_customer_credits_id_fk` FOREIGN KEY (`credit_id`) REFERENCES `customer_credits`(`id`) ON DELETE set null ON UPDATE no action',
  },
  {
    table: 'contracts',
    name: 'contracts_receipt_template_id_templates_id_fk',
    ddl: 'ADD CONSTRAINT `contracts_receipt_template_id_templates_id_fk` FOREIGN KEY (`receipt_template_id`) REFERENCES `templates`(`id`) ON DELETE set null ON UPDATE no action',
  },
  {
    table: 'invoices',
    name: 'invoices_credit_id_customer_credits_id_fk',
    ddl: 'ADD CONSTRAINT `invoices_credit_id_customer_credits_id_fk` FOREIGN KEY (`credit_id`) REFERENCES `customer_credits`(`id`) ON DELETE set null ON UPDATE no action',
  },
];

async function main() {
  const host = process.env.DB_HOST;
  const database = process.env.DB_NAME;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASS;
  const port = Number(process.env.DB_PORT ?? 3306);
  if (!host || !database || !user || !password) {
    throw new Error('DB_HOST/DB_NAME (do .env) e DB_USER/DB_PASS (do .env.local) são obrigatórios.');
  }

  const conn = await mysql.createConnection({ host, port, database, user, password, ...dbSslOption() });
  console.log(`Target DB: "${database}" @ ${host}`);

  // 1) Tables (IF NOT EXISTS — idempotent on its own).
  for (const t of TABLES) {
    const [rows] = await conn.query<any[]>(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
      [database, t.table]
    );
    if (rows.length > 0) {
      console.log(`  ok     tabela ${t.table} — já existe`);
      continue;
    }
    await conn.query(t.ddl);
    console.log(`  criada tabela ${t.table}`);
  }

  // 2) Columns.
  let added = 0;
  for (const c of COLUMNS) {
    const [rows] = await conn.query<any[]>(
      'SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
      [database, c.table, c.column]
    );
    if (rows.length > 0) {
      console.log(`  ok     ${c.table}.${c.column} — já existe`);
      continue;
    }
    await conn.query(`ALTER TABLE \`${c.table}\` ${c.ddl}`);
    console.log(`  added  ${c.table}.${c.column}`);
    added++;
  }

  // 3) Cross-table foreign keys (after their columns/tables exist).
  let fks = 0;
  for (const k of CONSTRAINTS) {
    const [rows] = await conn.query<any[]>(
      'SELECT 1 FROM information_schema.table_constraints WHERE table_schema = ? AND table_name = ? AND constraint_name = ?',
      [database, k.table, k.name]
    );
    if (rows.length > 0) {
      console.log(`  ok     FK ${k.name} — já existe`);
      continue;
    }
    await conn.query(`ALTER TABLE \`${k.table}\` ${k.ddl}`);
    console.log(`  added  FK ${k.name}`);
    fks++;
  }

  console.log(`Done. ${added} coluna(s) e ${fks} chave(s) estrangeira(s) adicionada(s).`);
  await conn.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
