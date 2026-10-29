// Tiny fetch wrapper around the local server API.
const BASE = '/api';

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      msg = body.error ?? msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => fetch(`${BASE}${path}`).then((r) => handle<T>(r)),
  post: <T>(path: string, body: unknown) =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  put: <T>(path: string, body: unknown) =>
    fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  del: (path: string) => fetch(`${BASE}${path}`, { method: 'DELETE' }).then((r) => handle<void>(r)),
};

// ----- Domain types (mirror the server schema) -----
export type ContactMethod = 'whatsapp' | 'email';

export interface Customer {
  id: number;
  name: string;
  nickname?: string | null;
  address?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  preferredContact?: ContactMethod | null;
  document?: string | null;
}

export interface CustomerCredit {
  id: number;
  customerId: number;
  description: string;
  value: string;
  remaining: string;
  createdAt: string;
}

export interface CustomerCharge {
  id: number;
  description: string;
  amount: string;
  dueDate: string | null;
  contractNumber: string | null;
}

export interface Employee {
  id: number;
  name: string;
  role?: string | null;
  document?: string | null;
  email?: string | null;
  phone?: string | null;
  hireDate?: string | null;
  active: boolean;
}

// ----- Services catalog (versioned) -----
export interface Additional {
  id: number;
  versionId: number;
  name: string;
  price: string; // unit price
}

export interface ServiceVersion {
  id: number;
  serviceId: number;
  version: number;
  basePrice: string;
  active: boolean;
  notes?: string | null;
  createdAt: string;
  additionals: Additional[];
}

export interface ServiceCatalog {
  id: number;
  name: string;
  description?: string | null;
  active: boolean;
  currentVersion: ServiceVersion | null;
}

export interface ServiceDetail extends Omit<ServiceCatalog, 'currentVersion'> {
  versions: ServiceVersion[];
}

export type ReceiptStatus = 'open' | 'received' | 'sent';

export interface Payment {
  id: number;
  contractId?: number | null;
  invoiceId?: number | null;
  customerId?: number | null;
  categoryId?: number | null;
  description: string;
  amount: string;
  flow: 'in' | 'out';
  status: 'upcoming' | 'done';
  receiptStatus: ReceiptStatus;
  installmentNumber?: number | null;
  installmentCount?: number | null;
  dueDate?: string | null;
  paidDate?: string | null;
  receivedDate?: string | null;
  recurrenceId?: string | null; // shared by the payments created together by one recurrence
  // list-only joined fields
  customerName?: string | null;
  customerNickname?: string | null;
  contractNumber?: string | null;
  categoryName?: string | null;
}

export interface Category {
  id: number;
  name: string;
  flow?: 'in' | 'out' | null;
}

export interface AppSettings {
  menuColor: string;
  accentColor: string;
  bgColor: string;
  buttonColor: string;
  buttonHoverColor: string;
  editWindowDays: number;
  previewWindowDays: number;
  minInstallmentValue: number; // R$ — smallest allowed installment
  logo: string | null; // base64
  logoMime: string | null;
}

// One-time contract workflow statuses (order matters).
export type ContractStatus =
  | 'aguardando_pagamento'
  | 'agendado'
  | 'realizado'
  | 'em_edicao'
  | 'enviado'
  | 'finalizado';

export interface OverdueContract {
  id: number;
  number: string | null;
  title: string | null;
  status: ContractStatus;
  statusChangedAt: string;
  customerName: string | null;
  days: number;
  deadline: string;
  overdue: boolean;
}

export type TemplateKind = 'contract' | 'invoice' | 'receipt';

export interface TemplateInfo {
  id: number;
  kind: TemplateKind;
  name: string;
  fileName: string;
  updatedAt: string;
}

// ----- Contracts -----
export type ContractType = 'contract' | 'invoice';

export interface ContractSummary {
  id: number;
  number?: string | null;
  type: ContractType;
  title?: string | null;
  total: string;
  createdAt: string;
  customerId?: number | null;
  customerName?: string | null;
  status: ContractStatus;
  statusChangedAt: string;
}

export interface ContractItemAdditional {
  id: number;
  contractItemId: number;
  additionalId?: number | null;
  name: string;
  unitPrice: string;
  quantity: number;
  discountPercent: string;
  lineTotal: string;
}

export interface ContractItem {
  id: number;
  contractId: number;
  serviceVersionId?: number | null;
  serviceId?: number | null;
  version?: number | null;
  serviceName: string;
  basePrice: string;
  quantity: number;
  discountPercent: string;
  lineTotal: string;
  description?: string | null;
  performedAt?: string | null;
  invoiceId?: number | null;
  additionals: ContractItemAdditional[];
}

export interface ContractModifier {
  id: number;
  contractId: number;
  name: string;
  price: string;
  discountPercent: string;
}

export interface InvoiceModifier {
  id: number;
  invoiceId: number;
  name: string;
  price: string;
  discountPercent: string;
}

export interface Invoice {
  id: number;
  contractId: number;
  reference?: string | null;
  refNumber?: string | null;
  comments?: string | null;
  creditId?: number | null;
  creditApplied?: string;
  discountPercent: string;
  installments: number;
  total: string;
  createdAt: string;
  documents: ContractDocument[];
  payments: Payment[];
  modifiers: InvoiceModifier[];
}

export interface ContractDocument {
  id: number;
  contractId?: number | null;
  comments?: string | null;
  fileName: string;
  format: string;
  generatedAt: string;
}

export interface ContractDetail {
  id: number;
  number?: string | null;
  type: ContractType;
  title?: string | null;
  comments?: string | null;
  installments: number;
  templateId?: number | null;
  invoiceTemplateId?: number | null;
  receiptTemplateId?: number | null;
  executionDate?: string | null;
  executionTime?: string | null;
  executionAddress?: string | null;
  duration?: string | null;
  quantity?: number | null;
  creditId?: number | null;
  creditApplied?: string;
  status: ContractStatus;
  statusChangedAt: string;
  total: string;
  createdAt: string;
  customerId?: number | null;
  customer?: Customer | null;
  items: ContractItem[];
  documents: ContractDocument[];
  invoices: Invoice[];
  payments: Payment[];
  modifiers: ContractModifier[];
}

export interface PreviewItem {
  fitId: string | null;
  date: string | null;
  type: string; // bank <NAME>
  description: string; // bank <MEMO>
  amount: number;
  // Values exactly as in the statement (set by /bank/parse, never edited in the preview);
  // sent back on import so "Já importado" matches even when date/amount were edited.
  originalDate?: string | null;
  originalAmount?: number;
  flow: 'in' | 'out';
  categoryId: number | null;
  matchedPaymentId: number | null;
  contractId?: number | null; // associate income to a contract as an extra payment
  alreadyImported?: boolean; // this line was imported from an earlier statement upload
  selected: boolean;
  suggestions: { paymentId: number; reason: string; label: string }[];
}

export interface OpenPaymentOption {
  value: string;
  label: string;
}

export interface ParsePreview {
  bankId: string | null;
  accountId: string | null;
  fileName: string;
  items: PreviewItem[];
  openPayments: OpenPaymentOption[];
  skipped?: number; // statement lines that could not be read (invalid amount)
}

export interface ReportEntry {
  id: number;
  date: string | null;
  description: string | null;
  amount: string;
  flow: 'in' | 'out';
  categoryId: number | null;
  categoryName: string | null;
  customerName: string | null;
  customerNickname: string | null;
  contractNumber: string | null;
}
