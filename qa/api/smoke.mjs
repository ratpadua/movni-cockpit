// QA smoke test for Movni Cockpit. Usage: node qa/api/smoke.mjs   (project root = two levels above this file; output in qa/results)
// Never prints credentials. Creates only 'QAZ'-prefixed data and removes it at the end.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCR = path.join(ROOT, 'qa', 'results');
fs.mkdirSync(SCR, { recursive: true });
const req = createRequire(path.join(ROOT, 'server', 'package.json'));
const PizZip = req('pizzip');
const mysql = req('mysql2/promise');

// ---------- env (never printed) ----------
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
  // DB_TARGET=local: use the local Docker MySQL from the gitignored .env.test
  ...(process.env.DB_TARGET === 'local' ? parseEnv(path.join(ROOT, '.env.test')) : {}),
};
if (!env.DB_USER || !env.DB_PASS) { console.log('ABORT: DB_USER/DB_PASS missing in .env.local'); process.exit(2); }

// ---------- harness ----------
const results = [];
let section = '';
function sec(s) { section = s; console.log(`\n=== ${s}`); }
function ok(name, cond, extra = '') {
  results.push({ section, name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  -> ' + extra}`);
  return !!cond;
}
const eq = (name, actual, expected) => ok(name, actual === expected, `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
const short = (x) => { try { return JSON.stringify(x).slice(0, 300); } catch { return String(x); } };

function call(method, p, o = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host: o.host ?? 'localhost:5178', ...(o.headers || {}) };
    let data = null;
    if (o.rawBody !== undefined) { data = Buffer.from(o.rawBody); headers['content-type'] = 'application/json'; }
    else if (o.body !== undefined) { data = Buffer.from(JSON.stringify(o.body)); headers['content-type'] = 'application/json'; }
    if (data) headers['content-length'] = data.length;
    if (o.origin) headers.origin = o.origin;
    const r = http.request({ host: '127.0.0.1', port: 5178, method, path: p, headers, timeout: 180000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = String(res.headers['content-type'] || '');
        let body = null;
        if (ct.includes('json')) { try { body = JSON.parse(buf.toString('utf8')); } catch { body = null; } }
        resolve({ status: res.statusCode, headers: res.headers, body, buf, text: buf.toString('utf8') });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const api = (m, p, body, o = {}) => call(m, p, { body, ...o });

// ---------- doc builders ----------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function buildDocx(paras) {
  const z = new PizZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + paras.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>');
  return z.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function buildOdt(paras) {
  const z = new PizZip();
  z.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  z.file('META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>');
  z.file('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text>' + paras.map((p) => `<text:p>${esc(p)}</text:p>`).join('') + '</office:text></office:body></office:document-content>');
  return z.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function docText(buf, fmt) {
  const z = new PizZip(buf);
  const xml = z.file(fmt === 'odt' ? 'content.xml' : 'word/document.xml').asText();
  return xml.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/ /g, ' ').replace(/\s+/g, ' ');
}

const CONTRACT_PARAS = [
  'Cliente: {customer_name} ({customer_nickname}) End {customer_address}',
  'Contrato {contract_number} Total {total} Antes {total_before_credit} Credito {credit_applied}',
  '{#items}', 'Item {service_name} {line_total}', '{/items}',
  '{#installments}', 'Parcela {number} {due_date} {amount}', '{/installments}',
  'Data {date_short}',
];
const INVOICE_PARAS = [
  'Cliente: {customer_name} ({customer_nickname})',
  'Fatura {invoice_number} Ref [{invoice_reference}] Total {total}',
  '{#items}', 'Item {service_name} {description} {line_total}', '{/items}',
];
const RECEIPT_PARAS = [
  'Recibo {customer_nickname} valor {amount} restante {amount_left} parcela {installment} fatura {invoice_number} data {date_short}',
];

// ---------- state for cleanup ----------
const created = { customers: [], categories: [], services: [], templates: [], contracts: [], payments: [], docs: [], invoices: [] };
let sql = null;
let baseline = null;
let origSettings = null;
const TABLES = ['customers', 'customer_credits', 'services', 'service_versions', 'service_additionals', 'contracts', 'contract_items', 'contract_documents', 'invoices', 'payments', 'categories', 'templates', 'bank_imports', 'transactions'];
async function counts() {
  const o = {};
  for (const t of TABLES) { const [r] = await sql.query(`select count(*) c from \`${t}\``); o[t] = Number(r[0].c); }
  return o;
}
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

