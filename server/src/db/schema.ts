import {
  mysqlTable,
  int,
  varchar,
  text,
  boolean,
  decimal,
  date,
  timestamp,
  mysqlEnum,
  customType,
} from 'drizzle-orm/mysql-core';
import { relations } from 'drizzle-orm';

// LONGTEXT column (MySQL) — used to hold base64-encoded .docx templates.
const longtext = customType<{ data: string }>({ dataType: () => 'longtext' });

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const FLOWS = ['in', 'out'] as const; // money in (profit) | out (cost)
const PAYMENT_STATUS = ['upcoming', 'done'] as const; // used by saída (cost) payments
const RECEIPT_STATUS = ['open', 'received', 'sent'] as const; // entrada receipt lifecycle
const CONTACT_METHODS = ['whatsapp', 'email'] as const; // preferred contact
const CONTRACT_TYPES = ['contract', 'invoice'] as const; // one-time signed | recurring monthly
// One-time contract workflow (photography pipeline). Order matters — transitions
// advance/revert one step. em_edicao and previas_enviadas are time-boxed (SLA).
export const CONTRACT_STATUSES = [
  'aguardando_pagamento',
  'agendado',
  'realizado',
  'em_edicao',
  'enviado',
  'finalizado',
] as const;

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export const customers = mysqlTable('customers', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  nickname: varchar('nickname', { length: 255 }),
  // Address split into parts
  address: varchar('address', { length: 512 }), // logradouro + número
  neighborhood: varchar('neighborhood', { length: 255 }), // bairro
  city: varchar('city', { length: 255 }), // cidade
  state: varchar('state', { length: 64 }), // estado / UF
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 64 }), // free format, e.g. +55 48 99999-9999
  whatsapp: varchar('whatsapp', { length: 64 }), // WhatsApp number/user
  preferredContact: mysqlEnum('preferred_contact', CONTACT_METHODS),
  document: varchar('document', { length: 64 }), // CPF / CNPJ
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Prepaid credits a customer can spend on future contracts/faturas.
export const customerCredits = mysqlTable('customer_credits', {
  id: int('id').autoincrement().primaryKey(),
  customerId: int('customer_id')
    .references(() => customers.id, { onDelete: 'cascade' })
    .notNull(),
  description: varchar('description', { length: 255 }).notNull(),
  value: decimal('value', { precision: 12, scale: 2 }).notNull().default('0'), // original amount
  remaining: decimal('remaining', { precision: 12, scale: 2 }).notNull().default('0'), // left to spend
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Services catalog (NOT linked to a customer)
//   services            = the logical product/service identity (stable)
//   service_versions    = a priced snapshot; editing price/modifiers makes a
//                         NEW version so historical contracts keep their prices
//   service_modifiers   = predefined add-ons for a version, each with a price
// ---------------------------------------------------------------------------

export const services = mysqlTable('services', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const serviceVersions = mysqlTable('service_versions', {
  id: int('id').autoincrement().primaryKey(),
  serviceId: int('service_id')
    .references(() => services.id, { onDelete: 'cascade' })
    .notNull(),
  version: int('version').notNull().default(1),
  basePrice: decimal('base_price', { precision: 12, scale: 2 }).notNull().default('0'),
  active: boolean('active').notNull().default(true), // the current version for new contracts
  notes: varchar('notes', { length: 512 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Additionals: catalog add-ons for a service version (name + unit price).
// On a contract you pick additionals and set a quantity for each.
export const serviceAdditionals = mysqlTable('service_additionals', {
  id: int('id').autoincrement().primaryKey(),
  versionId: int('version_id')
    .references(() => serviceVersions.id, { onDelete: 'cascade' })
    .notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  price: decimal('price', { precision: 12, scale: 2 }).notNull().default('0'), // unit price
});

// ---------------------------------------------------------------------------
// Contracts (links a customer to catalog services with chosen modifiers)
//   contract_items          = one catalog service on the contract (snapshotted)
//   contract_item_modifiers = chosen modifiers per item (snapshotted)
//   contract_documents      = generated .docx files (history)
// ---------------------------------------------------------------------------

export const contracts = mysqlTable('contracts', {
  id: int('id').autoincrement().primaryKey(),
  number: varchar('number', { length: 16 }), // human-readable, format YY/XXX (e.g. 26/001)
  customerId: int('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  type: mysqlEnum('type', CONTRACT_TYPES).notNull().default('contract'),
  title: varchar('title', { length: 255 }),
  // Chosen document templates: templateId for the one-time contract document,
  // invoiceTemplateId for invoices generated from a recurring contract, and
  // receiptTemplateId for the receipts of this contract's payments (any contract type).
  templateId: int('template_id').references(() => templates.id, { onDelete: 'set null' }),
  invoiceTemplateId: int('invoice_template_id').references(() => templates.id, { onDelete: 'set null' }),
  receiptTemplateId: int('receipt_template_id').references(() => templates.id, { onDelete: 'set null' }),
  // Execution (when/where the contracted service will be performed)
  executionDate: date('execution_date', { mode: 'string' }),
  executionTime: varchar('execution_time', { length: 16 }), // HH:MM
  executionAddress: varchar('execution_address', { length: 512 }),
  duration: varchar('duration', { length: 128 }), // free text, e.g. "2 horas", "3 meses" (one-time)
  quantity: int('quantity'), // descriptive only (e.g. 20 photos) — does NOT affect price
  creditId: int('credit_id').references(() => customerCredits.id, { onDelete: 'set null' }),
  creditApplied: decimal('credit_applied', { precision: 12, scale: 2 }).notNull().default('0'),
  // Workflow status (one-time contracts) + when the current status was set (SLA clock).
  status: mysqlEnum('status', CONTRACT_STATUSES).notNull().default('aguardando_pagamento'),
  statusChangedAt: timestamp('status_changed_at').defaultNow().notNull(),
  comments: text('comments'),
  // Discounts are per-item now (on contract_items + contract_item_additionals).
  installments: int('installments').notNull().default(1),
  total: decimal('total', { precision: 12, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const contractItems = mysqlTable('contract_items', {
  id: int('id').autoincrement().primaryKey(),
  contractId: int('contract_id')
    .references(() => contracts.id, { onDelete: 'cascade' })
    .notNull(),
  serviceVersionId: int('service_version_id').references(() => serviceVersions.id, {
    onDelete: 'set null',
  }),
  // Snapshots taken at contract time (immune to later catalog changes)
  serviceName: varchar('service_name', { length: 255 }).notNull(),
  basePrice: decimal('base_price', { precision: 12, scale: 2 }).notNull().default('0'),
  quantity: int('quantity').notNull().default(1),
  discountPercent: decimal('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  lineTotal: decimal('line_total', { precision: 12, scale: 2 }).notNull().default('0'), // service+additionals, discounted
  // Recurring contracts: performed-service log fields
  description: text('description'), // free text shown on the invoice (e.g. video title)
  performedAt: date('performed_at', { mode: 'string' }), // when the service was performed
  invoiceId: int('invoice_id').references(() => invoices.id, { onDelete: 'set null' }), // billed on
});

// Invoices group selected performed services of a recurring contract.
export const invoices = mysqlTable('invoices', {
  id: int('id').autoincrement().primaryKey(),
  contractId: int('contract_id')
    .references(() => contracts.id, { onDelete: 'cascade' })
    .notNull(),
  reference: varchar('reference', { length: 255 }), // label / period, e.g. "Agosto/2026"
  refNumber: varchar('ref_number', { length: 16 }), // sequential per year, e.g. "001-26"
  creditId: int('credit_id').references(() => customerCredits.id, { onDelete: 'set null' }),
  creditApplied: decimal('credit_applied', { precision: 12, scale: 2 }).notNull().default('0'),
  comments: text('comments'),
  discountPercent: decimal('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  installments: int('installments').notNull().default(1),
  total: decimal('total', { precision: 12, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Additionals chosen for a contract item, with quantity + per-additional discount.
// (Short SQL table name keeps auto-generated FK identifiers under MySQL's 64-char limit.)
export const contractItemAdditionals = mysqlTable('item_additionals', {
  id: int('id').autoincrement().primaryKey(),
  contractItemId: int('contract_item_id')
    .references(() => contractItems.id, { onDelete: 'cascade' })
    .notNull(),
  additionalId: int('additional_id').references(() => serviceAdditionals.id, { onDelete: 'set null' }),
  name: varchar('name', { length: 255 }).notNull(), // snapshot
  unitPrice: decimal('unit_price', { precision: 12, scale: 2 }).notNull().default('0'), // snapshot
  quantity: int('quantity').notNull().default(1),
  discountPercent: decimal('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
  lineTotal: decimal('line_total', { precision: 12, scale: 2 }).notNull().default('0'), // unit*qty*(1-disc)
});

// Contract-level custom modifiers: free text + price (may be negative).
export const contractModifiers = mysqlTable('contract_modifiers', {
  id: int('id').autoincrement().primaryKey(),
  contractId: int('contract_id')
    .references(() => contracts.id, { onDelete: 'cascade' })
    .notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  price: decimal('price', { precision: 12, scale: 2 }).notNull().default('0'),
  discountPercent: decimal('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
});

// Free-text modifiers at the INVOICE (fatura) level — same shape as contract modifiers.
export const invoiceModifiers = mysqlTable('invoice_modifiers', {
  id: int('id').autoincrement().primaryKey(),
  invoiceId: int('invoice_id')
    .references(() => invoices.id, { onDelete: 'cascade' })
    .notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  price: decimal('price', { precision: 12, scale: 2 }).notNull().default('0'),
  discountPercent: decimal('discount_percent', { precision: 5, scale: 2 }).notNull().default('0'),
});

export const contractDocuments = mysqlTable('contract_documents', {
  id: int('id').autoincrement().primaryKey(),
  contractId: int('contract_id').references(() => contracts.id, { onDelete: 'cascade' }),
  invoiceId: int('invoice_id').references(() => invoices.id, { onDelete: 'cascade' }), // set for invoice docs
  comments: text('comments'),
  fileName: varchar('file_name', { length: 512 }).notNull(),
  filePath: varchar('file_path', { length: 1024 }).notNull(),
  format: varchar('format', { length: 16 }).notNull().default('docx'),
  generatedAt: timestamp('generated_at').defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Payments (financial manager: done + upcoming)
// ---------------------------------------------------------------------------

export const payments = mysqlTable('payments', {
  id: int('id').autoincrement().primaryKey(),
  // Installments generated from a contract/invoice cascade-delete with it.
  contractId: int('contract_id').references(() => contracts.id, { onDelete: 'cascade' }),
  invoiceId: int('invoice_id').references(() => invoices.id, { onDelete: 'cascade' }),
  customerId: int('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  categoryId: int('category_id').references(() => categories.id, { onDelete: 'set null' }),
  description: varchar('description', { length: 255 }).notNull(),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  flow: mysqlEnum('flow', FLOWS).notNull().default('in'),
  status: mysqlEnum('status', PAYMENT_STATUS).notNull().default('upcoming'), // saída
  receiptStatus: mysqlEnum('receipt_status', RECEIPT_STATUS).notNull().default('open'), // entrada
  installmentNumber: int('installment_number'),
  installmentCount: int('installment_count'),
  dueDate: date('due_date', { mode: 'string' }),
  paidDate: date('paid_date', { mode: 'string' }),
  receivedDate: date('received_date', { mode: 'string' }), // when the entrada was received (receipt date)
  // Shared id of the payments created together by one recurrence (e.g. a monthly
  // fee); null for ordinary payments. Lets a series be edited/deleted as a whole.
  recurrenceId: varchar('recurrence_id', { length: 36 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Categories (dropdown for bank statement items)
// ---------------------------------------------------------------------------

export const categories = mysqlTable('categories', {
  id: int('id').autoincrement().primaryKey(),
  name: varchar('name', { length: 255 }).notNull().unique(),
  flow: mysqlEnum('flow', FLOWS),
});

// ---------------------------------------------------------------------------
// Document templates (shared across installs via the DB)
//   kind: 'contract' | 'invoice'; content = base64 of the .docx
// ---------------------------------------------------------------------------

export const templates = mysqlTable('templates', {
  id: int('id').autoincrement().primaryKey(),
  kind: varchar('kind', { length: 32 }).notNull(), // 'contract' | 'invoice'
  name: varchar('name', { length: 255 }).notNull(),
  fileName: varchar('file_name', { length: 512 }).notNull(),
  content: longtext('content').notNull(),
  isDefault: boolean('is_default').notNull().default(false), // deprecated/unused — no default templates
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// App settings (single row, id = 1) — appearance/branding, shared across installs
// ---------------------------------------------------------------------------

export const settings = mysqlTable('settings', {
  id: int('id').primaryKey(),
  menuColor: varchar('menu_color', { length: 16 }), // header + navbar background
  accentColor: varchar('accent_color', { length: 16 }), // active item / highlight
  bgColor: varchar('bg_color', { length: 16 }), // main content background
  buttonColor: varchar('button_color', { length: 16 }), // primary button background
  buttonHoverColor: varchar('button_hover_color', { length: 16 }), // primary button hover
  editWindowDays: int('edit_window_days').notNull().default(20), // SLA: Em edição
  previewWindowDays: int('preview_window_days').notNull().default(30), // SLA: Prévias enviadas
  // Smallest allowed value of one installment (R$); caps how many installments a total can be split into.
  minInstallmentValue: decimal('min_installment_value', { precision: 12, scale: 2 }).notNull().default('150'),
  logo: longtext('logo'), // base64 image
  logoMime: varchar('logo_mime', { length: 64 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Bank statement imports + transactions
// ---------------------------------------------------------------------------

export const bankImports = mysqlTable('bank_imports', {
  id: int('id').autoincrement().primaryKey(),
  fileName: varchar('file_name', { length: 512 }).notNull(),
  bankId: varchar('bank_id', { length: 64 }),
  accountId: varchar('account_id', { length: 64 }),
  itemCount: int('item_count').default(0).notNull(),
  importedAt: timestamp('imported_at').defaultNow().notNull(),
});

export const transactions = mysqlTable('transactions', {
  id: int('id').autoincrement().primaryKey(),
  importId: int('import_id').references(() => bankImports.id, { onDelete: 'cascade' }),
  fitId: varchar('fit_id', { length: 255 }),
  date: date('date', { mode: 'string' }),
  description: varchar('description', { length: 512 }),
  memo: varchar('memo', { length: 512 }),
  amount: decimal('amount', { precision: 12, scale: 2 }).notNull(),
  flow: mysqlEnum('flow', FLOWS).notNull(),
  categoryId: int('category_id').references(() => categories.id, { onDelete: 'set null' }),
  matchedPaymentId: int('matched_payment_id').references(() => payments.id, {
    onDelete: 'set null',
  }),
  invoiceGenerated: boolean('invoice_generated').default(false).notNull(),
  invoiceLink: varchar('invoice_link', { length: 1024 }),
  receiptLink: varchar('receipt_link', { length: 1024 }),
  imported: boolean('imported').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const customersRelations = relations(customers, ({ many }) => ({
  contracts: many(contracts),
  payments: many(payments),
}));

export const servicesRelations = relations(services, ({ many }) => ({
  versions: many(serviceVersions),
}));

export const serviceVersionsRelations = relations(serviceVersions, ({ one, many }) => ({
  service: one(services, { fields: [serviceVersions.serviceId], references: [services.id] }),
  additionals: many(serviceAdditionals),
}));

export const serviceAdditionalsRelations = relations(serviceAdditionals, ({ one }) => ({
  version: one(serviceVersions, {
    fields: [serviceAdditionals.versionId],
    references: [serviceVersions.id],
  }),
}));

export const contractsRelations = relations(contracts, ({ one, many }) => ({
  customer: one(customers, { fields: [contracts.customerId], references: [customers.id] }),
  items: many(contractItems),
  documents: many(contractDocuments),
  invoices: many(invoices),
  modifiers: many(contractModifiers),
}));

export const contractItemsRelations = relations(contractItems, ({ one, many }) => ({
  contract: one(contracts, { fields: [contractItems.contractId], references: [contracts.id] }),
  invoice: one(invoices, { fields: [contractItems.invoiceId], references: [invoices.id] }),
  additionals: many(contractItemAdditionals),
}));

export const contractModifiersRelations = relations(contractModifiers, ({ one }) => ({
  contract: one(contracts, { fields: [contractModifiers.contractId], references: [contracts.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  contract: one(contracts, { fields: [invoices.contractId], references: [contracts.id] }),
  items: many(contractItems),
  documents: many(contractDocuments),
}));

export const contractItemAdditionalsRelations = relations(contractItemAdditionals, ({ one }) => ({
  item: one(contractItems, {
    fields: [contractItemAdditionals.contractItemId],
    references: [contractItems.id],
  }),
}));

export const contractDocumentsRelations = relations(contractDocuments, ({ one }) => ({
  contract: one(contracts, {
    fields: [contractDocuments.contractId],
    references: [contracts.id],
  }),
  invoice: one(invoices, {
    fields: [contractDocuments.invoiceId],
    references: [invoices.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  contract: one(contracts, { fields: [payments.contractId], references: [contracts.id] }),
  invoice: one(invoices, { fields: [payments.invoiceId], references: [invoices.id] }),
  customer: one(customers, { fields: [payments.customerId], references: [customers.id] }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  import: one(bankImports, { fields: [transactions.importId], references: [bankImports.id] }),
  category: one(categories, { fields: [transactions.categoryId], references: [categories.id] }),
  matchedPayment: one(payments, {
    fields: [transactions.matchedPaymentId],
    references: [payments.id],
  }),
}));

export const bankImportsRelations = relations(bankImports, ({ many }) => ({
  transactions: many(transactions),
}));
