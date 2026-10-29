import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
const { api, ok, setFlow } = L;
setFlow('Cleanup');
await L.login();
const sql = await L.sqlConnect();
const base = JSON.parse(fs.readFileSync(path.join(L.QA, 'baseline.json'), 'utf8'));
const st = fs.existsSync(path.join(L.QA, 'state.json')) ? JSON.parse(fs.readFileSync(path.join(L.QA, 'state.json'), 'utf8')) : {};
const log = (m) => console.log('  cleanup: ' + m);
const tryit = async (label, fn) => { try { await fn(); } catch (e) { log(`${label} failed: ${String(e.message).slice(0, 150)}`); } };

// restore settings first
if (st.settings) {
  await tryit('settings', async () => {
    const D = { menuColor: '#ffffff', accentColor: '#228be6', bgColor: '#f8f9fa', buttonColor: '#228be6', buttonHoverColor: '#1c7ed6' };
    const restore = {};
    for (const k of Object.keys(D)) restore[k] = st.settings[k] === D[k] ? '' : st.settings[k];
    restore.editWindowDays = st.settings.editWindowDays; restore.previewWindowDays = st.settings.previewWindowDays; restore.minInstallmentValue = st.settings.minInstallmentValue;
    const r = await api('PUT', '/api/settings', restore);
    log('settings restore status ' + r.status);
  });
}

const contracts = (await api('GET', '/api/contracts')).body || [];
const qContracts = contracts.filter((c) => /^QAZ/i.test(c.customerName || '') || /^QAZ/i.test(c.title || ''));
for (const c of qContracts) {
  await tryit('docs ' + c.id, async () => {
    const r = await api('GET', `/api/contracts/${c.id}`);
    for (const d of r.body?.documents ?? []) await api('DELETE', `/api/contract-documents/${d.id}`);
    for (const i of r.body?.invoices ?? []) for (const d of i.documents ?? []) await api('DELETE', `/api/contract-documents/${d.id}`);
  });
}
for (const c of qContracts) {
  await tryit('invoices ' + c.id, async () => {
    const r = await api('GET', `/api/contracts/${c.id}`);
    for (const i of r.body?.invoices ?? []) await api('DELETE', `/api/invoices/${i.id}`);
  });
}
await tryit('bank rows', async () => {
  await sql.query("delete from transactions where import_id in (select id from bank_imports where file_name like 'QAZ%')");
  await sql.query("delete from bank_imports where file_name like 'QAZ%'");
});
const qContractIds = qContracts.map((c) => c.id);
const customers = (await api('GET', '/api/customers')).body || [];
const qCustIds = customers.filter((c) => /^QAZ/i.test(c.name)).map((c) => c.id);
const payments = (await api('GET', '/api/payments')).body || [];
for (const p of payments) {
  if (/^QAZ/i.test(p.description || '') || qContractIds.includes(p.contractId) || qCustIds.includes(p.customerId)) await tryit('payment ' + p.id, () => api('DELETE', `/api/payments/${p.id}`));
}
if (fs.existsSync(path.join(L.QA, 'baseline_payment_ids.json'))) {
  const keep = new Set(JSON.parse(fs.readFileSync(path.join(L.QA, 'baseline_payment_ids.json'), 'utf8')));
  const pays2 = (await api('GET', '/api/payments')).body || [];
  for (const p of pays2) if (!keep.has(p.id)) { log(`removing non-baseline payment ${p.id} "${p.description}"`); await tryit('payment ' + p.id, () => api('DELETE', `/api/payments/${p.id}`)); }
}
for (const c of qContracts) await tryit('contract ' + c.id, () => api('DELETE', `/api/contracts/${c.id}`));
await tryit('sweep payments', async () => { const [x] = await sql.query("delete from payments where description like 'QAZ%'"); if (x.affectedRows) log(`sweep removed ${x.affectedRows} payments`); });
for (const id of qCustIds) await tryit('customer ' + id, async () => {
  const cr = (await api('GET', `/api/customers/${id}/credits?all=1`)).body || [];
  for (const k of cr) await api('DELETE', `/api/customers/${id}/credits/${k.id}`);
  const r = await api('DELETE', `/api/customers/${id}`);
  if (r.status >= 300) log(`customer ${id} delete -> ${r.status}`);
});
const services = (await api('GET', '/api/services')).body || [];
for (const s of services.filter((x) => /^QAZ/i.test(x.name))) await tryit('service ' + s.id, () => api('DELETE', `/api/services/${s.id}`));
const templates = (await api('GET', '/api/templates')).body || [];
for (const t of templates.filter((x) => /^QAZ/i.test(x.name))) await tryit('template ' + t.id, () => api('DELETE', `/api/templates/${t.id}`));
const cats = (await api('GET', '/api/categories')).body || [];
for (const c of cats.filter((x) => /^QAZ/i.test(x.name))) await tryit('category ' + c.id, () => api('DELETE', `/api/categories/${c.id}`));
await tryit('sweep leftovers', async () => {
  for (const [t, col] of [['customers', 'name'], ['services', 'name'], ['templates', 'name'], ['categories', 'name']]) {
    const [x] = await sql.query(`delete from \`${t}\` where \`${col}\` like 'QAZ%'`);
    if (x.affectedRows) log(`sweep removed ${x.affectedRows} from ${t}`);
  }
});
const after = await L.counts(sql);
const diff = L.TABLES.filter((t) => after[t] !== base[t]);
ok('cleanup: all table row counts back to baseline', diff.length === 0, diff.map((t) => `${t}: ${base[t]} -> ${after[t]}`).join('; '));
const s = (await api('GET', '/api/settings')).body;
const keys = ['menuColor', 'accentColor', 'bgColor', 'buttonColor', 'buttonHoverColor', 'editWindowDays', 'previewWindowDays', 'minInstallmentValue', 'logoMime'];
ok('cleanup: settings equal to original', !st.settings || keys.every((k) => JSON.stringify(s[k]) === JSON.stringify(st.settings[k])), JSON.stringify(keys.filter((k) => JSON.stringify(s[k]) !== JSON.stringify(st.settings[k]))));
const files = fs.readdirSync(path.join(L.ROOT, 'storage', 'contracts')).filter((f) => f !== '.gitkeep');
ok('cleanup: storage/contracts has no leftover files', files.length === 0, files.join(', '));
console.log('after', JSON.stringify(after));
await sql.end();
L.saveResults('r9.json');
