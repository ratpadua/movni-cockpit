// Pre-release smoke test (small, gentle on a remote DB). Usage: start the server (npm --prefix server run start), then
//   node qa/api/release-smoke.mjs        (or: npm --prefix qa run release-smoke)
// Run it against the DEV database before every production release, after `db:add-columns` was run twice on dev
// (see qa/README.md "Pre-release check"). Only ~40 requests, sequential with short pauses. Creates only QAZ-REL data and
// removes it again (also on failure); the row counts must equal the baseline taken at the start.
// Credentials are read from .env/.env.local (or .env.test with DB_TARGET=local) and are never printed.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(ROOT, 'server', 'package.json'));
const PizZip = req('pizzip');
const mysql = req('mysql2/promise');
function parseEnv(f) {
  const o = {};
  if (!fs.existsSync(f)) return o;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) o[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return o;
}
const env = {
  ...parseEnv(path.join(ROOT, '.env')),
  ...parseEnv(path.join(ROOT, '.env.local')),
  ...(process.env.DB_TARGET === 'local' ? parseEnv(path.join(ROOT, '.env.test')) : {}),
};
if (!env.DB_HOST || !env.DB_USER || !env.DB_PASS || !env.DB_NAME) { console.log('ABORT: DB_HOST/DB_NAME/DB_USER/DB_PASS missing'); process.exit(2); }
const PORT = Number(env.PORT || 5178);

const results = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + extra}`); return !!cond; };
const eq = (name, a, b) => ok(name, a === b, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
const short = (x) => { try { return JSON.stringify(x).slice(0, 200); } catch { return String(x); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSE = Number(process.env.RELEASE_PAUSE_MS || 150);

function call(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { host: `localhost:${PORT}`, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) };
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers, timeout: 60000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let b = null;
        try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: b });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const api = async (m, p, b) => { const x = await call(m, p, b); await sleep(PAUSE); return x; };

function docx(text) {
  const z = new PizZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return z.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const TABLES = ['bank_imports', 'categories', 'contract_documents', 'contract_items', 'contract_modifiers', 'contracts', 'customer_credits', 'customers', 'invoice_modifiers', 'invoices', 'item_additionals', 'payments', 'service_additionals', 'service_versions', 'services', 'settings', 'templates', 'transactions'];
let sql = null;
const counts = async () => { const o = {}; for (const t of TABLES) o[t] = Number((await sql.query(`select count(*) c from \`${t}\``))[0][0].c); return o; };
let baseline = null;
const ids = { customers: [], contracts: [] };