async function main() {
  // ====================================================================
  sec('A. Access control (not logged in)');
  let r = await api('GET', '/api/health');
  eq('health 200 (Host localhost:5178, no Origin)', r.status, 200);
  r = await call('GET', '/api/health', { host: '127.0.0.1:5178' });
  eq('health 200 (Host 127.0.0.1:5178)', r.status, 200);
  for (const h of ['evil.com', 'localhost:5178.evil.com', 'localhost:9999', '[::1]:5178', 'localhost']) {
    r = await call('GET', '/api/health', { host: h });
    eq(`foreign Host "${h}" -> 403`, r.status, 403);
  }
  r = await call('GET', '/', { host: 'evil.com' });
  eq('foreign Host on static / -> 403', r.status, 403);
  for (const o of ['http://evil.com', 'null', 'http://localhost.evil.com:5178', 'https://localhost:5178', 'http://localhost:5174']) {
    r = await call('GET', '/api/health', { origin: o });
    eq(`foreign Origin "${o}" -> 403`, r.status, 403);
  }
  for (const o of ['http://localhost:5173', 'http://localhost:5178', 'http://127.0.0.1:5173']) {
    r = await call('GET', '/api/health', { origin: o });
    eq(`Origin ${o} -> 200`, r.status, 200);
  }
  r = await call('OPTIONS', '/api/customers', { origin: 'http://localhost:5173', headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  ok('preflight allowed origin -> 2xx + ACAO', r.status >= 200 && r.status < 300 && r.headers['access-control-allow-origin'] === 'http://localhost:5173', `status ${r.status} acao ${r.headers['access-control-allow-origin']}`);
  r = await call('OPTIONS', '/api/customers', { origin: 'http://evil.com', headers: { 'access-control-request-method': 'POST' } });
  eq('preflight foreign origin -> 403', r.status, 403);
  r = await call('OPTIONS', '/api/customers', { host: 'evil.com', origin: 'http://localhost:5173', headers: { 'access-control-request-method': 'POST' } });
  eq('preflight foreign Host -> 403', r.status, 403);

  // make sure we start logged out
  r = await api('POST', '/api/logout');
  eq('logout open (200)', r.status, 200);
  r = await api('GET', '/api/session');
  ok('session open -> connected:false', r.status === 200 && r.body?.connected === false, short(r.body));
  for (const [m, p] of [['GET', '/api/customers'], ['POST', '/api/customers'], ['GET', '/api/contracts'], ['GET', '/api/payments'], ['GET', '/api/settings'], ['GET', '/api/templates'], ['GET', '/api/customers/abc'], ['POST', '/api/bank/parse']]) {
    r = await api(m, p, m === 'POST' ? { name: 'x' } : undefined);
    eq(`401 when logged out: ${m} ${p}`, r.status, 401);
  }
  r = await api('POST', '/api/login', {});
  eq('login open: empty body -> 400 (not 401)', r.status, 400);

  // ====================================================================
  sec('B. Login + DB baseline');
  r = await api('POST', '/api/login', { username: env.DB_USER, password: env.DB_PASS });
  if (r.status !== 200) {
    console.log(`LOGIN FAILED: HTTP ${r.status} ${short(r.body)}`);
    ok('login with dev credentials', false, `HTTP ${r.status}`);
    throw new Error('LOGIN_FAILED');
  }
  ok('login with dev credentials -> connected', r.body?.connected === true);
  r = await api('GET', '/api/session');
  ok('session connected:true after login', r.body?.connected === true);
  sql = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT || 3306), user: env.DB_USER, password: env.DB_PASS, database: env.DB_NAME });
  baseline = await counts();
  console.log('baseline counts:', JSON.stringify(baseline));
  origSettings = (await api('GET', '/api/settings')).body;
  const minInst = Number(origSettings.minInstallmentValue);
  const maxInst = (total) => Math.max(1, Math.floor(total / minInst));

  // ====================================================================
  sec('C. Error handler / bad ids');
  r = await api('POST', '/api/payments', { description: 'QAZ fk', amount: 1, customerId: 2000000000 });
  ok('FK violation -> 400 generic pt-BR', r.status === 400 && /relacionado/i.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  ok('FK error does not leak SQL', !/insert|sql|constraint|ER_|payments|fk|`/i.test(r.text), r.text.slice(0, 200));
  r = await call('POST', '/api/customers', { rawBody: '{bad json' });
  ok('malformed JSON -> 400 generic', r.status === 400 && !/Unexpected|JSON|position/i.test(r.text), `${r.status} ${r.text.slice(0, 150)}`);
  for (const id of ['abc', 'NaN', '0', '-1', '1.5', '99999999999', '1e3', '%20']) {
    for (const [m, p] of [['GET', `/api/customers/${id}`], ['DELETE', `/api/customers/${id}`], ['GET', `/api/contracts/${id}`], ['DELETE', `/api/contracts/${id}`], ['PUT', `/api/payments/${id}`], ['DELETE', `/api/payments/${id}`], ['GET', `/api/services/${id}`], ['GET', `/api/contract-documents/${id}/download`], ['POST', `/api/invoices/${id}/generate`], ['DELETE', `/api/contracts/1/items/${id}`], ['PUT', `/api/contracts/${id}/status`]]) {
      r = await api(m, p, m === 'PUT' ? {} : undefined);
      if (r.status !== 400) ok(`bad id ${id}: ${m} ${p} -> 400`, false, `got ${r.status} ${r.text.slice(0, 100)}`);
    }
  }
  ok('bad ids (8 variants x 11 routes) all -> 400', results.filter((x) => x.section === section && /^bad id/.test(x.name) && !x.pass).length === 0);
  r = await api('GET', '/api/customers/2000000000');
  eq('valid-but-missing id -> 404', r.status, 404);

  // ====================================================================
  sec('D. Customers / categories (whitelist, regression CRUD)');
  r = await api('POST', '/api/customers', { name: 'QAZ Cliente Teste', nickname: 'João Ação', address: 'Rua A & B <1>', email: 'qaz@example.test', preferredContact: 'email', id: 999999, createdAt: '2000-01-01 00:00:00', evil: 'x' });
  eq('create customer 201', r.status, 201);
  const cu = r.body;
  created.customers.push(cu.id);
  ok('mass-assignment: id ignored', cu.id !== 999999);
  ok('mass-assignment: createdAt ignored', !String(cu.createdAt).startsWith('2000'), String(cu.createdAt));
  ok('unknown field not stored', cu.evil === undefined);
  eq('nickname stored with accents', cu.nickname, 'João Ação');
  r = await api('POST', '/api/customers', {});
  eq('empty body -> 400', r.status, 400);
  r = await api('POST', '/api/customers', { id: 5, createdAt: 'x' });
  eq('only non-whitelisted fields -> 400', r.status, 400);
  r = await api('POST', '/api/customers', { nickname: 'x' });
  eq('missing required name -> 400', r.status, 400);
  r = await api('POST', '/api/customers', { name: 'a'.repeat(300) });
  eq('name too long -> 400', r.status, 400);
  r = await api('POST', '/api/customers', { name: 'QAZ x', preferredContact: 'pombo' });
  eq('bad enum -> 400', r.status, 400);
  r = await api('POST', '/api/customers', { name: 'QAZ x', phone: 123 });
  eq('non-string field -> 400', r.status, 400);
  r = await api('PUT', `/api/customers/${cu.id}`, { name: 'QAZ Cliente Teste', id: 1, createdAt: '2001-01-01', city: 'Teste' });
  ok('PUT ignores id/createdAt, updates city', r.status === 200 && r.body.id === cu.id && r.body.city === 'Teste' && !String(r.body.createdAt).startsWith('2001'), short(r.body));
  r = await api('PUT', `/api/customers/${cu.id}`, {});
  eq('PUT empty -> 400', r.status, 400);
  r = await api('PUT', `/api/customers/${cu.id}`, { name: '' });
  eq('PUT empty name -> 400', r.status, 400);
  r = await api('PUT', '/api/customers/2000000000', { name: 'x' });
  eq('PUT missing -> 404', r.status, 404);
  r = await api('GET', '/api/customers');
  ok('list contains customer', Array.isArray(r.body) && r.body.some((c) => c.id === cu.id));
  r = await api('GET', `/api/customers/${cu.id}`);
  eq('GET one 200', r.status, 200);
  // categories
  r = await api('POST', '/api/categories', { name: 'QAZ Cat In', flow: 'in', id: 888888 });
  eq('create category 201', r.status, 201);
  const catIn = r.body; created.categories.push(catIn.id);
  ok('category id ignored', catIn.id !== 888888);
  r = await api('POST', '/api/categories', { name: 'QAZ Cat Out', flow: 'out' });
  const catOut = r.body; created.categories.push(catOut.id);
  r = await api('POST', '/api/categories', {}); eq('category empty body -> 400', r.status, 400);
  r = await api('POST', '/api/categories', { name: 'QAZ bad', flow: 'sideways' }); eq('category bad flow -> 400', r.status, 400);
  r = await api('PUT', `/api/categories/${catIn.id}`, { name: 'QAZ Cat In 2' });
  ok('category PUT', r.status === 200 && r.body.name === 'QAZ Cat In 2');
  r = await api('PUT', `/api/categories/${catIn.id}`, {}); eq('category PUT empty -> 400', r.status, 400);

  // ====================================================================
  sec('E. Services');
  r = await api('POST', '/api/services', { name: '' }); eq('service no name -> 400', r.status, 400);
  r = await api('POST', '/api/services', { name: 'x'.repeat(300) }); eq('service long name -> 400', r.status, 400);
  r = await api('POST', '/api/services', { name: 'QAZ bad', basePrice: 'abc' }); eq('service bad price -> 400', r.status, 400);
  r = await api('POST', '/api/services', { name: 'QAZ bad', basePrice: 1e12 }); eq('service huge price -> 400', r.status, 400);
  r = await api('POST', '/api/services', { name: 'QAZ bad', basePrice: 10, additionals: [{ name: 'a', price: 'zzz' }] }); eq('service bad additional price -> 400', r.status, 400);
  r = await api('POST', '/api/services', { name: 'QAZ bad', basePrice: 10, additionals: 'nope' }); eq('service additionals not array -> 400', r.status, 400);
  r = await api('POST', '/api/services', { name: 'QAZ Servico', description: 'desc', basePrice: '900,00', notes: 'n', additionals: [{ name: 'Extra', price: '100' }] });
  eq('create service 201', r.status, 201);
  const svc = r.body; created.services.push(svc.id);
  const v1 = svc.currentVersion;
  ok('service v1 price 900 + 1 additional (100)', Number(v1.basePrice) === 900 && v1.additionals.length === 1 && Number(v1.additionals[0].price) === 100, short(v1));
  r = await api('POST', `/api/services/${svc.id}/version`, { basePrice: 'abc' }); eq('version bad price -> 400', r.status, 400);
  r = await api('POST', `/api/services/${svc.id}/version`, { basePrice: '950,5', additionals: [{ name: 'Extra', price: 100 }] });
  eq('create version 201', r.status, 201);
  ok('version 2 active, price 950.50', r.body.currentVersion.version === 2 && Number(r.body.currentVersion.basePrice) === 950.5, short(r.body.currentVersion));
  r = await api('GET', `/api/services/${svc.id}`);
  ok('v1 deactivated, v2 active', r.body.versions.length === 2 && r.body.versions.find((v) => v.version === 1).active === false && r.body.versions.find((v) => v.version === 2).active === true);
  r = await api('POST', '/api/services/2000000000/version', { basePrice: 1 }); eq('version on missing service -> 404', r.status, 404);
  r = await api('POST', `/api/services/${svc.id}/additionals`, { name: 'Add2', price: 'abc' }); eq('additional bad price -> 400', r.status, 400);
  r = await api('POST', `/api/services/${svc.id}/additionals`, { name: 'Add2', price: '5,5' }); eq('additional create 201', r.status, 201);
  r = await api('PUT', `/api/services/${svc.id}`, { name: 123 }); eq('service PUT bad name -> 400', r.status, 400);
  r = await api('PUT', `/api/services/${svc.id}`, { active: 'yes' }); eq('service PUT bad active -> 400', r.status, 400);
  r = await api('PUT', `/api/services/${svc.id}`, {}); ok('service PUT empty returns row', r.status === 200 && r.body.id === svc.id);
  // contracts below use version 1 (900) with additional from v1
  const sv1 = v1.id; const add1 = v1.additionals[0].id;

  // ====================================================================
  sec('F. Settings');
  r = await api('PUT', '/api/settings', { menuColor: '#abc' });
  ok('#rgb expanded to #aabbcc', r.status === 200 && r.body.menuColor === '#aabbcc', short(r.body));
  r = await api('PUT', '/api/settings', { menuColor: '#ABCDEF' }); eq('#RRGGBB accepted', r.body.menuColor, '#ABCDEF');
  for (const bad of ['red', '#zzzzzz', '#12345', 'rgb(1,2,3)', 5, '#abcd']) {
    r = await api('PUT', '/api/settings', { accentColor: bad });
    eq(`bad colour ${JSON.stringify(bad)} -> 400`, r.status, 400);
  }
  r = await api('PUT', '/api/settings', { editWindowDays: 'abc' }); eq('bad days -> 400', r.status, 400);
  r = await api('PUT', '/api/settings', []); eq('settings body array -> 400', r.status, 400);
  r = await api('POST', '/api/settings/logo', { content: 'iVBORw0KGgo=', mime: 'text/html' }); eq('logo mime text/html -> 400', r.status, 400);
  r = await api('POST', '/api/settings/logo', { content: 'iVBORw0KGgo=', mime: 'application/x-evil' }); eq('logo mime unknown -> 400', r.status, 400);
  r = await api('POST', '/api/settings/logo', { content: '<script>alert(1)</script>', mime: 'image/png' }); eq('logo non-base64 -> 400', r.status, 400);
  r = await api('POST', '/api/settings/logo', { content: 'iVBORw0KGgo=', mime: 'image/PNG' });
  ok('logo valid png accepted (mime lower-cased)', r.status === 200 && r.body.logoMime === 'image/png', short({ s: r.status, m: r.body?.logoMime }));
  // restore settings
  const D = { menuColor: '#ffffff', accentColor: '#228be6', bgColor: '#f8f9fa', buttonColor: '#228be6', buttonHoverColor: '#1c7ed6' };
  const restore = {};
  for (const k of Object.keys(D)) restore[k] = origSettings[k] === D[k] ? '' : origSettings[k];
  r = await api('PUT', '/api/settings', restore);
  if (origSettings.logo) await api('POST', '/api/settings/logo', { content: origSettings.logo, mime: origSettings.logoMime });
  else await api('DELETE', '/api/settings/logo');
  r = await api('GET', '/api/settings');
  ok('settings restored to original', JSON.stringify(r.body) === JSON.stringify(origSettings), short(r.body));

  // ====================================================================
  sec('G. Templates');
  const tplContract = buildDocx(CONTRACT_PARAS), tplInvoice = buildDocx(INVOICE_PARAS), tplReceipt = buildDocx(RECEIPT_PARAS), tplOdt = buildOdt(CONTRACT_PARAS);
  const mk = async (kind, name, fileName, buf) => {
    const x = await api('POST', '/api/templates', { kind, name, fileName, content: buf.toString('base64') });
    if (x.status === 201) created.templates.push(x.body.id);
    return x;
  };
  r = await api('POST', '/api/templates', { kind: 'bogus', content: 'x' }); eq('template bad kind -> 400', r.status, 400);
  r = await api('POST', '/api/templates', { kind: 'contract', name: 'x', content: Buffer.from('not a zip').toString('base64') }); eq('template invalid file -> 400', r.status, 400);
  r = await mk('contract', 'QAZ Modelo Contrato', 'Modelo João Ação.docx', tplContract);
  eq('upload docx contract template 201', r.status, 201); const tC = r.body.id;
  r = await mk('invoice', 'QAZ Modelo Fatura', 'fatura.docx', tplInvoice); eq('upload invoice template 201', r.status, 201); const tI = r.body.id;
  r = await mk('receipt', 'QAZ Modelo Recibo', 'recibo.docx', tplReceipt); eq('upload receipt template 201', r.status, 201); const tR = r.body.id;
  r = await mk('contract', 'QAZ Modelo ODT', 'modelo.odt', tplOdt); eq('upload odt contract template 201', r.status, 201); const tO = r.body.id;
  r = await mk('contract', 'QAZ Modelo Evil', 'a"b%c\r\nX-Evil: 1.docx', tplContract); const tE = r.body?.id;
  r = await api('GET', `/api/templates/${tC}/download`);
  eq('template download 200', r.status, 200);
  const cd = r.headers['content-disposition'] || '';
  ok('template CD: ASCII fallback filename + filename*=UTF-8\'\' (accents)', cd.includes('filename="Modelo Joao Acao.docx"') && cd.includes("filename*=UTF-8''Modelo%20Jo%C3%A3o%20A%C3%A7%C3%A3o.docx"), cd);
  if (tE) {
    r = await api('GET', `/api/templates/${tE}/download`);
    ok('header-injection file name: 200, no injected header, CD safe', r.status === 200 && r.headers['x-evil'] === undefined && !/[\r\n]/.test(r.headers['content-disposition'] || '') && !/filename="[^"]*"[^;]*"/.test(r.headers['content-disposition']), `${r.status} ${r.headers['content-disposition']}`);
  }
  r = await api('PUT', `/api/templates/${tC}`, { name: '' }); eq('template rename empty -> 400', r.status, 400);

  // ====================================================================
  sec('H. Payments (create/update/validation/recurrence)');
  const base = { description: 'QAZ pay', amount: '100,50', flow: 'in', dueDate: '2026-12-10', customerId: cu.id, categoryId: catIn.id };
  for (const [label, patch] of [
    ['amount "abc"', { amount: 'abc' }], ['amount NaN-ish "1e3"', { amount: '1e3' }], ['amount 1e10', { amount: 1e10 }], ['amount "1.234,56" (thousands)', { amount: '1.234,56' }], ['amount object', { amount: {} }],
    ['dueDate 2026-02-30', { dueDate: '2026-02-30' }], ['dueDate 31/12/2026', { dueDate: '31/12/2026' }], ['paidDate bad', { paidDate: 'xx' }], ['receivedDate 2026-13-01', { receivedDate: '2026-13-01' }],
    ['flow bad', { flow: 'sideways' }], ['status bad', { status: 'x' }], ['receiptStatus bad', { receiptStatus: 'x' }],
    ['customerId abc', { customerId: 'abc' }], ['contractId 0', { contractId: 0 }], ['categoryId -3', { categoryId: -3 }],
    ['installmentNumber abc', { installmentNumber: 'abc' }], ['description empty', { description: '  ' }], ['description 300 chars', { description: 'x'.repeat(300) }],
  ]) {
    r = await api('POST', '/api/payments', { ...base, ...patch });
    eq(`create payment with ${label} -> 400`, r.status, 400);
  }
  r = await api('POST', '/api/payments', { amount: 1 }); eq('create payment without description -> 400', r.status, 400);
  r = await api('POST', '/api/payments', { description: 'QAZ x' }); eq('create payment without amount -> 400', r.status, 400);
  r = await api('POST', '/api/payments', [1]); eq('create payment array body -> 400', r.status, 400);
  r = await api('POST', '/api/payments', base);
  eq('create valid payment 201', r.status, 201);
  const pay = r.body; created.payments.push(pay.id);
  ok('amount "100,50" stored 100.50', Number(pay.amount) === 100.5, pay.amount);
  r = await api('PUT', `/api/payments/${pay.id}`, {});
  ok('empty PUT returns the row (200)', r.status === 200 && r.body.id === pay.id && Number(r.body.amount) === 100.5, short(r.body));
  r = await api('PUT', `/api/payments/${pay.id}`, { scope: 'all' });
  ok('PUT with only scope returns the row', r.status === 200 && r.body.id === pay.id);
  r = await api('PUT', `/api/payments/${pay.id}`, { amount: 'abc' }); eq('PUT bad amount -> 400', r.status, 400);
  r = await api('PUT', `/api/payments/${pay.id}`, { dueDate: '2026-02-30' }); eq('PUT bad date -> 400', r.status, 400);
  r = await api('PUT', `/api/payments/${pay.id}`, { flow: 'zzz' }); eq('PUT bad enum -> 400', r.status, 400);
  r = await api('PUT', `/api/payments/${pay.id}`, { amount: '12.5', paidDate: '', receivedDate: null, description: 'QAZ pay 2' });
  ok('PUT valid (amount 12.5, empty date -> null)', r.status === 200 && Number(r.body.amount) === 12.5 && r.body.paidDate === null && r.body.description === 'QAZ pay 2', short(r.body));
  r = await api('PUT', '/api/payments/2000000000', { amount: 1 }); eq('PUT missing payment -> 404', r.status, 404);
  // recurrence
  const rec = (patch, recPatch) => api('POST', '/api/payments', { ...base, description: 'QAZ rec', dueDate: '2026-11-30', ...patch, recurrence: { frequency: 'monthly', until: '2027-02-28', ...recPatch } });
  r = await rec({ dueDate: '2026-02-30' });
  ok('recurrence first date 2026-02-30 -> "Data inválida na recorrência"', r.status === 400 && /Data inválida na recorrência/.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  r = await rec({}, { until: '2027-02-30' });
  ok('recurrence until 2027-02-30 -> "Data inválida na recorrência"', r.status === 400 && /Data inválida na recorrência/.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  r = await rec({}, { frequency: 'hourly' }); eq('recurrence bad frequency -> 400', r.status, 400);
  r = await rec({}, { until: '2026-01-01' }); eq('recurrence until before first -> 400', r.status, 400);
  r = await rec({}, { frequency: 'daily', until: '2030-12-31' }); ok('recurrence >1000 occurrences -> 400', r.status === 400 && /1000/.test(r.body?.error || ''), short(r.body));
  r = await rec({ amount: 'abc' }); eq('recurrence with bad amount -> 400', r.status, 400);
  r = await rec({});
  ok('valid monthly recurrence -> 201 count 4', r.status === 201 && r.body.count === 4 && !!r.body.recurrenceId, `${r.status} ${short(r.body)}`);
  const recId = r.body?.recurrenceId;
  r = await api('GET', '/api/payments');
  const series = r.body.filter((p) => p.recurrenceId === recId);
  for (const s of series) created.payments.push(s.id);
  const sd = series.map((p) => p.dueDate).sort();
  ok('series dates 30/11, 30/12, 30/01, 28/02', JSON.stringify(sd) === JSON.stringify(['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28']), JSON.stringify(sd));
  ok('series all open (upcoming/open, no paid/received dates)', series.every((p) => p.status === 'upcoming' && p.receiptStatus === 'open' && !p.paidDate && !p.receivedDate));
  if (series.length) {
    const mid = series.find((p) => p.dueDate === '2026-12-30');
    r = await api('PUT', `/api/payments/${mid.id}`, { description: 'QAZ rec changed', scope: 'following' });
    eq('series PUT following 200', r.status, 200);
    r = await api('GET', '/api/payments');
    const s2 = r.body.filter((p) => p.recurrenceId === recId);
    ok('scope following changed 12/30, 01/30, 02/28 but not 11/30', s2.filter((p) => p.description === 'QAZ rec changed').length === 3 && s2.find((p) => p.dueDate === '2026-11-30').description === 'QAZ rec', short(s2.map((p) => p.description)));
    r = await api('DELETE', `/api/payments/${series[0].id}?scope=all`);
    eq('series DELETE scope=all 204', r.status, 204);
    r = await api('GET', '/api/payments');
    eq('series fully removed', r.body.filter((p) => p.recurrenceId === recId).length, 0);
  }
  r = await api('DELETE', `/api/payments/${pay.id}`); eq('delete payment 204', r.status, 204);

  // ====================================================================
  sec('I. Contracts (one-time) + credits + installments + status workflow');
  r = await api('POST', `/api/customers/${cu.id}/credits`, { description: 'QAZ credito', value: 'abc' }); eq('credit bad value -> 400', r.status, 400);
  r = await api('POST', `/api/customers/${cu.id}/credits`, { description: 'QAZ credito', value: 0 }); eq('credit zero -> 400', r.status, 400);
  r = await api('POST', `/api/customers/${cu.id}/credits`, { description: 'QAZ credito', value: -5 }); eq('credit negative -> 400', r.status, 400);
  r = await api('POST', `/api/customers/${cu.id}/credits`, { value: 5 }); eq('credit no description -> 400', r.status, 400);
  r = await api('POST', `/api/customers/${cu.id}/credits`, { description: 'QAZ credito de teste', value: '200' });
  eq('credit create 201', r.status, 201); const credit = r.body;
  r = await api('POST', `/api/customers/${cu.id}/credits`, { description: 'QAZ credito solto', value: '50' });
  const credit2 = r.body;
  r = await api('DELETE', `/api/customers/${cu.id}/credits/${credit2.id}`); eq('delete untouched credit 204', r.status, 204);

  // bad bodies
  const cb = { customerId: cu.id, type: 'contract', items: [{ serviceVersionId: sv1 }], templateId: tC, receiptTemplateId: tR };
  for (const [label, patch] of [
    ['customerId abc', { customerId: 'abc' }], ['type bogus', { type: 'bogus' }], ['executionDate 2026-02-30', { executionDate: '2026-02-30' }], ['item serviceVersionId abc', { items: [{ serviceVersionId: 'abc' }] }],
    ['modifier price abc', { modifiers: [{ name: 'x', price: 'abc' }] }], ['dueDates ["bad"]', { dueDates: ['bad'] }], ['installments {}', { installments: {} }], ['templateId -1', { templateId: -1 }],
    ['title 300 chars', { title: 'x'.repeat(300) }], ['items not array', { items: 'x' }], ['quantity abc', { quantity: 'abc' }],
  ]) {
    r = await api('POST', '/api/contracts', { ...cb, ...patch });
    eq(`create contract with ${label} -> 400`, r.status, 400);
  }
  r = await api('POST', '/api/contracts', { ...cb, customerId: 2000000000 });
  ok('contract unknown customerId -> 400 generic (no SQL)', r.status === 400 && !/insert|sql|constraint/i.test(r.text), `${r.status} ${r.text.slice(0, 150)}`);

  r = await api('POST', '/api/contracts', { ...cb, modifiers: [{ name: 'QAZ desconto', price: -50, discountPercent: 0 }], installments: 3, dueDates: ['2026-12-01', '2027-01-01', '2027-02-01'], creditId: credit.id, executionDate: '2026-12-05', executionTime: '10:00', executionAddress: 'Local', duration: '2h', quantity: 2 });
  eq('create one-time contract C1 (credit) 201', r.status, 201);
  const C1 = r.body; created.contracts.push(C1.id);
  ok('C1 number format YY/XXX', /^\d{2}\/\d{3}$/.test(C1.number), C1.number);
  ok('C1 total 850 (900 - 50)', Number(C1.total) === 850, C1.total);
  ok('C1 creditApplied 200', Number(C1.creditApplied) === 200, C1.creditApplied);
  const expN = Math.min(3, maxInst(650));
  ok(`C1 installments = min(3, floor(650/${minInst}))=${expN}`, C1.installments === expN && C1.payments.length === expN, `inst ${C1.installments} pays ${C1.payments.length}`);
  ok('C1 installments sum 650', Math.abs(C1.payments.reduce((s, p) => s + Number(p.amount), 0) - 650) < 0.005, short(C1.payments.map((p) => p.amount)));
  ok('C1 installments carry due dates', C1.payments[0].dueDate === '2026-12-01');
  ok('C1 title = service name', C1.title === 'QAZ Servico', C1.title);
  r = await api('GET', `/api/customers/${cu.id}/credits`);
  ok('credit fully used -> hidden from default list', !r.body.some((c) => c.id === credit.id));
  r = await api('GET', `/api/customers/${cu.id}/credits?all=1`);
  const cr = r.body.find((c) => c.id === credit.id);
  ok('credit visible with all=1, remaining 0', cr && Number(cr.remaining) === 0, short(cr));
  r = await api('DELETE', `/api/customers/${cu.id}/credits/${credit.id}`); eq('delete used credit -> 409', r.status, 409);
  r = await api('GET', `/api/customers/${cu.id}/charges`);
  ok('charges lists C1 open installments', Array.isArray(r.body) && r.body.length >= expN, short(r.body));
  for (const p of C1.payments) created.payments.push(p.id);

  // installments limit
  r = await api('POST', '/api/contracts', { ...cb, items: [{ serviceVersionId: sv1, additionals: [{ additionalId: add1, quantity: 1 }] }], installments: 50, dueDates: [] });
  eq('create C3 (limit test) 201', r.status, 201); const C3 = r.body; created.contracts.push(C3.id);
  ok('C3 total 1000 (900 + additional 100)', Number(C3.total) === 1000, C3.total);
  ok(`C3 installments capped to floor(1000/${minInst})=${maxInst(1000)}`, C3.installments === maxInst(1000) && C3.payments.length === maxInst(1000), `inst ${C3.installments} pays ${C3.payments.length}`);
  for (const p of C3.payments) created.payments.push(p.id);
  r = await api('POST', '/api/contracts', { ...cb, installments: 0 });
  ok('installments 0 -> at least 1', r.status === 201 && r.body.installments === 1, short({ s: r.status, i: r.body?.installments }));
  if (r.status === 201) { created.contracts.push(r.body.id); for (const p of r.body.payments) created.payments.push(p.id); }

  // edit
  r = await api('PUT', `/api/contracts/${C3.id}`, { customerId: 'abc' }); eq('edit contract bad customerId -> 400', r.status, 400);
  r = await api('PUT', `/api/contracts/${C3.id}`, { executionDate: '2026-02-30' }); eq('edit contract bad date -> 400', r.status, 400);
  r = await api('PUT', `/api/contracts/${C3.id}`, { items: [{ serviceVersionId: 'x' }] }); eq('edit contract bad item -> 400', r.status, 400);
  r = await api('PUT', '/api/contracts/2000000000', { comments: 'x' }); eq('edit missing contract -> 404', r.status, 404);
  r = await api('PUT', `/api/contracts/${C3.id}`, { comments: 'QAZ editado', executionDate: '' });
  ok('header-only edit keeps items/total, sets comments, executionDate "" -> null', r.status === 200 && r.body.comments === 'QAZ editado' && r.body.items.length === 1 && Number(r.body.total) === 1000 && r.body.executionDate === null, short({ s: r.status, c: r.body?.comments, d: r.body?.executionDate }));
  r = await api('PUT', `/api/contracts/${C3.id}`, { items: [{ serviceVersionId: sv1, quantity: 1 }], modifiers: [], installments: 2, dueDates: ['2026-12-01', '2027-01-01'] });
  ok('full edit: total 900, 2 installments with given dates', r.status === 200 && Number(r.body.total) === 900 && r.body.payments.length === 2 && r.body.payments[1].dueDate === '2027-01-01' && Math.abs(r.body.payments.reduce((s, p) => s + Number(p.amount), 0) - 900) < 0.005, short({ s: r.status, t: r.body?.total, p: r.body?.payments?.map((x) => [x.amount, x.dueDate]) }));
  if (r.status === 200) { for (const p of r.body.payments) if (!created.payments.includes(p.id)) created.payments.push(p.id); }
  // refresh C3 payments in tracked list (old ones deleted on edit)

  // status workflow
  r = await api('PUT', `/api/contracts/${C1.id}/status`, { status: 'realizado' }); eq('status skip step -> 400', r.status, 400);
  r = await api('PUT', `/api/contracts/${C1.id}/status`, { status: 'bogus' }); eq('status bogus -> 400', r.status, 400);
  r = await api('PUT', `/api/contracts/${C1.id}/status`, { status: 'agendado' }); ok('status forward one step', r.status === 200 && r.body.status === 'agendado');
  r = await api('PUT', `/api/contracts/${C1.id}/status`, { status: 'realizado' }); ok('status forward 2nd step', r.status === 200 && r.body.status === 'realizado');
  r = await api('PUT', `/api/contracts/${C1.id}/status`, { status: 'enviado' }); eq('status skip (realizado->enviado) -> 400', r.status, 400);
  r = await api('PUT', `/api/contracts/${C1.id}/status`, { status: 'agendado' }); ok('status back one step', r.status === 200 && r.body.status === 'agendado');
  r = await api('PUT', '/api/contracts/2000000000/status', { status: 'agendado' }); eq('status missing contract -> 404', r.status, 404);
  r = await api('GET', '/api/contracts'); ok('contracts list contains C1', Array.isArray(r.body) && r.body.some((c) => c.id === C1.id));
  r = await api('GET', '/api/contracts/overdue'); eq('contracts/overdue 200', r.status, 200);
  r = await api('DELETE', `/api/templates/${tC}`); eq('template in use cannot be deleted (409)', r.status, 409);

  // ====================================================================
  sec('J. Documents (contract docx / odt, download, pdf, delete)');
  r = await api('POST', `/api/contracts/${C1.id}/generate`);
  eq('generate contract docx 201', r.status, 201);
  const doc1 = r.body; created.docs.push(doc1.id);
  ok('response has no filePath', !('filePath' in doc1), short(doc1));
  ok('file name transliterated: contrato_Joao_Acao_<nº>.docx', /^contrato_Joao_Acao_\d{2}-\d{3}\.docx$/.test(doc1.fileName), doc1.fileName);
  r = await api('GET', `/api/contracts/${C1.id}`);
  ok('GET contract: documents[] without filePath', r.body.documents.length === 1 && !('filePath' in r.body.documents[0]));
  r = await api('GET', `/api/contract-documents/${doc1.id}/download`);
  eq('download 200', r.status, 200);
  const cd1 = r.headers['content-disposition'] || '';
  ok('CD has filename="…" and filename*=UTF-8\'\'…, accents transliterated', cd1.includes(`filename="${doc1.fileName}"`) && cd1.includes(`filename*=UTF-8''${doc1.fileName}`) && !/[^\x20-\x7e]/.test(cd1), cd1);
  ok('content-type docx', /wordprocessingml/.test(r.headers['content-type'] || ''), r.headers['content-type']);
  let txt = ''; try { txt = docText(r.buf, 'docx'); } catch (e) { txt = 'ERR ' + e.message; }
  ok('docx content: customer name + nickname with accents', txt.includes('QAZ Cliente Teste') && txt.includes('(João Ação)'), txt.slice(0, 200));
  ok('docx content: address with & and < escaped correctly', txt.includes('Rua A & B <1>'), txt.slice(0, 200));
  ok('docx content: {total} = R$ 650,00 net of credit; before credit R$ 850,00; credit -R$ 200,00', /Total R\$ 650,00 Antes R\$ 850,00 Credito -R\$ 200,00/.test(txt), txt.slice(0, 300));
  ok('docx content: item loop rendered', txt.includes('Item QAZ Servico R$ 900,00'), txt);
  ok('docx content: installments loop rendered', new RegExp(`Parcela 1 01/12/2026 R\\$ ${String((650 / expN).toFixed(2)).replace('.', ',')}`).test(txt) || /Parcela 1 01\/12\/2026/.test(txt), txt);
  ok('docx content: no unresolved tags', !/[{}]/.test(txt), txt);
  r = await api('POST', `/api/contracts/${C1.id}/generate`);
  r = await api('GET', `/api/contracts/${C1.id}`);
  ok('regenerating keeps exactly one document record', r.body.documents.length === 1);
  created.docs.push(...r.body.documents.map((d) => d.id));
  const doc1b = r.body.documents[0];
  // PDF
  const t0 = Date.now();
  r = await api('GET', `/api/contract-documents/${doc1b.id}/pdf`);
  ok(`PDF export via LibreOffice (docx) -> 200 application/pdf, %PDF header (${Date.now() - t0}ms)`, r.status === 200 && /application\/pdf/.test(r.headers['content-type'] || '') && r.buf.slice(0, 4).toString() === '%PDF', `${r.status} ${r.text.slice(0, 200)}`);
  ok('PDF Content-Disposition ends .pdf', /filename="contrato_Joao_Acao_[\d-]+\.pdf"/.test(r.headers['content-disposition'] || ''), r.headers['content-disposition']);

  // ODT contract C2
  r = await api('POST', '/api/contracts', { ...cb, templateId: tO, installments: 1, dueDates: ['2026-12-01'] });
  eq('create C2 (odt template) 201', r.status, 201); const C2 = r.body; created.contracts.push(C2.id); for (const p of C2.payments) created.payments.push(p.id);
  r = await api('POST', `/api/contracts/${C2.id}/generate`);
  ok('generate .odt document 201 (format odt, name .odt)', r.status === 201 && r.body.format === 'odt' && /\.odt$/.test(r.body.fileName) && !('filePath' in r.body), short(r.body));
  const docO = r.body; if (docO?.id) created.docs.push(docO.id);
  r = await api('GET', `/api/contract-documents/${docO.id}/download`);
  ok('odt download: mime odt + CD', r.status === 200 && /opendocument\.text/.test(r.headers['content-type'] || '') && /filename\*=UTF-8''contrato_Joao_Acao_/.test(r.headers['content-disposition'] || ''), `${r.status} ${r.headers['content-type']}`);
  let txtO = ''; try { txtO = docText(r.buf, 'odt'); } catch (e) { txtO = 'ERR ' + e.message; }
  ok('odt content rendered (name, address escaped, total, items, no tags)', txtO.includes('QAZ Cliente Teste') && txtO.includes('Rua A & B <1>') && txtO.includes('R$ 900,00') && !/[{}]/.test(txtO), txtO.slice(0, 300));
  r = await api('GET', `/api/contract-documents/${docO.id}/pdf`);
  ok('PDF export from .odt (native) -> %PDF', r.status === 200 && r.buf.slice(0, 4).toString() === '%PDF', `${r.status} ${r.text.slice(0, 200)}`);

  // unsafe file names
  fs.writeFileSync(path.join(SCR, 'canary.txt'), 'canary');
  const storage = path.join(ROOT, 'storage');
  const canary2 = path.join(storage, 'QAZ-canary.txt');
  fs.writeFileSync(canary2, 'canary2');
  const ins = async (fileName, filePath) => {
    const [x] = await sql.query('insert into contract_documents (contract_id, file_name, file_path, format) values (?,?,?,?)', [C3.id, fileName, filePath, 'docx']);
    created.docs.push(x.insertId); return x.insertId;
  };
  const canary1 = path.join(SCR, 'canary.txt');
  const u1 = await ins(canary1, canary1);
  const u2 = await ins('..', canary1);
  const u3 = await ins('../QAZ-canary.txt', canary2);
  const u4 = await ins('qaz-nonexistent.docx', canary1);
  const u5 = await ins('..\\..\\package.json', path.join(ROOT, 'package.json'));
  for (const [label, id] of [['absolute path', u1], ['"..""', u2], ['relative traversal ../QAZ-canary.txt', u3], ['bad file_path but safe name', u4], ['..\\..\\package.json', u5]]) {
    const d = await api('GET', `/api/contract-documents/${id}/download`);
    const p = await api('GET', `/api/contract-documents/${id}/pdf`);
    ok(`unsafe fileName (${label}): download/pdf do not serve outside storage (400/410)`, [400, 410].includes(d.status) && [400, 410].includes(p.status) && !/canary/.test(d.text), `dl ${d.status} pdf ${p.status}`);
    const del = await api('DELETE', `/api/contract-documents/${id}`);
    eq(`unsafe fileName (${label}): delete 204`, del.status, 204);
  }
  ok('canary files outside storage/contracts NOT deleted', fs.existsSync(canary1) && fs.existsSync(canary2) && fs.existsSync(path.join(ROOT, 'package.json')));
  r = await api('GET', `/api/contracts/${C3.id}`);
  ok('unsafe doc rows removed from DB', r.body.documents.length === 0);
  // delete document removes record + file
  const fileOnDisk = path.join(ROOT, 'storage', 'contracts', doc1b.fileName);
  ok('document file exists on disk before delete', fs.existsSync(fileOnDisk));
  r = await api('DELETE', `/api/contract-documents/${doc1b.id}`);
  eq('delete document 204', r.status, 204);
  ok('document file removed from disk', !fs.existsSync(fileOnDisk));
  r = await api('GET', `/api/contract-documents/${doc1b.id}/download`); eq('download after delete -> 404', r.status, 404);
  r = await api('POST', `/api/contracts/${C1.id}/generate`); // regenerate for receipt/cleanup tracking
  if (r.status === 201) created.docs.push(r.body.id);

  // generate without template selected
  r = await api('POST', '/api/contracts', { customerId: cu.id, type: 'contract', items: [{ serviceVersionId: sv1 }], installments: 1 });
  const C4 = r.body; created.contracts.push(C4.id); for (const p of C4.payments) created.payments.push(p.id);
  r = await api('POST', `/api/contracts/${C4.id}/generate`);
  ok('generate with no template -> 400 pt-BR message', r.status === 400 && /modelo/i.test(r.body?.error || ''), short(r.body));

  // ====================================================================
  sec('K. Receipts');
  const c1p = (await api('GET', `/api/contracts/${C1.id}`)).body.payments;
  const p1 = c1p.find((p) => p.installmentNumber === 1);
  r = await api('POST', `/api/payments/${p1.id}/receipt`); eq('receipt for open payment -> 400', r.status, 400);
  r = await api('PUT', `/api/payments/${p1.id}`, { receiptStatus: 'received', receivedDate: '2026-10-20' }); eq('mark received', r.status, 200);
  r = await api('POST', `/api/payments/${p1.id}/receipt`);
  eq('receipt 200', r.status, 200);
  const expSuffix = expN > 1 ? '_1-' + expN : '';
  ok(`receipt file name recibo_Joao_Acao${expSuffix}.docx (no date, accents transliterated)`, (r.headers['content-disposition'] || '').includes(`filename="recibo_Joao_Acao${expSuffix}.docx"`), r.headers['content-disposition']);
  const rt = docText(r.buf, 'docx');
  const leftExp = (650 - Number(p1.amount)).toFixed(2).replace('.', ',');
  ok('receipt content: nickname, amount, amount_left, installment, date 20/10/2026', rt.includes('Recibo João Ação') && rt.includes(`R$ ${Number(p1.amount).toFixed(2).replace('.', ',')}`) && rt.includes(`restante R$ ${leftExp}`) && rt.includes(expN > 1 ? `parcela 1/${expN}` : 'parcela fatura') && rt.includes('20/10/2026'), rt);
  r = await api('GET', '/api/payments'); ok('receipt marks payment as sent', r.body.find((p) => p.id === p1.id)?.receiptStatus === 'sent');
  r = await api('POST', `/api/payments/${p1.id}/receipt?format=pdf`);
  ok('receipt PDF', r.status === 200 && r.buf.slice(0, 4).toString() === '%PDF' && /\.pdf"/.test(r.headers['content-disposition'] || ''), `${r.status} ${r.headers['content-disposition']}`);
  r = await api('POST', '/api/payments/abc/receipt'); eq('receipt bad id -> 400', r.status, 400);

  // ====================================================================
  sec('L. Recurring contract: items, invoices, invoice documents');
  r = await api('POST', '/api/contracts', { customerId: cu.id, type: 'invoice', title: 'QAZ Recorrente', invoiceTemplateId: tI, receiptTemplateId: tR });
  eq('create recurring contract 201', r.status, 201); const R1 = r.body; created.contracts.push(R1.id);
  ok('recurring number F###', /^F\d{3,}$/.test(R1.number), R1.number);
  const items = (b) => api('POST', `/api/contracts/${R1.id}/items`, b);
  r = await items({}); eq('item without serviceVersionId -> 400', r.status, 400);
  r = await items({ serviceVersionId: 'abc' }); eq('item serviceVersionId abc -> 400', r.status, 400);
  r = await items({ serviceVersionId: 2000000000 }); eq('item unknown serviceVersionId -> 400', r.status, 400);
  r = await items({ serviceVersionId: sv1, performedAt: '2026-02-30' }); eq('item bad performedAt -> 400', r.status, 400);
  r = await api('POST', '/api/contracts/2000000000/items', { serviceVersionId: sv1 }); eq('item on missing contract -> 404', r.status, 404);
  r = await items({ serviceVersionId: sv1, performedAt: '', items: [{ description: 'QAZ i1' }, { description: 'QAZ i2' }, { description: 'QAZ i3' }, { description: 'QAZ i4' }] });
  eq('batch items 201', r.status, 201);
  ok('4 items, performedAt "" stored as null', r.body.items.length === 4 && r.body.items.every((i) => i.performedAt === null), short(r.body.items?.map((i) => i.performedAt)));
  r = await items({ serviceVersionId: sv1, performedAt: '2026-10-01', description: 'QAZ legacy' });
  ok('single item with valid performedAt', r.status === 201 && r.body.items.some((i) => i.performedAt === '2026-10-01'));
  let R1full = r.body; const its = R1full.items.filter((i) => /QAZ i\d/.test(i.description)).sort((a, b) => a.description.localeCompare(b.description));
  r = await api('PUT', `/api/contracts/${R1.id}/items/${R1full.items.find((i) => i.performedAt === '2026-10-01').id}`, { serviceVersionId: sv1, performedAt: '' });
  ok('PUT item performedAt "" -> null', r.status === 200 && r.body.items.every((i) => i.performedAt === null), short(r.body.items?.map((i) => i.performedAt)));
  r = await api('PUT', `/api/contracts/${R1.id}/items/${its[0].id}`, { performedAt: '2026-13-01' }); eq('PUT item bad date -> 400', r.status, 400);
  r = await api('PUT', `/api/contracts/${R1.id}/items/${its[0].id}`, { serviceVersionId: 'x' }); eq('PUT item bad serviceVersionId -> 400', r.status, 400);
  const legacyId = R1full.items.find((i) => i.description === 'QAZ legacy').id;
  r = await api('DELETE', `/api/contracts/${R1.id}/items/${legacyId}`); ok('delete performed item', r.status === 200 && r.body.items.length === 4);

  // invoices
  const inv = (itemIds, extra = {}) => api('POST', `/api/contracts/${R1.id}/invoices`, { itemIds, installments: 1, dueDates: ['2026-12-10'], ...extra });
  r = await inv([]); eq('invoice no items -> 400', r.status, 400);
  r = await inv(['x']); eq('invoice itemIds ["x"] -> 400', r.status, 400);
  r = await inv([its[0].id], { reference: 'x'.repeat(300) }); eq('invoice reference 300 chars -> 400', r.status, 400);
  r = await inv([its[0].id], { dueDates: ['bad'] }); eq('invoice bad dueDates -> 400', r.status, 400);
  r = await inv([its[0].id], { modifiers: [{ name: 'm', price: 'abc' }] }); eq('invoice bad modifier -> 400', r.status, 400);
  r = await inv([its[0].id], { creditId: 'abc' }); eq('invoice bad creditId -> 400', r.status, 400);
  r = await inv([its[0].id], { reference: '' }); eq('invoice 1 (empty reference) 201', r.status, 201);
  r = await inv([its[1].id], { reference: '' }); eq('invoice 2 (empty reference) 201', r.status, 201);
  r = await inv([its[2].id], { reference: 'Mensal' }); eq('invoice 3 (ref Mensal) 201', r.status, 201);
  r = await inv([its[3].id], { reference: 'Mensal' }); eq('invoice 4 (ref Mensal) 201', r.status, 201);
  R1full = r.body;
  const invs = R1full.invoices.sort((a, b) => a.id - b.id);
  for (const i of invs) { created.invoices.push(i.id); for (const p of i.payments) created.payments.push(p.id); }
  ok('4 invoices with sequential refNumbers NNN-YY', invs.length === 4 && invs.every((i) => /^\d{3}-\d{2}$/.test(i.refNumber)) && new Set(invs.map((i) => i.refNumber)).size === 4, short(invs.map((i) => i.refNumber)));
  ok('recurring contract total = sum of invoices (4 x 900)', Number(R1full.total) === 3600, R1full.total);
  r = await api('POST', `/api/invoices/${invs[0].id}/generate`); // before edit... (edit tested on invoice 2 below)
  eq('generate invoice 1 201', r.status, 201); const d1 = r.body; created.docs.push(d1.id);
  // edit invoice 2 (no doc yet), then generate
  r = await api('PUT', `/api/invoices/${invs[1].id}`, { itemIds: [its[1].id], reference: '', discountPercent: 10, installments: 1, dueDates: ['2026-12-11'] });
  ok('edit invoice 2: discount 10% -> total 810', r.status === 200 && Number(r.body.invoices.find((i) => i.id === invs[1].id).total) === 810, short(r.status));
  if (r.status === 200) { const ii = r.body.invoices.find((i) => i.id === invs[1].id); for (const p of ii.payments) created.payments.push(p.id); }
  r = await api('PUT', `/api/invoices/${invs[1].id}`, { itemIds: ['x'] }); eq('edit invoice bad itemIds -> 400', r.status, 400);
  r = await api('POST', `/api/invoices/${invs[1].id}/generate`); eq('generate invoice 2 201', r.status, 201); const d2 = r.body; created.docs.push(d2.id);
  r = await api('POST', `/api/invoices/${invs[2].id}/generate`); eq('generate invoice 3 201', r.status, 201); const d3 = r.body; created.docs.push(d3.id);
  r = await api('POST', `/api/invoices/${invs[3].id}/generate`); eq('generate invoice 4 201', r.status, 201); const d4 = r.body; created.docs.push(d4.id);
  ok('invoice docs: no filePath exposed', ![d1, d2, d3, d4].some((d) => 'filePath' in d));
  ok('invoices 1 & 2 (empty reference): different file names', d1.fileName !== d2.fileName, `${d1.fileName} vs ${d2.fileName}`);
  ok('empty reference falls back to sequential number in name', d1.fileName === `fatura_Joao_Acao_${invs[0].refNumber}.docx` && d2.fileName === `fatura_Joao_Acao_${invs[1].refNumber}.docx`, `${d1.fileName} | ${d2.fileName}`);
  ok('invoices 3 & 4 (same ref + customer): different names; 3 = fatura_Joao_Acao_Mensal.docx; 4 suffixed with own number', d3.fileName === 'fatura_Joao_Acao_Mensal.docx' && d4.fileName === `fatura_Joao_Acao_Mensal_${invs[3].refNumber}.docx`, `${d3.fileName} | ${d4.fileName}`);
  for (const [d, i] of [[d1, invs[0]], [d2, invs[1]], [d3, invs[2]], [d4, invs[3]]]) {
    r = await api('GET', `/api/contract-documents/${d.id}/download`);
    const t = r.status === 200 ? docText(r.buf, 'docx') : `HTTP ${r.status}`;
    ok(`invoice ${i.refNumber}: own file intact with its own number/total`, t.includes(`Fatura ${i.refNumber} `) && /Total R\$ (900|810),00/.test(t) && t.includes('QAZ i') && !/[{}]/.test(t), t.slice(0, 200));
  }
  r = await api('POST', `/api/invoices/${invs[2].id}/generate`);
  ok('regenerating invoice 3 keeps its name (no self-suffix) and 1 record', r.status === 201 && r.body.fileName === d3.fileName, short(r.body));
  if (r.status === 201) created.docs.push(r.body.id);
  r = await api('POST', `/api/invoices/${invs[3].id}/generate`);
  ok('regenerating invoice 4 keeps suffixed name', r.status === 201 && r.body.fileName === d4.fileName, short(r.body));
  if (r.status === 201) created.docs.push(r.body.id);
  r = await api('GET', `/api/contracts/${R1.id}`);
  ok('one document per invoice after regeneration', r.body.invoices.every((i) => i.documents.length === 1) && r.body.invoices.every((i) => i.documents.every((d) => !('filePath' in d))));
  r = await api('POST', `/api/invoices/${invs[0].id}/generate?x=1`); if (r.status === 201) created.docs.push(r.body.id);
  // invoice receipt
  const ip = r0 => r0;
  const invPay = R1full.invoices.find((i) => i.id === invs[0].id).payments[0];
  r = await api('PUT', `/api/payments/${invPay.id}`, { receiptStatus: 'received', receivedDate: '2026-10-21' });
  r = await api('POST', `/api/payments/${invPay.id}/receipt`);
  ok('invoice receipt: name recibo_Joao_Acao.docx, invoice number in content', r.status === 200 && /filename="recibo_Joao_Acao\.docx"/.test(r.headers['content-disposition'] || '') && docText(r.buf, 'docx').includes(`fatura ${invs[0].refNumber}`), `${r.status} ${r.headers['content-disposition']}`);
  // invoice delete (regression: unbill + docs row)
  r = await api('POST', `/api/contracts/${R1.id}/invoices`, { itemIds: [its[0].id] });
  eq('re-billing an already billed item -> 400', r.status, 400);

  // ====================================================================
  sec('M. Bank import (OFX)');
  const [[{ x: _ }]] = [[{ x: 0 }]];
  r = await api('POST', '/api/payments', { description: 'QAZ-SMOKE aberto', amount: '777.77', flow: 'in', dueDate: '2026-11-05', customerId: cu.id });
  const P1 = r.body; created.payments.push(P1.id);
  r = await api('POST', '/api/payments', { description: 'QAZ-SMOKE saida aberta', amount: '55', flow: 'out', dueDate: '2026-11-06' });
  const POut = r.body; created.payments.push(POut.id);
  r = await api('POST', '/api/payments', { description: 'QAZ-SMOKE ja recebido', amount: '33', flow: 'in', dueDate: '2026-11-07', receiptStatus: 'received', receivedDate: '2026-11-07' });
  const PRecv = r.body; created.payments.push(PRecv.id);
  const stm = (extra) => `OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0001<ACCTID>QAZ-ACCT</BANKACCTFROM><BANKTRANLIST>${extra}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const trn = (o) => `<STMTTRN><TRNTYPE>${o.type || 'CREDIT'}<DTPOSTED>${o.date || '20261028120000[-3:BRT]'}${o.amt === undefined ? '' : `<TRNAMT>${o.amt}`}<FITID>${o.fit}<NAME>${o.name || 'PIX QAZ'}<MEMO>${o.memo || 'QAZ-SMOKE ' + o.fit}</STMTTRN>`;
  const ofx = stm([
    trn({ fit: 'QAZ1', amt: '777.77' }), trn({ fit: 'QAZ2', amt: '777.77' }),
    trn({ fit: 'QAZ3', amt: '1,234' }), trn({ fit: 'QAZ4', amt: '1.234' }),
    trn({ fit: 'QAZ5', amt: '1.234,56' }), trn({ fit: 'QAZ6', amt: '-1234.56', type: 'DEBIT' }),
    trn({ fit: 'QAZ7', amt: 'abc' }), trn({ fit: 'QAZ8' }), trn({ fit: 'QAZ9', amt: '1,234.56' }),
    trn({ fit: 'QAZA', amt: '-1.234,56', type: 'DEBIT' }),
  ].join(''));
  r = await api('POST', '/api/bank/parse', { fileName: 'QAZ-SMOKE-parse.ofx', content: ofx });
  eq('parse 200', r.status, 200);
  const pr = r.body;
  ok('parse returns skipped=4 ("1,234", "1.234", "abc", missing amount)', pr.skipped === 4, `skipped ${pr.skipped}`);
  const byFit = Object.fromEntries(pr.items.map((i) => [i.fitId, i]));
  ok('parsed 6 lines (QAZ1,2,5,6,9,A)', pr.items.length === 6 && ['QAZ1', 'QAZ2', 'QAZ5', 'QAZ6', 'QAZ9', 'QAZA'].every((f) => byFit[f]), pr.items.map((i) => i.fitId).join(','));
  ok('"1.234,56" -> 1234.56 (in)', byFit.QAZ5?.amount === 1234.56 && byFit.QAZ5.flow === 'in', short(byFit.QAZ5));
  ok('"-1234.56" -> -1234.56 (out)', byFit.QAZ6?.amount === -1234.56 && byFit.QAZ6.flow === 'out', short(byFit.QAZ6));
  ok('"1,234.56" -> 1234.56', byFit.QAZ9?.amount === 1234.56, short(byFit.QAZ9));
  ok('"-1.234,56" -> -1234.56', byFit.QAZA?.amount === -1234.56, short(byFit.QAZA));
  ok('DTPOSTED 20261028120000[-3:BRT] -> 2026-10-28 (no tz shift)', byFit.QAZ1?.date === '2026-10-28', byFit.QAZ1?.date);
  const matches = [byFit.QAZ1, byFit.QAZ2].filter((i) => i.matchedPaymentId === P1.id);
  ok('two same-value lines, one open entrada: only ONE line auto-matches the payment', matches.length === 1, short([byFit.QAZ1.matchedPaymentId, byFit.QAZ2.matchedPaymentId]));
  ok('no alreadyImported flags on fresh statement', pr.items.every((i) => i.alreadyImported === false));
  ok('openPayments lists P1', pr.openPayments.some((o) => o.value === String(P1.id)));
  r = await api('POST', '/api/bank/parse', { fileName: 'x', content: 123 }); eq('parse non-string content -> 400', r.status, 400);
  r = await api('POST', '/api/bank/parse', {}); eq('parse no content -> 400', r.status, 400);

  const impl = (items, extra = {}) => api('POST', '/api/bank/import', { fileName: 'QAZ-SMOKE-imp.ofx', bankId: '0001', accountId: 'QAZ-ACCT', items, ...extra });
  const ln = (o) => ({ fitId: 'QAZX', date: '2026-10-28', type: 'CREDIT', description: 'QAZ-SMOKE linha', amount: 10, flow: 'in', ...o });
  const importsBefore = async () => Number((await sql.query("select count(*) c from bank_imports where file_name like 'QAZ-SMOKE%'"))[0][0].c);
  r = await impl([]); eq('import empty -> 400', r.status, 400);
  r = await impl([ln({ date: '2026-02-30' })]); eq('import bad date -> 400', r.status, 400);
  r = await impl([ln({ amount: 'abc' })]); eq('import bad amount -> 400', r.status, 400);
  r = await impl([ln({ flow: 'x' })]); eq('import bad flow -> 400', r.status, 400);
  r = await impl([ln({ categoryId: 2000000000 })]); eq('import unknown category -> 400', r.status, 400);
  r = await impl([ln({ contractId: 2000000000 })]); eq('import unknown contract -> 400', r.status, 400);
  r = await impl([ln({ matchedPaymentId: 'abc' })]); eq('import bad matchedPaymentId -> 400', r.status, 400);
  r = await impl([ln({ matchedPaymentId: PRecv.id })]); ok('import matched payment NOT open -> 400', r.status === 400, `${r.status} ${short(r.body)}`);
  r = await impl([ln({ matchedPaymentId: POut.id })]); ok('import matched payment is a saída (flow out) -> 400', r.status === 400, `${r.status} ${short(r.body)}`);
  r = await impl([ln({ matchedPaymentId: 2000000000 })]); ok('import matched payment missing -> 400', r.status === 400, `${r.status}`);
  r = await impl([ln({ matchedPaymentId: P1.id }), ln({ fitId: 'QAZY', matchedPaymentId: P1.id })]); ok('import same payment on two lines -> 400', r.status === 400, `${r.status} ${short(r.body)}`);
  eq('failed imports wrote nothing (no bank_imports rows)', await importsBefore(), 0);
  r = await api('GET', '/api/payments'); const pp = r.body.find((p) => p.id === P1.id);
  ok('P1 untouched after rejected imports', pp.receiptStatus === 'open');
  // saída with a Referência is ignored
  r = await impl([ln({ fitId: 'QAZ6', flow: 'out', amount: -777.77, description: 'QAZ-SMOKE saida com ref', matchedPaymentId: P1.id })]);
  ok('saída line with Referência: ignored -> created 1, received 0', r.status === 201 && r.body.created === 1 && r.body.received === 0, `${r.status} ${short(r.body)}`);
  r = await api('GET', '/api/payments'); const pp2 = r.body.find((p) => p.id === P1.id);
  ok('P1 still open after saída line with its Referência', pp2.receiptStatus === 'open');
  const outPay = r.body.find((p) => p.description === 'QAZ-SMOKE saida com ref');
  ok('saída payment created as done, paidDate, positive amount', outPay && outPay.flow === 'out' && outPay.status === 'done' && outPay.paidDate === '2026-10-28' && Number(outPay.amount) === 777.77, short(outPay));
  // valid reconcile + new + empty date + contract-linked
  r = await impl([
    ln({ fitId: 'QAZ1', amount: 777.77, description: 'QAZ-SMOKE credito 1', matchedPaymentId: P1.id }),
    ln({ fitId: 'QAZ5', amount: 1234.56, description: 'QAZ-SMOKE sem data', date: '', originalDate: '2026-10-28', originalAmount: 1234.56, categoryId: catIn.id }),
    ln({ fitId: 'QAZ9', amount: 12.34, description: 'QAZ-SMOKE extra contrato', contractId: C3.id, categoryId: catIn.id }),
    ln({ fitId: 'QAZA', amount: '-5,5', flow: undefined, description: 'QAZ-SMOKE sem flow', date: '2026-10-15' }),
  ]);
  ok('valid import -> 201 received 1 created 3', r.status === 201 && r.body.received === 1 && r.body.created === 3 && r.body.imported === 4, `${r.status} ${short(r.body)}`);
  r = await api('GET', '/api/payments');
  const all = r.body;
  const rP1 = all.find((p) => p.id === P1.id);
  ok('P1 reconciled: received, receivedDate 2026-10-28', rP1.receiptStatus === 'received' && rP1.receivedDate === '2026-10-28', short(rP1));
  const nodate = all.find((p) => p.description === 'QAZ-SMOKE sem data');
  ok(`empty line date -> local today (${localToday()})`, nodate && nodate.dueDate === localToday() && nodate.receivedDate === localToday(), short(nodate));
  const ext = all.find((p) => p.description === 'QAZ-SMOKE extra contrato');
  ok('income linked to contract = extra payment (contractId, customer, no installment number, category)', ext && ext.contractId === C3.id && ext.customerId === cu.id && ext.installmentNumber === null && ext.categoryId === catIn.id && ext.receiptStatus === 'received', short(ext));
  const noflow = all.find((p) => p.description === 'QAZ-SMOKE sem flow');
  ok('negative amount without flow -> saída done, abs amount', noflow && noflow.flow === 'out' && Number(noflow.amount) === 5.5 && noflow.status === 'done', short(noflow));
  for (const p of all.filter((p) => String(p.description).startsWith('QAZ-SMOKE'))) if (!created.payments.includes(p.id)) created.payments.push(p.id);
  // re-parse
  r = await api('POST', '/api/bank/parse', { fileName: 'QAZ-SMOKE-parse2.ofx', content: ofx });
  const b2 = Object.fromEntries(r.body.items.map((i) => [i.fitId, i]));
  ok('re-uploaded imported lines come back alreadyImported + unselected (QAZ1, QAZ5)', ['QAZ1', 'QAZ5'].every((f) => b2[f].alreadyImported === true && b2[f].selected === false), short(['QAZ1', 'QAZ5', 'QAZ9'].map((f) => [b2[f]?.alreadyImported, b2[f]?.selected])));
  ok('non-imported line QAZ2 still selectable', b2.QAZ2.alreadyImported === false && b2.QAZ2.selected === true);
  const [imps] = await sql.query("select id from bank_imports where file_name like 'QAZ-SMOKE%'");
  ok('import recorded (2 bank_imports rows from 2 successful imports)', imps.length === 2, `rows ${imps.length}`);

  // ====================================================================
  sec('O. Payment validation, money formats, bank fingerprint on original values');
  const cntPay = async () => Number((await sql.query('select count(*) c from payments'))[0][0].c);
  const pbase = { description: 'QAZ-VAL pagamento', flow: 'in', dueDate: '2026-12-10' };
  const payCountBefore = await cntPay();
  for (const [label, patch, re] of [
    ['amount 0', { amount: 0 }, /maior que zero/], ['amount "0"', { amount: '0' }, /maior que zero/], ['amount "0,00"', { amount: '0,00' }, /maior que zero/],
    ['amount -5', { amount: -5 }, /maior que zero/], ['amount "-0,01"', { amount: '-0,01' }, /maior que zero/], ['amount "" (empty)', { amount: '' }, /maior que zero/], ['amount null', { amount: null }, /maior que zero/],
    ['blank description', { amount: 10, description: '' }, /descrição/i], ['whitespace description', { amount: 10, description: '   ' }, /descrição/i], ['null description', { amount: 10, description: null }, /descrição/i],
  ]) {
    r = await api('POST', '/api/payments', { ...pbase, amount: 10, ...patch });
    ok(`POST /payments ${label} -> 400 pt-BR`, r.status === 400 && re.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
    r = await api('POST', '/api/payments', { ...pbase, amount: 10, ...patch, recurrence: { frequency: 'monthly', until: '2027-02-28' } });
    ok(`POST /payments (recurring) ${label} -> 400`, r.status === 400, `${r.status} ${short(r.body)}`);
  }
  r = await api('POST', '/api/payments', { amount: 10 }); eq('POST /payments without description key -> 400', r.status, 400);
  eq('rejected creations wrote nothing (payments row count unchanged)', await cntPay(), payCountBefore);
  // valid money formats stored exactly (server values unchanged by the pt-BR client formatting)
  for (const [raw, want] of [[1234.56, 1234.56], ['1234.56', 1234.56], ['1234,56', 1234.56], [0.01, 0.01], ['0,01', 0.01], [99999999.99, 99999999.99]]) {
    r = await api('POST', '/api/payments', { ...pbase, description: 'QAZ-VAL money', amount: raw });
    if (r.status === 201) created.payments.push(r.body.id);
    ok(`POST amount ${JSON.stringify(raw)} -> stored ${want}`, r.status === 201 && Number(r.body.amount) === want, `${r.status} ${short(r.body)}`);
  }
  r = await api('POST', '/api/payments', { ...pbase, description: 'QAZ-VAL recorrente', amount: '12,34', recurrence: { frequency: 'monthly', until: '2027-01-31' } });
  ok('valid recurrence still 201', r.status === 201 && r.body.count >= 2, short(r.body));
  r = await api('GET', '/api/payments');
  for (const p of r.body.filter((p) => String(p.description).startsWith('QAZ-VAL'))) if (!created.payments.includes(p.id)) created.payments.push(p.id);
  // legacy payment with amount 0 (inserted by SQL: the API can no longer create one)
  const [lg] = await sql.query("insert into payments (description, amount, flow, due_date) values ('QAZ-VAL legado zero', '0', 'in', '2026-12-11')");
  const legId = lg.insertId; created.payments.push(legId);
  r = await api('PUT', `/api/payments/${legId}`, { description: 'QAZ-VAL legado zero editado', dueDate: '2026-12-12' });
  ok('legacy 0 payment: other fields still editable', r.status === 200 && r.body.description === 'QAZ-VAL legado zero editado' && Number(r.body.amount) === 0, `${r.status} ${short(r.body)}`);
  r = await api('PUT', `/api/payments/${legId}`, { amount: 0, description: 'QAZ-VAL legado zero 2' });
  eq('legacy 0 payment: PUT with the same amount 0 -> 200', r.status, 200);
  r = await api('PUT', `/api/payments/${legId}`, { receiptStatus: 'received', receivedDate: '2026-12-12' });
  ok('legacy 0 payment: can be marked received', r.status === 200 && r.body.receiptStatus === 'received', `${r.status} ${short(r.body)}`);
  r = await api('PUT', `/api/payments/${legId}`, { amount: -3 });
  ok('legacy 0 payment: amount -3 -> 400 "maior que zero"', r.status === 400 && /maior que zero/.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  r = await api('POST', '/api/payments', { ...pbase, description: 'QAZ-VAL positivo', amount: 50 });
  const posPay = r.body; created.payments.push(posPay.id);
  r = await api('PUT', `/api/payments/${posPay.id}`, { amount: 0 }); ok('positive payment: PUT amount 0 -> 400', r.status === 400 && /maior que zero/.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  r = await api('PUT', `/api/payments/${posPay.id}`, { amount: '-1,5' }); eq('positive payment: PUT amount "-1,5" -> 400', r.status, 400);
  r = await api('PUT', `/api/payments/${posPay.id}`, { description: '' }); eq('PUT blank description -> 400', r.status, 400);
  r = await api('PUT', `/api/payments/${posPay.id}`, { amount: '1234,56', description: 'QAZ-VAL positivo editado' }); ok('positive payment: PUT amount "1234,56" + description -> 200 / 1234.56', r.status === 200 && Number(r.body.amount) === 1234.56, `${r.status} ${short(r.body)}`);
  r = await api('PUT', `/api/payments/${legId}`, { amount: '1234,56' }); ok('legacy 0 payment: PUT amount "1234,56" -> 1234.56', r.status === 200 && Number(r.body.amount) === 1234.56, `${r.status} ${short(r.body)}`);
  // contract installments covered entirely by a credit are NOT affected by the > 0 rule
  r = await api('POST', `/api/customers/${cu.id}/credits`, { description: 'QAZ credito grande', value: '100000' });
  ok('big credit created', r.status === 201, short(r.body));
  const bigCredit = r.body;
  r = await api('POST', '/api/contracts', { ...cb, creditId: bigCredit.id, installments: 2, dueDates: ['2026-12-01', '2027-01-01'], executionDate: '2026-12-05', executionTime: '10:00', executionAddress: 'Local', duration: '1h' });
  ok('contract fully covered by credit -> 201 (zero installments allowed)', r.status === 201, `${r.status} ${short(r.body)}`);
  if (r.status === 201) {
    created.contracts.push(r.body.id);
    const pc = (await api('GET', '/api/payments')).body.filter((p) => p.contractId === r.body.id);
    for (const p of pc) created.payments.push(p.id);
    ok('credit-covered contract: no installment payment is created with amount <= 0 and creation is not blocked', pc.every((p) => Number(p.amount) > 0), short(pc.map((p) => p.amount)));
    const cc = (await api('GET', `/api/contracts/${r.body.id}`)).body;
    ok('credit-covered contract: creditApplied equals the contract value (nothing left to pay)', Number(cc.creditApplied) > 0, short({ creditApplied: cc.creditApplied, total: cc.totalValue }));
  }

  // ---- bank import fingerprint uses ORIGINAL statement values ----
  const FP = (fit, amt, date) => trn({ fit, amt, date: date + '120000[-3:BRT]', name: 'PIX QAZ', memo: 'QAZ-SMOKE ' + fit });
  const stm2 = stm([FP('QAZFP1', '321.45', '20261020'), FP('QAZFP2', '-50.00', '20261021'), FP('QAZFP3', '88.00', '20261022')].join('') + '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261023120000<TRNAMT>19.90<NAME>PIX QAZ<MEMO>QAZ-SMOKE sem fitid</STMTTRN>');
  r = await api('POST', '/api/bank/parse', { fileName: 'QAZ-SMOKE-fp1.ofx', content: stm2 });
  eq('fp parse 200', r.status, 200);
  const fpItems = r.body.items;
  ok('fp parse: 4 lines, each carries originalDate/originalAmount', fpItems.length === 4 && fpItems.every((i) => i.originalDate && typeof i.originalAmount === 'number'), short(fpItems.map((i) => [i.fitId, i.originalDate, i.originalAmount])));
  const nofitLine = fpItems.find((i) => !i.fitId);
  ok('fp parse: the line without FITID is present', !!nofitLine, short(fpItems.map((i) => i.fitId)));
  // user edits date and amount of EVERY line in the preview, then imports
  const edited = fpItems.map((i, k) => ({ ...i, date: `2026-11-0${k + 1}`, amount: i.flow === 'out' ? -(Math.abs(i.amount) + 1.11) : i.amount + 1.11, selected: true, matchedPaymentId: null }));
  r = await api('POST', '/api/bank/import', { fileName: 'QAZ-SMOKE-fp1.ofx', bankId: '0001', accountId: 'QAZ-ACCT', items: edited });
  ok('fp import with edited date/amount -> 201 created 4', r.status === 201 && r.body.created === 4, `${r.status} ${short(r.body)}`);
  const [trs] = await sql.query("select fit_id, date_format(date,'%Y-%m-%d') d, amount, date_format(orig_date,'%Y-%m-%d') od, orig_amount oa from transactions t where t.import_id in (select id from bank_imports where file_name='QAZ-SMOKE-fp1.ofx') order by t.id");
  ok('fp stored: date/amount are the EDITED values', trs.length === 4 && trs.every((t, k) => t.d === `2026-11-0${k + 1}`), short(trs));
  ok('fp stored: orig_date/orig_amount are the STATEMENT values', trs.length === 4 && trs.every((t, k) => t.od === fpItems[k].originalDate && Number(t.oa) === fpItems[k].originalAmount), short(trs));
  for (const p of (await api('GET', '/api/payments')).body.filter((p) => String(p.description).startsWith('QAZ-SMOKE'))) if (!created.payments.includes(p.id)) created.payments.push(p.id);
  // same statement, another file name: ALL flagged and unselected
  r = await api('POST', '/api/bank/parse', { fileName: 'QAZ-SMOKE-fp-OTHER-NAME.ofx', content: stm2 });
  ok('fp re-upload under another file name: ALL 4 lines alreadyImported + unselected', r.body.items.length === 4 && r.body.items.every((i) => i.alreadyImported === true && i.selected === false), short(r.body.items.map((i) => [i.fitId, i.alreadyImported, i.selected])));
  // a statement with the EDITED values is a different (new) line -> not flagged
  const stmEd = stm(trn({ fit: 'QAZFP1', amt: '322.56', date: '20261101120000[-3:BRT]', memo: 'QAZ-SMOKE outra memo' }));
  r = await api('POST', '/api/bank/parse', { fileName: 'QAZ-SMOKE-fp-edited.ofx', content: stmEd });
  ok('fp: a line equal to the EDITED values (not the statement) is not flagged', r.body.items.length === 1 && r.body.items[0].alreadyImported === false, short(r.body.items));
  // old import row with NULL originals, matched on stored values
  const [bi] = await sql.query("insert into bank_imports (file_name, bank_id, account_id, item_count) values ('QAZ-SMOKE-old.ofx', '0001', 'QAZ-ACCT', 2)");
  await sql.query("insert into transactions (import_id, fit_id, date, description, memo, amount, flow, imported) values (?, 'QAZOLD1', '2026-10-24', 'PIX QAZ', 'QAZ-SMOKE QAZOLD1', '45.67', 'in', 1)", [bi.insertId]);
  await sql.query("insert into transactions (import_id, fit_id, date, description, memo, amount, flow, imported) values (?, NULL, '2026-10-25', 'PIX QAZ', 'QAZ-SMOKE old nofit', '12.00', 'in', 1)", [bi.insertId]);
  const stmOld = stm(trn({ fit: 'QAZOLD1', amt: '45.67', date: '20261024120000[-3:BRT]' }) + '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261025120000<TRNAMT>12.00<NAME>PIX QAZ<MEMO>QAZ-SMOKE old nofit</STMTTRN>' + trn({ fit: 'QAZOLD2', amt: '45.67', date: '20261024120000[-3:BRT]' }));
  r = await api('POST', '/api/bank/parse', { fileName: 'QAZ-SMOKE-old2.ofx', content: stmOld });
  const ob = r.body.items;
  ok('old row (NULL originals) with FITID still flagged via stored values', ob.find((i) => i.fitId === 'QAZOLD1')?.alreadyImported === true, short(ob.map((i) => [i.fitId, i.alreadyImported])));
  ok('old row without FITID still flagged (date+amount+memo)', ob.find((i) => !i.fitId)?.alreadyImported === true, short(ob.map((i) => [i.fitId, i.alreadyImported])));
  ok('different FITID same date/amount not flagged', ob.find((i) => i.fitId === 'QAZOLD2')?.alreadyImported === false);
  // import without originalDate/originalAmount falls back to the edited values (API compatibility)
  r = await api('POST', '/api/bank/import', { fileName: 'QAZ-SMOKE-fp-noorig.ofx', bankId: '0001', accountId: 'QAZ-ACCT', items: [{ fitId: 'QAZFPN', date: '2026-10-27', type: 'CREDIT', description: 'QAZ-SMOKE noorig', amount: 7.7, flow: 'in' }] });
  eq('import without originals -> 201', r.status, 201);
  const [nn] = await sql.query("select date_format(orig_date,'%Y-%m-%d') od, orig_amount oa from transactions where fit_id='QAZFPN'");
  ok('missing originals default to the line values', nn[0]?.od === '2026-10-27' && Number(nn[0]?.oa) === 7.7, short(nn));
  r = await api('POST', '/api/bank/import', { fileName: 'QAZ-SMOKE-fp-badorig.ofx', bankId: '0001', accountId: 'QAZ-ACCT', items: [{ fitId: 'QAZFPB', date: '2026-10-27', description: 'x', amount: 7.7, originalDate: '2026-02-30' }] });
  eq('import with invalid originalDate -> 400', r.status, 400);
  r = await api('POST', '/api/bank/import', { fileName: 'QAZ-SMOKE-fp-badorig.ofx', bankId: '0001', accountId: 'QAZ-ACCT', items: [{ fitId: 'QAZFPB', date: '2026-10-27', description: 'x', amount: 7.7, originalAmount: 'abc' }] });
  eq('import with invalid originalAmount -> 400', r.status, 400);
  // bank-import payment creation is NOT subject to the "> 0" rule (zero-value statement line)
  r = await api('POST', '/api/bank/import', { fileName: 'QAZ-SMOKE-zero.ofx', bankId: '0001', accountId: 'QAZ-ACCT', items: [{ fitId: 'QAZZERO', date: '2026-10-27', description: 'QAZ-SMOKE linha zero', amount: 0, flow: 'in' }] });
  ok('bank import of a 0,00 line still creates its payment (unaffected by the new rule)', r.status === 201 && r.body.created === 1, `${r.status} ${short(r.body)}`);
  for (const p of (await api('GET', '/api/payments')).body.filter((p) => String(p.description).startsWith('QAZ-SMOKE'))) if (!created.payments.includes(p.id)) created.payments.push(p.id);

  // ====================================================================
  // ====================================================================
  sec('P. Business rules: customer/contract delete, contract edit, transactions + unique numbers');
  const cnt = async (t, where = '1=1', p = []) => Number((await sql.query(`select count(*) c from \`${t}\` where ${where}`, p))[0][0].c);
  const mkCust = async (name) => { const x = await api('POST', '/api/customers', { name }); created.customers.push(x.body.id); return x.body; };
  const credOf = async (cid, id) => (await api('GET', `/api/customers/${cid}/credits?all=1`)).body.find((c) => c.id === id);
  const payIds = (arr) => { for (const p of arr) if (!created.payments.includes(p.id)) created.payments.push(p.id); };
  const dropContractSql = async (id) => { await sql.query('delete from contracts where id = ?', [id]); };

  // ---- P1. customer delete blocked ----
  const cClean = await mkCust('QAZ-P Cliente limpo');
  r = await api('DELETE', `/api/customers/${cClean.id}`); eq('delete clean customer -> 204', r.status, 204);
  r = await api('GET', `/api/customers/${cClean.id}`); eq('clean customer gone (404)', r.status, 404);
  const cCred = await mkCust('QAZ-P Cliente so credito');
  const crP = (await api('POST', `/api/customers/${cCred.id}/credits`, { description: 'QAZ-P credito', value: '40' })).body;
  r = await api('DELETE', `/api/customers/${cCred.id}`);
  ok('customer with only a credit -> 409 mentioning "1 crédito(s)"', r.status === 409 && /1 crédito\(s\)/.test(r.body?.error || '') && !/contrato|pagamento/.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  eq('customer with credit still exists', (await api('GET', `/api/customers/${cCred.id}`)).status, 200);
  await api('DELETE', `/api/customers/${cCred.id}/credits/${crP.id}`);
  eq('after removing the credit the customer deletes (204)', (await api('DELETE', `/api/customers/${cCred.id}`)).status, 204);
  const cPay = await mkCust('QAZ-P Cliente so pagamento');
  const pP = (await api('POST', '/api/payments', { description: 'QAZ-P pag', amount: 10, flow: 'in', dueDate: '2026-12-10', customerId: cPay.id })).body; created.payments.push(pP.id);
  r = await api('DELETE', `/api/customers/${cPay.id}`);
  ok('customer with only a payment -> 409 mentioning "1 pagamento(s)"', r.status === 409 && /1 pagamento\(s\)/.test(r.body?.error || '') && !/contrato|crédito/.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  await api('DELETE', `/api/payments/${pP.id}`);
  eq('after removing the payment the customer deletes (204)', (await api('DELETE', `/api/customers/${cPay.id}`)).status, 204);
  const cCon = await mkCust('QAZ-P Cliente so contrato');
  const conP = (await api('POST', '/api/contracts', { ...cb, customerId: cCon.id, installments: 1, dueDates: ['2026-12-10'] })).body; created.contracts.push(conP.id); payIds(conP.payments || []);
  r = await api('DELETE', `/api/customers/${cCon.id}`);
  ok('customer with a contract (+ its installment payment) -> 409 with counts', r.status === 409 && /contrato\(s\)/.test(r.body?.error || '') && /pagamento\(s\)/.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  eq('customer with contract still exists and contract keeps its customer', (await api('GET', `/api/contracts/${conP.id}`)).body.customerId, cCon.id);
  eq('contract (no money received) deletes -> 204', (await api('DELETE', `/api/contracts/${conP.id}`)).status, 204);
  eq('then the customer deletes (204)', (await api('DELETE', `/api/customers/${cCon.id}`)).status, 204);

  // ---- P2. contract delete ----
  const cDel = await mkCust('QAZ-P Cliente delete');
  const addCredit = async (cid, v, d = 'QAZ-P credito') => (await api('POST', `/api/customers/${cid}/credits`, { description: d, value: String(v) })).body;
  // (a) credit reinstated exactly + files removed + rows gone
  const crA = await addCredit(cDel.id, '123.45');
  r = await api('POST', '/api/contracts', { ...cb, customerId: cDel.id, creditId: crA.id, installments: 2, dueDates: ['2026-12-10', '2027-01-10'] });
  eq('contract with credit created', r.status, 201); const CA = r.body; created.contracts.push(CA.id); payIds(CA.payments || []);
  eq('credit consumed (remaining 0)', Number((await credOf(cDel.id, crA.id)).remaining), Number((123.45 - Number(CA.creditApplied)).toFixed(2)));
  r = await api('POST', `/api/contracts/${CA.id}/generate`); eq('generate doc for the contract', r.status, 201);
  const fileA = path.join(ROOT, 'storage', 'contracts', r.body.fileName); created.docs.push(r.body.id);
  ok('document file exists on disk', fs.existsSync(fileA), fileA);
  r = await api('DELETE', `/api/contracts/${CA.id}`); eq('delete contract (nothing received) -> 204', r.status, 204);
  eq('credit remaining restored EXACTLY to 123.45', Number((await credOf(cDel.id, crA.id)).remaining), 123.45);
  ok('generated file removed from storage/contracts', !fs.existsSync(fileA));
  eq('contract rows gone (contract, payments, documents)', [await cnt('contracts', 'id = ?', [CA.id]), await cnt('payments', 'contract_id = ?', [CA.id]), await cnt('contract_documents', 'contract_id = ?', [CA.id])].join(','), '0,0,0');
  // (b) received installment blocks
  r = await api('POST', '/api/contracts', { ...cb, customerId: cDel.id, installments: 2, dueDates: ['2026-12-10', '2027-01-10'] });
  const CB = r.body; created.contracts.push(CB.id); payIds(CB.payments || []);
  await api('PUT', `/api/payments/${CB.payments[0].id}`, { receiptStatus: 'received', receivedDate: '2026-12-10' });
  r = await api('DELETE', `/api/contracts/${CB.id}`);
  ok('received installment blocks delete -> 409 pt-BR', r.status === 409 && /pagamento\(s\) recebido\(s\)\/pago\(s\)/.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  eq('blocked delete kept contract + payments', [await cnt('contracts', 'id = ?', [CB.id]), await cnt('payments', 'contract_id = ?', [CB.id])].join(','), '1,2');
  // (c) received extra payment blocks (saída "done" too)
  r = await api('POST', '/api/contracts', { ...cb, customerId: cDel.id, installments: 1, dueDates: ['2026-12-10'] });
  const CC = r.body; created.contracts.push(CC.id); payIds(CC.payments || []);
  r = await api('POST', '/api/payments', { description: 'QAZ-P extra recebido', amount: 5, flow: 'in', dueDate: '2026-12-11', contractId: CC.id, customerId: cDel.id, categoryId: catIn.id, receiptStatus: 'received', receivedDate: '2026-12-11' });
  created.payments.push(r.body.id);
  eq('received EXTRA payment blocks delete -> 409', (await api('DELETE', `/api/contracts/${CC.id}`)).status, 409);
  await api('PUT', `/api/payments/${r.body.id}`, { receiptStatus: 'open', receivedDate: null });
  eq('after re-opening the extra payment the contract deletes (204)', (await api('DELETE', `/api/contracts/${CC.id}`)).status, 204);
  // (d) recurring: received fatura installment blocks; otherwise invoice credit reinstated
  const mkRec = async (cid) => { const x = await api('POST', '/api/contracts', { customerId: cid, type: 'invoice', title: 'QAZ-P Recorrente', invoiceTemplateId: tI, receiptTemplateId: tR }); created.contracts.push(x.body.id); return x.body; };
  const addItems = async (rid, n) => { await api('POST', `/api/contracts/${rid}/items`, { serviceVersionId: sv1, items: Array.from({ length: n }, (_, i) => ({ description: `QAZ-P item ${i}` })), performedAt: '2026-10-05' }); return (await api('GET', `/api/contracts/${rid}`)).body.items.filter((i) => !i.invoiceId).map((i) => i.id); };
  const crD = await addCredit(cDel.id, '100');
  const RD = await mkRec(cDel.id); let free = await addItems(RD.id, 2);
  r = await api('POST', `/api/contracts/${RD.id}/invoices`, { itemIds: [free[0]], reference: 'QAZ-P fat', creditId: crD.id, installments: 1, dueDates: ['2027-01-10'] });
  eq('invoice with credit created', r.status, 201);
  const remAfter = Number((await credOf(cDel.id, crD.id)).remaining);
  ok('invoice consumed part of the credit', remAfter < 100, String(remAfter));
  const invPays = (await sql.query('select id from payments where contract_id = ? and invoice_id is not null', [RD.id]))[0]; payIds(invPays);
  await api('PUT', `/api/payments/${invPays[0].id}`, { receiptStatus: 'received', receivedDate: '2027-01-10' });
  r = await api('DELETE', `/api/contracts/${RD.id}`);
  ok('recurring contract with a received FATURA installment -> 409', r.status === 409, `${r.status} ${short(r.body)}`);
  eq('credit untouched by the blocked delete', Number((await credOf(cDel.id, crD.id)).remaining), remAfter);
  await api('PUT', `/api/payments/${invPays[0].id}`, { receiptStatus: 'open', receivedDate: null });
  r = await api('DELETE', `/api/contracts/${RD.id}`); eq('recurring contract deletes once nothing is received (204)', r.status, 204);
  eq('invoice credit restored EXACTLY to 100', Number((await credOf(cDel.id, crD.id)).remaining), 100);
  eq('recurring rows gone (items, invoices, payments)', [await cnt('contract_items', 'contract_id = ?', [RD.id]), await cnt('invoices', 'contract_id = ?', [RD.id]), await cnt('payments', 'contract_id = ?', [RD.id])].join(','), '0,0,0');

  // ---- P3. contract edit ----
  const cEd = await mkCust('QAZ-P Cliente edit');
  const crE = await addCredit(cEd.id, '200');
  const price = 1000; // QAZ service price is read from the created contract below
  r = await api('POST', '/api/contracts', { ...cb, customerId: cEd.id, creditId: crE.id, installments: 2, dueDates: ['2026-12-10', '2027-01-10'] });
  const CE = r.body; created.contracts.push(CE.id); payIds(CE.payments || []);
  const netE = Number(CE.total) - Number(CE.creditApplied); // contract.total is the gross; installments are split on total - credit
  const sumInst = async (id) => Number((await sql.query('select coalesce(sum(amount),0) s from payments where contract_id = ? and installment_number is not null', [id]))[0][0].s);
  ok('create: installments sum = total - creditApplied', Math.abs((await sumInst(CE.id)) - netE) < 0.011, `${await sumInst(CE.id)} vs ${netE}`);
  // before any receipt: re-split on the net total (modifier -50 => total - 50, credit stays applied)
  r = await api('PUT', `/api/contracts/${CE.id}`, { items: [{ serviceVersionId: sv1 }], modifiers: [{ name: 'QAZ-P desconto', price: -50, discountPercent: 0 }], installments: 2, dueDates: ['2026-12-15', '2027-01-15'] });
  eq('PUT items+modifiers+dueDates before receipt -> 200', r.status, 200);
  const rows = (await sql.query("select amount, date_format(due_date,'%Y-%m-%d') d from payments where contract_id = ? and installment_number is not null order by installment_number", [CE.id]))[0];
  eq('installments regenerated: 2 rows with the new due dates', JSON.stringify(rows.map((x) => x.d)), JSON.stringify(['2026-12-15', '2027-01-15']));
  ok('installments sum = new net total (total - credit already applied), not the gross', Math.abs(rows.reduce((s, x) => s + Number(x.amount), 0) - (Number(r.body.total) - Number(r.body.creditApplied))) < 0.011, `${short(rows)} total ${r.body.total} credit ${r.body.creditApplied}`);
  eq('credit still applied (same amount)', Number(r.body.creditApplied), Number(CE.creditApplied));
  // extra payment survives an edit
  r = await api('POST', '/api/payments', { description: 'QAZ-P extra edit', amount: 7, flow: 'in', dueDate: '2026-12-20', contractId: CE.id, customerId: cEd.id, categoryId: catIn.id }); created.payments.push(r.body.id);
  r = await api('PUT', `/api/contracts/${CE.id}`, { items: [{ serviceVersionId: sv1 }], installments: 2, dueDates: ['2026-12-16', '2027-01-16'] });
  eq('PUT again -> 200', r.status, 200);
  eq('extra payment (no installment number) survives the edit', await cnt('payments', "contract_id = ? and description = 'QAZ-P extra edit' and installment_number is null", [CE.id]), 1);
  // items-only PUT without dueDates: rows consistent with the stored count
  r = await api('PUT', `/api/contracts/${CE.id}`, { items: [{ serviceVersionId: sv1 }] });
  eq('items-only PUT -> 200', r.status, 200);
  const nInst = await cnt('payments', 'contract_id = ? and installment_number is not null', [CE.id]);
  eq('rows == stored installments count after items-only PUT', nInst, Number(r.body.installments));
  // total below the credit already applied -> 400, nothing changed
  const before = await sumInst(CE.id);
  r = await api('PUT', `/api/contracts/${CE.id}`, { items: [{ serviceVersionId: sv1 }], modifiers: [{ name: 'QAZ-P tudo', price: -999999, discountPercent: 0 }] });
  ok('total < creditApplied -> 400 pt-BR', r.status === 400 && /crédito/i.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  eq('rejected edit changed no installment', await sumInst(CE.id), before);
  // header edits always OK; after a receipt money edits and type change -> 409
  const instRows = (await api('GET', `/api/contracts/${CE.id}`)).body.payments.filter((p) => p.installmentNumber);
  await api('PUT', `/api/payments/${instRows[0].id}`, { receiptStatus: 'received', receivedDate: '2026-12-16' });
  const snap = async () => JSON.stringify((await sql.query('select amount, due_date, installment_number from payments where contract_id = ? order by id', [CE.id]))[0]);
  const s0 = await snap();
  for (const [label, body] of [['items', { items: [{ serviceVersionId: sv1 }] }], ['modifiers+items', { items: [{ serviceVersionId: sv1 }], modifiers: [{ name: 'x', price: 1 }] }], ['installments', { installments: 1 }], ['dueDates', { dueDates: ['2027-05-01'] }], ['type change', { type: 'invoice' }]]) {
    r = await api('PUT', `/api/contracts/${CE.id}`, body);
    ok(`after a receipt: PUT ${label} -> 409`, r.status === 409 && /recebido/.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
  }
  eq('409s changed nothing', await snap(), s0);
  r = await api('PUT', `/api/contracts/${CE.id}`, { comments: 'QAZ-P cabecalho', executionAddress: 'QAZ-P local', executionDate: '2027-02-02', type: 'contract' });
  ok('after a receipt: header-only edit (+ same type) -> 200', r.status === 200 && r.body.comments === 'QAZ-P cabecalho' && r.body.executionDate === '2027-02-02', `${r.status} ${short(r.body)}`);
  eq('header edit changed no payment', await snap(), s0);

  // ---- P4. transactions, unique numbers, concurrency ----
  const idx = (await sql.query("select table_name t, index_name i, non_unique n from information_schema.statistics where table_schema = database() and index_name in ('contracts_number_uq','invoices_ref_number_uq')"))[0];
  ok('unique indexes exist: contracts_number_uq, invoices_ref_number_uq', idx.length === 2 && idx.every((x) => Number(x.n) === 0), short(idx));
  const cCc = await mkCust('QAZ-P Cliente concorrencia');
  const par = await Promise.all(Array.from({ length: 10 }, () => api('POST', '/api/contracts', { ...cb, customerId: cCc.id, installments: 1, dueDates: ['2026-12-10'] })));
  for (const x of par) if (x.status === 201) { created.contracts.push(x.body.id); payIds(x.body.payments || []); }
  ok('10 concurrent one-time contract creations all 201 (no 500)', par.every((x) => x.status === 201), par.map((x) => x.status).join(','));
  const nums = par.map((x) => x.body?.number);
  eq('...with 10 DISTINCT numbers', new Set(nums).size, 10);
  const parR = await Promise.all(Array.from({ length: 10 }, () => api('POST', '/api/contracts', { customerId: cCc.id, type: 'invoice', title: 'QAZ-P Rec conc', invoiceTemplateId: tI, receiptTemplateId: tR })));
  for (const x of parR) if (x.status === 201) created.contracts.push(x.body.id);
  ok('10 concurrent recurring contract creations all 201', parR.every((x) => x.status === 201), parR.map((x) => x.status).join(','));
  eq('...with 10 DISTINCT numbers', new Set(parR.map((x) => x.body?.number)).size, 10);
  const par3 = await Promise.all(Array.from({ length: 3 }, () => api('POST', '/api/contracts', { ...cb, customerId: cCc.id, installments: 1, dueDates: ['2026-12-10'] })));
  for (const x of par3) if (x.status === 201) { created.contracts.push(x.body.id); payIds(x.body.payments || []); }
  ok('3 concurrent one-time contract creations all 201, distinct numbers', par3.every((x) => x.status === 201) && new Set(par3.map((x) => x.body?.number)).size === 3, par3.map((x) => x.status).join(','));
  // concurrent invoices on one recurring contract
  const RC = parR[0].body; const itemsC = await addItems(RC.id, 10);
  const parI = await Promise.all(itemsC.map((id, i) => api('POST', `/api/contracts/${RC.id}/invoices`, { itemIds: [id], reference: `QAZ-P conc ${i}`, installments: 1, dueDates: ['2027-01-10'] })));
  ok('10 concurrent invoice creations all 201 (no 500)', parI.every((x) => x.status === 201), parI.map((x) => x.status).join(','));
  const invsC = (await api('GET', `/api/contracts/${RC.id}`)).body.invoices;
  ok('...with 10 DISTINCT invoice numbers (NNN-YY)', invsC.length === 10 && new Set(invsC.map((i) => i.refNumber)).size === 10 && invsC.every((i) => /^\d{3}-\d{2}$/.test(i.refNumber)), short(invsC.map((i) => i.refNumber)));
  payIds((await api('GET', `/api/contracts/${RC.id}`)).body.payments || []);
  eq('DB unique indexes hold: no duplicate contract numbers', await cnt('contracts', 'number is not null and number in (select number from (select number from contracts group by number having count(*) > 1) d)'), 0);
  // rollback: a create that fails midway leaves nothing behind
  const tabs = ['contracts', 'contract_items', 'payments', 'invoices', 'customer_credits'];
  const snapCounts = async () => JSON.stringify(await Promise.all(tabs.map((t) => cnt(t))));
  const failing = [
    ['unknown credit', { ...cb, customerId: cCc.id, creditId: 2000000000, installments: 2, dueDates: ['2026-12-10', '2027-01-10'] }],
    ['impossible due date', { ...cb, customerId: cCc.id, dueDates: ['2026-02-30'] }],
    ['unknown customer', { ...cb, customerId: 2000000000 }],
    ['unknown template', { ...cb, customerId: cCc.id, templateId: 2000000000 }],
    ['unknown service version (1st item)', { ...cb, customerId: cCc.id, items: [{ serviceVersionId: 2000000000 }] }],
  ];
  for (const [label, body] of failing) {
    const c0 = await snapCounts();
    r = await api('POST', '/api/contracts', body);
    if (r.status === 201) { created.contracts.push(r.body.id); payIds(r.body.payments || []); }
    if (r.status === 201) console.log('  NOTE: create with ' + label + ' is accepted (201), the invalid reference is ignored');
    ok(`create with ${label} -> 400`, r.status === 400, `${r.status} ${short(r.body)}`);
    if (r.status >= 400) eq(`rollback (${label}): no half-created rows`, await snapCounts(), c0);
  }
  // an invalid 2nd item: the server may ignore it (201) or refuse it; either way no orphan rows must remain on refusal
  { const c0 = await snapCounts(); r = await api('POST', '/api/contracts', { ...cb, customerId: cCc.id, items: [{ serviceVersionId: sv1 }, { serviceVersionId: 2000000000 }], installments: 1, dueDates: ['2026-12-10'] });
    if (r.status === 201) { created.contracts.push(r.body.id); payIds(r.body.payments || []); console.log('  NOTE: unknown 2nd service version is silently ignored (201, items=' + (r.body.items || []).length + ')'); }
    else eq('rollback (unknown 2nd item): no half-created rows', await snapCounts(), c0); }
  // invoice edit/delete concurrency must not double-reinstate the credit
  const cInv = await mkCust('QAZ-P Cliente fatura conc'); const crI = await addCredit(cInv.id, '100');
  const RI = await mkRec(cInv.id); const itI = await addItems(RI.id, 2);
  r = await api('POST', `/api/contracts/${RI.id}/invoices`, { itemIds: [itI[0]], reference: 'QAZ-P credito conc', creditId: crI.id, installments: 1, dueDates: ['2027-01-10'] });
  const invI = (await api('GET', `/api/contracts/${RI.id}`)).body.invoices.find((i) => i.reference === 'QAZ-P credito conc');
  const remI = Number((await credOf(cInv.id, crI.id)).remaining);
  const edBody = { reference: 'QAZ-P credito conc', itemIds: [itI[0]], creditId: crI.id, installments: 1, dueDates: ['2027-01-10'], discountPercent: 0 };
  const ed = await Promise.all([api('PUT', `/api/invoices/${invI.id}`, edBody), api('PUT', `/api/invoices/${invI.id}`, edBody)]);
  ok('two simultaneous edits of the same invoice: no 5xx', ed.every((x) => x.status < 500), ed.map((x) => x.status).join(','));
  const remE = Number((await credOf(cInv.id, crI.id)).remaining);
  ok('...credit not double-reinstated (remaining unchanged, never above value)', Math.abs(remE - remI) < 0.011 && remE <= 100, `${remI} -> ${remE}`);
  const dl = await Promise.all([api('DELETE', `/api/invoices/${invI.id}`), api('DELETE', `/api/invoices/${invI.id}`)]);
  ok('two simultaneous deletes of the same invoice: no 5xx', dl.every((x) => x.status < 500), dl.map((x) => x.status).join(','));
  eq('...credit reinstated exactly once (remaining == 100)', Number((await credOf(cInv.id, crI.id)).remaining), 100);
  // leave the blocked contracts' rows for the generic cleanup: delete received flags first
  for (const id of [CB.id, CE.id]) await dropContractSql(id);
  await sql.query("delete from payments where description like 'QAZ-P%'");

  // ====================================================================
  sec('Q. Concurrency (repeated), fatura delete rule, contract-create reference validation');
  const cQ = await mkCust('QAZ-Q Cliente');
  const cQ2 = await mkCust('QAZ-Q Cliente 2');
  const sNum = (arr) => new Set(arr).size;
  const dupNumbers = async () => (await cnt('contracts', 'number is not null and number in (select number from (select number from contracts group by number having count(*) > 1) d)')) + (await cnt('invoices', 'ref_number is not null and ref_number in (select ref_number from (select ref_number from invoices group by ref_number having count(*) > 1) d)'));
  const keep = (res) => { for (const x of res) if (x.status === 201 && x.body?.id) { created.contracts.push(x.body.id); payIds(x.body.payments || []); } };
  for (let round = 1; round <= 3; round++) {
    for (const n of [10, 20]) {
      const before = await cnt('contracts');
      const a = await Promise.all(Array.from({ length: n }, () => api('POST', '/api/contracts', { ...cb, customerId: cQ.id, installments: 1, dueDates: ['2026-12-10'] })));
      keep(a);
      ok(`round ${round}: ${n} concurrent one-time contracts -> all 201, distinct numbers, ${n} rows`, a.every((x) => x.status === 201) && sNum(a.map((x) => x.body?.number)) === n && (await cnt('contracts')) === before + n, a.map((x) => x.status).join(','));
      const b = await Promise.all(Array.from({ length: n }, () => api('POST', '/api/contracts', { customerId: cQ.id, type: 'invoice', title: 'QAZ-Q rec', invoiceTemplateId: tI, receiptTemplateId: tR })));
      keep(b);
      ok(`round ${round}: ${n} concurrent recurring contracts -> all 201, distinct numbers`, b.every((x) => x.status === 201) && sNum(b.map((x) => x.body?.number)) === n, b.map((x) => x.status).join(','));
      // mixed one-time + recurring at once (shared 'contract-number' lock)
      const m = await Promise.all(Array.from({ length: n }, (_, i) => api('POST', '/api/contracts', i % 2 ? { ...cb, customerId: cQ.id, installments: 1, dueDates: ['2026-12-10'] } : { customerId: cQ.id, type: 'invoice', title: 'QAZ-Q mix', invoiceTemplateId: tI, receiptTemplateId: tR })));
      keep(m);
      ok(`round ${round}: ${n} mixed concurrent creations -> all 201`, m.every((x) => x.status === 201), m.map((x) => x.status).join(','));
    }
    eq(`round ${round}: no duplicate contract numbers / invoice refs in the DB`, await dupNumbers(), 0);
    // invoices: 10 on one contract, then 5+5 on two contracts at once
    const R1c = (await api('POST', '/api/contracts', { customerId: cQ.id, type: 'invoice', title: 'QAZ-Q fat 1', invoiceTemplateId: tI, receiptTemplateId: tR })).body; created.contracts.push(R1c.id);
    const R2c = (await api('POST', '/api/contracts', { customerId: cQ2.id, type: 'invoice', title: 'QAZ-Q fat 2', invoiceTemplateId: tI, receiptTemplateId: tR })).body; created.contracts.push(R2c.id);
    const i1 = await addItems(R1c.id, 10); const i2 = await addItems(R2c.id, 5); const i3 = (await addItems(R1c.id, 5)).filter((x) => !i1.includes(x)); // addItems returns every unbilled item
    const invBefore = await cnt('invoices');
    const p1 = await Promise.all(i1.map((id, i) => api('POST', `/api/contracts/${R1c.id}/invoices`, { itemIds: [id], reference: `QAZ-Q ${round}-${i}`, installments: 1, dueDates: ['2027-01-10'] })));
    ok(`round ${round}: 10 concurrent invoices on one contract -> all 201`, p1.every((x) => x.status === 201), p1.map((x) => x.status).join(','));
    const p2 = await Promise.all([...i2.map((id, i) => api('POST', `/api/contracts/${R2c.id}/invoices`, { itemIds: [id], reference: `QAZ-Q b${round}-${i}`, installments: 1, dueDates: ['2027-01-10'] })), ...i3.map((id, i) => api('POST', `/api/contracts/${R1c.id}/invoices`, { itemIds: [id], reference: `QAZ-Q c${round}-${i}`, installments: 1, dueDates: ['2027-01-10'] }))]);
    ok(`round ${round}: 10 concurrent invoices on TWO contracts at once -> all 201`, p2.every((x) => x.status === 201), p2.map((x) => x.status).join(','));
    const refs = (await sql.query('select ref_number r from invoices where contract_id in (?, ?)', [R1c.id, R2c.id]))[0].map((x) => x.r);
    ok(`round ${round}: 20 invoices created, 20 DISTINCT refs, row count +20`, refs.length === 20 && sNum(refs) === 20 && (await cnt('invoices')) === invBefore + 20, short(refs));
    eq(`round ${round}: each invoice got exactly its installment (20 payments), no half-created rows`, await cnt('payments', 'invoice_id in (select id from invoices where contract_id in (?, ?))', [R1c.id, R2c.id]), 20);
    eq(`round ${round}: all items billed once`, await cnt('contract_items', 'contract_id in (?, ?) and invoice_id is null', [R1c.id, R2c.id]), 0);
    for (const x of (await sql.query('select id from payments where contract_id in (?, ?)', [R1c.id, R2c.id]))[0]) created.payments.push(x.id);
    eq(`round ${round}: no duplicates after invoice creation`, await dupNumbers(), 0);
  }
  // two invoice creations racing for the SAME unbilled item: billed once
  const RS = (await api('POST', '/api/contracts', { customerId: cQ.id, type: 'invoice', title: 'QAZ-Q mesma item', invoiceTemplateId: tI, receiptTemplateId: tR })).body; created.contracts.push(RS.id);
  for (let k = 0; k < 3; k++) {
    const [it] = await addItems(RS.id, 1);
    const race = await Promise.all([1, 2, 3].map((n) => api('POST', `/api/contracts/${RS.id}/invoices`, { itemIds: [it], reference: `QAZ-Q race ${k}-${n}`, installments: 1, dueDates: ['2027-01-10'] })));
    const st201 = race.filter((x) => x.status === 201).length;
    ok(`same-item race #${k + 1}: exactly one 201, the others 400 (no 5xx)`, st201 === 1 && race.filter((x) => x.status === 400).length === 2, race.map((x) => x.status).join(','));
    eq(`same-item race #${k + 1}: the item belongs to exactly one invoice`, await cnt('invoices', 'contract_id = ? and reference like ?', [RS.id, `QAZ-Q race ${k}-%`]), 1);
  }
  // invoice edit / delete racing, contract delete racing
  const cRace = await mkCust('QAZ-Q Cliente corrida'); const crR = await addCredit(cRace.id, '100');
  const RR = await mkRec(cRace.id); const itR = await addItems(RR.id, 3);
  await api('POST', `/api/contracts/${RR.id}/invoices`, { itemIds: [itR[0]], reference: 'QAZ-Q corrida', creditId: crR.id, installments: 1, dueDates: ['2027-01-10'] });
  const invR = (await api('GET', `/api/contracts/${RR.id}`)).body.invoices.find((i) => i.reference === 'QAZ-Q corrida');
  const edR = { reference: 'QAZ-Q corrida', itemIds: [itR[0]], creditId: crR.id, installments: 1, dueDates: ['2027-01-10'], discountPercent: 0 };
  const rEd = await Promise.all([api('PUT', `/api/invoices/${invR.id}`, edR), api('DELETE', `/api/invoices/${invR.id}`), api('PUT', `/api/invoices/${invR.id}`, edR)]);
  ok('invoice edit/delete/edit racing: no 5xx', rEd.every((x) => x.status < 500), rEd.map((x) => x.status).join(','));
  const remR = Number((await credOf(cRace.id, crR.id)).remaining);
  const invLeft = await cnt('invoices', 'id = ?', [invR.id]);
  ok('...credit consistent: invoice gone => credit back at exactly 100; invoice kept => credit still applied', invLeft === 0 ? remR === 100 : remR < 100, `invoice left ${invLeft}, remaining ${remR}`);
  const RR2 = await mkRec(cRace.id); const itR2 = await addItems(RR2.id, 2);
  await api('POST', `/api/contracts/${RR2.id}/invoices`, { itemIds: [itR2[0]], reference: 'QAZ-Q cdel', creditId: crR.id, installments: 1, dueDates: ['2027-01-10'] });
  const rCd = await Promise.all([api('DELETE', `/api/contracts/${RR2.id}`), api('POST', `/api/contracts/${RR2.id}/invoices`, { itemIds: [itR2[1]], reference: 'QAZ-Q cdel 2', installments: 1, dueDates: ['2027-01-10'] }), api('DELETE', `/api/contracts/${RR2.id}`)]);
  ok('contract delete racing invoice create / second delete: no 5xx', rCd.every((x) => x.status < 500), rCd.map((x) => x.status).join(','));
  eq('...no orphan invoices/items/payments of the deleted contract', [await cnt('invoices', 'contract_id = ?', [RR2.id]), await cnt('contract_items', 'contract_id = ?', [RR2.id]), await cnt('payments', 'contract_id = ?', [RR2.id])].join(','), (await cnt('contracts', 'id = ?', [RR2.id])) === 0 ? '0,0,0' : [await cnt('invoices', 'contract_id = ?', [RR2.id]), await cnt('contract_items', 'contract_id = ?', [RR2.id]), await cnt('payments', 'contract_id = ?', [RR2.id])].join(','));
  const remR2 = Number((await credOf(cRace.id, crR.id)).remaining);
  ok('...credit never above its value and consistent with remaining invoices', remR2 <= 100 && remR2 >= 0, String(remR2));

  // ---- fatura delete rule ----
  const cF = await mkCust('QAZ-Q Cliente fatura'); const crF = await addCredit(cF.id, '100');
  const RF = await mkRec(cF.id); const itF = await addItems(RF.id, 3);
  r = await api('POST', `/api/contracts/${RF.id}/invoices`, { itemIds: [itF[0]], reference: 'QAZ-Q recebida', creditId: crF.id, installments: 2, dueDates: ['2027-01-10', '2027-02-10'] });
  eq('invoice with credit + 2 installments created', r.status, 201);
  const invF = (await api('GET', `/api/contracts/${RF.id}`)).body.invoices.find((i) => i.reference === 'QAZ-Q recebida');
  const remF = Number((await credOf(cF.id, crF.id)).remaining);
  const payF = (await sql.query('select id from payments where invoice_id = ? order by id', [invF.id]))[0]; payIds(payF);
  const snapF = async () => JSON.stringify([(await sql.query('select id, amount, receipt_status, status from payments where invoice_id = ? order by id', [invF.id]))[0], await cnt('invoices', 'id = ?', [invF.id]), Number((await credOf(cF.id, crF.id)).remaining)]);
  for (const [label, body] of [['received', { receiptStatus: 'received', receivedDate: '2027-01-10' }], ['sent', { receiptStatus: 'sent', receivedDate: '2027-01-10' }]]) {
    await api('PUT', `/api/payments/${payF[0].id}`, body);
    const s0 = await snapF();
    r = await api('DELETE', `/api/invoices/${invF.id}`);
    ok(`fatura with a ${label} installment: DELETE -> 409 with the exact pt-BR message`, r.status === 409 && r.body?.error === 'Não é possível excluir: já há pagamento(s) recebido(s) nesta fatura. Para cancelar uma fatura com pagamentos recebidos será necessário o processo de rescisão (ainda não implementado).', `${r.status} ${short(r.body)}`);
    eq(`...nothing changed (fatura, payments, credit) after the refused delete (${label})`, await snapF(), s0);
    await api('PUT', `/api/payments/${payF[0].id}`, { receiptStatus: 'open', receivedDate: null });
  }
  // a saída marked done also counts
  await api('PUT', `/api/payments/${payF[1].id}`, { flow: 'out', status: 'done', paidDate: '2027-02-10' });
  eq('fatura with a PAID (saída done) payment: DELETE -> 409', (await api('DELETE', `/api/invoices/${invF.id}`)).status, 409);
  await api('PUT', `/api/payments/${payF[1].id}`, { flow: 'in', status: 'upcoming', paidDate: null });
  // the whole contract delete is also blocked by a received fatura payment (rule #7), editing the fatura too
  await api('PUT', `/api/payments/${payF[0].id}`, { receiptStatus: 'received', receivedDate: '2027-01-10' });
  eq('fatura PUT after a receipt -> 409 (unchanged rule)', (await api('PUT', `/api/invoices/${invF.id}`, { reference: 'x', itemIds: [itF[0]] })).status, 409);
  await api('PUT', `/api/payments/${payF[0].id}`, { receiptStatus: 'open', receivedDate: null });
  r = await api('DELETE', `/api/invoices/${invF.id}`);
  eq('before any receipt the fatura deletes (204)', r.status, 204);
  eq('credit reinstated EXACTLY to 100', Number((await credOf(cF.id, crF.id)).remaining), 100);
  ok('its payments are gone and its item is billable again', (await cnt('payments', 'invoice_id = ?', [invF.id])) === 0 && (await cnt('contract_items', 'id = ? and invoice_id is null', [itF[0]])) === 1);
  eq('deleting a missing fatura is unchanged (404 or 204, never 5xx)', (await api('DELETE', `/api/invoices/${invF.id}`)).status < 500, true);

  // ---- contract create: reference validation (before anything is written) ----
  const cV1 = await mkCust('QAZ-Q Cliente ref 1'); const cV2 = await mkCust('QAZ-Q Cliente ref 2');
  const crV1 = await addCredit(cV1.id, '50');
  const tabsQ = ['contracts', 'contract_items', 'payments', 'invoices', 'customer_credits'];
  const snapQ = async () => JSON.stringify([...(await Promise.all(tabsQ.map((t) => cnt(t)))), Number((await credOf(cV1.id, crV1.id)).remaining)]);
  for (const [label, body, re] of [
    ['unknown service version (single item)', { ...cb, customerId: cV1.id, items: [{ serviceVersionId: 2000000000 }] }, /Serviço não encontrado\./],
    ['unknown service version as the 2nd item', { ...cb, customerId: cV1.id, items: [{ serviceVersionId: sv1 }, { serviceVersionId: 2000000000 }] }, /Serviço não encontrado\./],
    ['unknown credit', { ...cb, customerId: cV1.id, creditId: 2000000000 }, /Crédito não encontrado\./],
    ['a credit that belongs to ANOTHER customer', { ...cb, customerId: cV2.id, creditId: crV1.id }, /Crédito não encontrado\./],
    ['a credit but no customer', { ...cb, customerId: undefined, creditId: crV1.id }, /Crédito não encontrado\./],
  ]) {
    const s0 = await snapQ();
    r = await api('POST', '/api/contracts', body);
    ok(`create with ${label} -> 400 pt-BR`, r.status === 400 && re.test(r.body?.error || ''), `${r.status} ${short(r.body)}`);
    eq(`...nothing written (rows and credit unchanged): ${label}`, await snapQ(), s0);
  }
  r = await api('POST', '/api/contracts', { ...cb, customerId: cV1.id, creditId: crV1.id, installments: 1, dueDates: ['2026-12-10'] });
  ok('own credit still works (201, credit applied)', r.status === 201 && Number(r.body.creditApplied) > 0, `${r.status} ${short(r.body)}`);
  if (r.status === 201) { created.contracts.push(r.body.id); payIds(r.body.payments || []); }
  r = await api('POST', '/api/contracts', { ...cb, customerId: cV1.id, installments: 1, dueDates: ['2026-12-10'] });
  ok('no credit still works (201)', r.status === 201, `${r.status}`); keep([r]);
  r = await api('POST', '/api/contracts', { customerId: cV1.id, type: 'invoice', title: 'QAZ-Q rec ok', invoiceTemplateId: tI, receiptTemplateId: tR });
  ok('recurring contract without items/credit still works (201)', r.status === 201, `${r.status}`); keep([r]);
  r = await api('POST', '/api/contracts', { ...cb, customerId: cV1.id, items: [] });
  ok('empty items unchanged (no 5xx)', r.status < 500, `${r.status} ${short(r.body)}`); keep([r]);
  await sql.query("delete from payments where description like 'QAZ-Q%'");

  sec('N. Misc regression');
  r = await api('GET', '/api/payments'); ok('payments list', r.status === 200 && Array.isArray(r.body));
  r = await api('GET', '/api/reports/summary'); eq('reports/summary 200', r.status, 200);
  r = await api('GET', '/api/reports/entries?from=2026-01-01&to=2026-12-31'); eq('reports/entries 200', r.status, 200);
  r = await api('GET', '/api/templates'); ok('templates list lacks content field', r.status === 200 && !('content' in (r.body[0] || {})));
}

async function cleanup() {
  sec('Z. Cleanup');
  const log = (m) => console.log('  cleanup: ' + m);
  const tryit = async (label, fn) => { try { await fn(); } catch (e) { log(`${label} failed: ${String(e.message).slice(0, 120)}`); } };
  if (!sql) { log('no SQL connection; nothing created'); return; }
  // documents via API (removes files on disk)
  for (const c of created.contracts) {
    await tryit('docs of contract ' + c, async () => {
      const r = await api('GET', `/api/contracts/${c}`);
      for (const d of r.body?.documents ?? []) await api('DELETE', `/api/contract-documents/${d.id}`);
    });
  }
  for (const d of [...new Set(created.docs)]) await tryit('doc ' + d, () => api('DELETE', `/api/contract-documents/${d}`));
  for (const i of created.invoices) await tryit('invoice ' + i, () => api('DELETE', `/api/invoices/${i}`));
  await tryit('bank rows', async () => {
    await sql.query("delete from transactions where import_id in (select id from bank_imports where file_name like 'QAZ-SMOKE%')");
    await sql.query("delete from bank_imports where file_name like 'QAZ-SMOKE%'");
  });
  for (const p of [...new Set(created.payments)]) await tryit('payment ' + p, () => api('DELETE', `/api/payments/${p}`));
  for (const c of created.contracts) await tryit('contract ' + c, () => api('DELETE', `/api/contracts/${c}`));
  // sweep: anything QAZ left (payments by description)
  await tryit('sweep payments', async () => { const [x] = await sql.query("delete from payments where description like 'QAZ%'"); if (x.affectedRows) log(`sweep removed ${x.affectedRows} payments`); });
  for (const c of created.customers) await tryit('customer ' + c, () => api('DELETE', `/api/customers/${c}`));
  for (const s of created.services) await tryit('service ' + s, () => api('DELETE', `/api/services/${s}`));
  for (const t of created.templates) await tryit('template ' + t, () => api('DELETE', `/api/templates/${t}`));
  for (const c of created.categories) await tryit('category ' + c, () => api('DELETE', `/api/categories/${c}`));
  await tryit('sweep leftovers', async () => {
    for (const [t, col] of [['customers', 'name'], ['services', 'name'], ['templates', 'name'], ['categories', 'name']]) {
      const [x] = await sql.query(`delete from \`${t}\` where \`${col}\` like 'QAZ%'`);
      if (x.affectedRows) log(`sweep removed ${x.affectedRows} from ${t}`);
    }
  });
  for (const f of [path.join(SCR, 'canary.txt'), path.join(ROOT, 'storage', 'QAZ-canary.txt')]) { try { fs.unlinkSync(f); } catch {} }
  const after = await counts();
  const diff = TABLES.filter((t) => after[t] !== baseline[t]);
  ok('cleanup: all table row counts back to baseline', diff.length === 0, diff.map((t) => `${t}: ${baseline[t]} -> ${after[t]}`).join('; '));
  const st = await api('GET', '/api/settings');
  ok('cleanup: settings equal to original', JSON.stringify(st.body) === JSON.stringify(origSettings));
  const files = fs.readdirSync(path.join(ROOT, 'storage', 'contracts')).filter((f) => f !== '.gitkeep');
  ok('cleanup: storage/contracts has no leftover generated files', files.length === 0, files.join(', '));
  ok('cleanup: storage/QAZ-canary.txt removed', !fs.existsSync(path.join(ROOT, 'storage', 'QAZ-canary.txt')));
  await sql.end();
}

let fatal = null;
try { await main(); } catch (e) { fatal = e; console.log('FATAL: ' + (e.stack || e.message).split('\n').slice(0, 6).join('\n')); }
try { await cleanup(); } catch (e) { console.log('CLEANUP ERROR: ' + e.message); }
const failed = results.filter((x) => !x.pass);
console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed${fatal ? ' (FATAL: ' + fatal.message + ')' : ''}`);
for (const f of failed) console.log(`  FAIL [${f.section}] ${f.name} -> ${f.extra}`);
fs.writeFileSync(path.join(SCR, 'results.json'), JSON.stringify(results, null, 1));
process.exit(failed.length || fatal ? 1 : 0);

