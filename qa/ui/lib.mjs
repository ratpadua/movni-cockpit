// Shared helpers for the UI QA run. Never prints credentials.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');            // project root (two levels above qa/ui)
export const QA = path.join(ROOT, 'qa', 'results');              // run state + downloads (gitignored)
export const SCREENS = path.join(ROOT, 'qa', 'screens');         // screenshots (gitignored)
export const BASE = 'http://localhost:5178';
fs.mkdirSync(SCREENS, { recursive: true });
fs.mkdirSync(QA, { recursive: true });

const reqServer = createRequire(path.join(ROOT, 'server', 'package.json'));
const reqQa = createRequire(path.join(ROOT, 'qa', 'package.json'));
export const PizZip = reqServer('pizzip');
export const mysql = reqServer('mysql2/promise');
export const { chromium } = reqQa('playwright');

function parseEnv(f) {
  const o = {};
  if (!fs.existsSync(f)) return o;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) o[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return o;
}
export const env = {
  ...parseEnv(path.join(ROOT, '.env')),
  ...parseEnv(path.join(ROOT, '.env.local')),
  // DB_TARGET=local: use the local Docker MySQL from the gitignored .env.test
  ...(process.env.DB_TARGET === 'local' ? parseEnv(path.join(ROOT, '.env.test')) : {}),
};

export async function sqlConnect() {
  return mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASS, database: env.DB_NAME });
}

export async function api(method, p, body, extra = {}) {
  const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, ...extra });
  const ct = res.headers.get('content-type') || '';
  let data = null;
  if (ct.includes('json')) { try { data = await res.json(); } catch { data = null; } }
  return { status: res.status, body: data, headers: res.headers, res };
}

export async function login() {
  const s = await api('GET', '/api/session');
  if (s.body?.connected) return true;
  const r = await api('POST', '/api/login', { user: env.DB_USER, password: env.DB_PASS, username: env.DB_USER, pass: env.DB_PASS });
  return r.status === 200;
}

export const TABLES = ['customers', 'customer_credits', 'services', 'service_versions', 'service_additionals', 'contracts', 'contract_items', 'contract_documents', 'invoices', 'payments', 'categories', 'templates', 'bank_imports', 'transactions', 'settings', 'contract_modifiers', 'invoice_modifiers', 'item_additionals'];
export async function counts(sql) {
  const o = {};
  for (const t of TABLES) { try { const [r] = await sql.query(`select count(*) c from \`${t}\``); o[t] = Number(r[0].c); } catch { o[t] = 'n/a'; } }
  return o;
}

// ---- results ----
export const results = [];
let currentFlow = '';
export function setFlow(n) { currentFlow = n; console.log(`\n=== ${n}`); }
export function ok(name, cond, extra = '') {
  results.push({ flow: currentFlow, name, pass: !!cond, extra: cond ? '' : String(extra).slice(0, 400) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + String(extra).slice(0, 400)}`);
  return !!cond;
}
// A check for a KNOWN, tracked issue (reported, but it does not fail the run): recorded as pass with known:true when the
// condition is false. Use only for issues the owner has put out of scope / on a follow-up list.
export function known(name, cond, extra = '') {
  results.push({ flow: currentFlow, name, pass: true, known: !cond, extra: cond ? '' : String(extra).slice(0, 400) });
  console.log(`${cond ? 'PASS' : 'KNOWN-ISSUE'}  ${name}${cond ? '' : '  -> ' + String(extra).slice(0, 400)}`);
  return !!cond;
}
export const eq = (name, a, b) => ok(name, a === b, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
export function saveResults(file) { fs.writeFileSync(path.join(QA, file), JSON.stringify(results, null, 1)); }

// ---- browser session with event capture ----
export async function newSession(viewport = { width: 1366, height: 900 }, opts = {}) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', acceptDownloads: true, ...opts });
  const page = await context.newPage();
  const ev = { console: [], pageerrors: [], bad: [] };
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') ev.console.push(`[${m.type()}] ${m.text()}`.slice(0, 300)); });
  page.on('pageerror', (e) => ev.pageerrors.push(String(e.message).slice(0, 300)));
  page.on('response', (r) => { if (r.status() >= 400) ev.bad.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
  // native confirm() dialogs: accept by default, remember messages
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  return { browser, context, page, ev, dialogs };
}
export function drain(ev, label) {
  const out = { console: ev.console.splice(0), pageerrors: ev.pageerrors.splice(0), bad: ev.bad.splice(0) };
  if (out.console.length || out.pageerrors.length || out.bad.length) console.log(`  [events:${label}] ${JSON.stringify(out)}`);
  allEvents.push({ label, ...out });
  return out;
}
export const allEvents = [];
export async function shot(page, name) {
  const f = path.join(SCREENS, name.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.png');
  try { await page.screenshot({ path: f, fullPage: true }); } catch (e) { console.log('  shot failed', name, e.message); }
  return f;
}
export function saveEvents(file) { fs.writeFileSync(path.join(QA, file), JSON.stringify(allEvents, null, 1)); }

// ---- doc builders ----
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function buildDocx(paras) {
  const z = new PizZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>');
  return z.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
export const CONTRACT_PARAS = [
  'Cliente: {customer_name} ({customer_nickname})', 'Contrato {contract_number} Total {total}',
  '{#items}', 'Item {service_name} {line_total}', '{/items}', '{#installments}', 'Parcela {number} {due_date} {amount}', '{/installments}', 'Data {date_short}',
];
export const INVOICE_PARAS = ['Cliente: {customer_name}', 'Fatura {invoice_number} Ref [{invoice_reference}] Total {total}', '{#items}', 'Item {service_name} {description} {line_total}', '{/items}'];
export const RECEIPT_PARAS = ['Recibo {customer_nickname} valor {amount} restante {amount_left} parcela {installment} data {date_short}'];

export const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const br = (iso) => (iso ? iso.split('-').reverse().join('/') : '');
export const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