async function main() {
  sql = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASS, database: env.DB_NAME, connectTimeout: 20000 });
  console.log(`target: ${['127.0.0.1', 'localhost'].includes(env.DB_HOST) ? 'LOCAL test database' : 'REMOTE database'} (check this is DEV before a release!)`);
  baseline = await counts();
  console.log('baseline counts:', JSON.stringify(baseline));
  const left = Number((await sql.query("select (select count(*) from customers where name like 'QAZ%') + (select count(*) from payments where description like 'QAZ%') c"))[0][0].c);
  if (left > 0) throw new Error('QAZ leftovers present in the database; remove them first');

  // ---- schema expectations (information_schema) ----
  const have = (await sql.query('select table_name n from information_schema.tables where table_schema = database()'))[0].map((r) => String(r.n || r.TABLE_NAME).toLowerCase());
  ok('all application tables exist', TABLES.every((t) => have.includes(t)), TABLES.filter((t) => !have.includes(t)).join(','));
  const cols = (await sql.query("select column_name n from information_schema.columns where table_schema = database() and table_name = 'transactions' and column_name in ('orig_date','orig_amount')"))[0];
  eq('transactions.orig_date and orig_amount exist', cols.length, 2);
  const ix = (await sql.query("select index_name n, non_unique u from information_schema.statistics where table_schema = database() and index_name in ('contracts_number_uq','invoices_ref_number_uq')"))[0];
  ok('unique indexes contracts_number_uq and invoices_ref_number_uq exist', ix.length === 2 && ix.every((x) => Number(x.u) === 0), short(ix));

  // ---- server, login, lists ----
  let r = await api('GET', '/api/health'); eq('GET /api/health 200', r.status, 200);
  r = await api('POST', '/api/login', { username: env.DB_USER, password: env.DB_PASS });
  if (!ok('login through POST /api/login', r.status === 200 && r.body?.connected === true, `HTTP ${r.status}`)) throw new Error('login failed');
  for (const p of ['customers', 'services', 'categories', 'contracts', 'payments', 'templates', 'settings']) {
    r = await api('GET', `/api/${p}`);
    ok(`GET /api/${p} 200 and well-formed`, r.status === 200 && (p === 'settings' ? typeof r.body === 'object' : Array.isArray(r.body)), `${r.status}`);
  }

  // ---- QAZ-REL data ----
  r = await api('POST', '/api/services', { name: 'QAZ-REL Servico', basePrice: '450' });
  const sv = r.body?.currentVersion?.id; ok('create QAZ service (version id)', r.status === 201 && !!sv, `${r.status} ${short(r.body)}`);
  const tpl = async (kind) => (await api('POST', '/api/templates', { kind, name: `QAZ-REL ${kind}`, fileName: `${kind}.docx`, content: docx('QAZ-REL {customer_name}').toString('base64') })).body?.id;
  const tC = await tpl('contract'), tR = await tpl('receipt');
  ok('create QAZ contract + receipt templates', !!tC && !!tR);
  r = await api('POST', '/api/customers', { name: 'QAZ-REL Cliente', nickname: 'Rel' });
  const cu = r.body; ids.customers.push(cu?.id); ok('create QAZ customer', r.status === 201 && !!cu?.id);
  const body = { customerId: cu?.id, type: 'contract', items: [{ serviceVersionId: sv }], templateId: tC, receiptTemplateId: tR, installments: 2, dueDates: ['2027-01-10', '2027-02-10'] };
  r = await api('POST', '/api/contracts', body);
  const C = r.body; if (C?.id) ids.contracts.push(C.id);
  ok('create one-time contract with 2 installments (201, number YY/XXX)', r.status === 201 && /^\d{2}\/\d{3}$/.test(C?.number || '') && C.payments?.length === 2, `${r.status} ${short(r.body)}`);
  const par = await Promise.all([1, 2, 3].map(() => call('POST', '/api/contracts', { ...body, installments: 1, dueDates: ['2027-01-10'] })));
  for (const x of par) if (x.body?.id) ids.contracts.push(x.body.id);
  ok('3 concurrent contract creations: all 201 and 3 DISTINCT numbers', par.every((x) => x.status === 201) && new Set(par.map((x) => x.body?.number)).size === 3, par.map((x) => x.status).join(','));
  await sleep(PAUSE);
  const inst = C.payments?.find((p) => p.installmentNumber === 1) || C.payments?.[0];
  r = await api('PUT', `/api/payments/${inst.id}`, { receiptStatus: 'received', receivedDate: '2027-01-10' });
  ok('mark an installment received', r.status === 200 && r.body?.receiptStatus === 'received', `${r.status}`);
  r = await api('DELETE', `/api/contracts/${C.id}`);
  ok('delete contract with a received payment -> 409', r.status === 409, `${r.status} ${short(r.body)}`);
  r = await api('PUT', `/api/payments/${inst.id}`, { receiptStatus: 'open', receivedDate: null });
  ok('re-open the installment', r.status === 200 && r.body?.receiptStatus === 'open');
  r = await api('DELETE', `/api/contracts/${C.id}`); eq('delete contract (nothing received) -> 204', r.status, 204);
  r = await api('GET', `/api/contracts/${C.id}`); eq('deleted contract is gone (404)', r.status, 404);
  for (const x of par) { if (x.body?.id) await api('DELETE', `/api/contracts/${x.body.id}`); }
  r = await api('DELETE', `/api/customers/${cu.id}`); eq('delete customer (no contracts left) -> 204', r.status, 204);
  // a payment: create / edit / delete
  r = await api('POST', '/api/payments', { description: 'QAZ-REL pagamento', amount: '12,34', flow: 'out', dueDate: '2027-03-01' });
  const P = r.body; ok('create payment (amount 12.34)', r.status === 201 && Number(P?.amount) === 12.34, `${r.status} ${short(r.body)}`);
  r = await api('PUT', `/api/payments/${P.id}`, { description: 'QAZ-REL pagamento editado', amount: '20' });
  ok('edit payment', r.status === 200 && r.body?.description === 'QAZ-REL pagamento editado' && Number(r.body?.amount) === 20, `${r.status}`);
  r = await api('DELETE', `/api/payments/${P.id}`); eq('delete payment (204)', r.status, 204);
}

async function cleanup() {
  console.log('\n--- cleanup ---');
  if (!sql) return;
  try {
    for (const id of ids.contracts) await sql.query('delete from contracts where id = ?', [id]);
    await sql.query("delete from payments where description like 'QAZ-REL%'");
    await sql.query("delete from contracts where customer_id in (select id from customers where name like 'QAZ-REL%')");
    await sql.query("delete from customers where name like 'QAZ-REL%'");
    await sql.query("delete from services where name like 'QAZ-REL%'");
    await sql.query("delete from templates where name like 'QAZ-REL%'");
    const after = await counts();
    const diff = TABLES.filter((t) => baseline && after[t] !== baseline[t]);
    ok('cleanup: every table row count equals the baseline', diff.length === 0, diff.map((t) => `${t}: ${baseline[t]} -> ${after[t]}`).join('; '));
  } catch (e) { ok('cleanup finished', false, String(e.message).slice(0, 200)); }
  try { await sql.end(); } catch { /* ignore */ }
}

let fatal = null;
try { await main(); } catch (e) { fatal = e; console.log('FATAL: ' + String(e.message).slice(0, 300)); }
await cleanup();
const failed = results.filter((x) => !x.pass);
console.log(`\nRELEASE SMOKE: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed${fatal ? ' (FATAL)' : ''}`);
process.exit(failed.length || fatal ? 1 : 0);
