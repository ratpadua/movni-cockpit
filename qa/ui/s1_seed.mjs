import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
const { api, ok, eq, setFlow } = L;

setFlow('Seed via API');
if (!(await L.login())) { console.log('login failed'); process.exit(2); }
const st = {};
const mustOk = (r, what) => { if (r.status >= 300) { console.log('SEED FAIL', what, r.status, JSON.stringify(r.body)); process.exit(3); } return r.body; };

st.settings = (await api('GET', '/api/settings')).body;
const today = L.localToday();

const mkCust = async (o) => mustOk(await api('POST', '/api/customers', o), 'customer ' + o.name);
st.cu = await mkCust({ name: 'QAZ Cliente Teste', nickname: 'João Ação', email: 'qaz@example.test', city: 'Florianópolis', state: 'SC' });
st.cuAbaco = await mkCust({ name: 'QAZ Ábaco' });
st.cuZebra = await mkCust({ name: 'QAZ Zebra' });
st.cu10 = await mkCust({ name: 'QAZ Num 10' });
st.cu2 = await mkCust({ name: 'QAZ Num 2' });

st.catIn = mustOk(await api('POST', '/api/categories', { name: 'QAZ Cat In', flow: 'in' }), 'cat');
st.catOut = mustOk(await api('POST', '/api/categories', { name: 'QAZ Cat Out', flow: 'out' }), 'cat');
st.catAgua = mustOk(await api('POST', '/api/categories', { name: 'QAZ Água', flow: 'out' }), 'cat');

const svc = mustOk(await api('POST', '/api/services', { name: 'QAZ Servico', description: 'desc', basePrice: '900,00', additionals: [{ name: 'Extra', price: '100' }] }), 'service');
st.svc = svc; st.sv1 = svc.currentVersion.id; st.add1 = svc.currentVersion.additionals[0].id;
const svc2 = mustOk(await api('POST', '/api/services', { name: 'QAZ Água Serviço', basePrice: '50' }), 'service2');
st.svc2 = svc2;

const tpl = async (kind, name, fileName, paras) => mustOk(await api('POST', '/api/templates', { kind, name, fileName, content: L.buildDocx(paras).toString('base64') }), 'tpl ' + name);
st.tC = await tpl('contract', 'QAZ Modelo Contrato', 'Modelo João Ação.docx', L.CONTRACT_PARAS);
st.tI = await tpl('invoice', 'QAZ Modelo Fatura', 'fatura.docx', L.INVOICE_PARAS);
st.tR = await tpl('receipt', 'QAZ Modelo Recibo', 'recibo.docx', L.RECEIPT_PARAS);

// credits: one used by C1, one left open
st.credUsed = mustOk(await api('POST', `/api/customers/${st.cu.id}/credits`, { description: 'QAZ credito usado', value: '100' }), 'credit');
st.credOpen = mustOk(await api('POST', `/api/customers/${st.cu.id}/credits`, { description: 'QAZ credito aberto', value: '300' }), 'credit2');

await api('POST', ('/api/customers/' + st.cu.id + '/credits'), { description: 'QAZ credito fatura', value: '120' });
// C1: one-time with credit and 3 installments
st.C1 = mustOk(await api('POST', '/api/contracts', {
  customerId: st.cu.id, type: 'contract', items: [{ serviceVersionId: st.sv1, additionals: [{ additionalId: st.add1, quantity: 1 }] }],
  templateId: st.tC.id, receiptTemplateId: st.tR.id, creditId: st.credUsed.id, installments: 3,
  dueDates: [L.addDays(today, 5), L.addDays(today, 35), L.addDays(today, 65)], executionDate: L.addDays(today, 20), executionTime: '10:00', executionAddress: 'Local Teste', duration: '2h', quantity: 2,
}), 'C1');
// C2: one-time to be overdue in Painel (em_edicao for > edit window)
st.C2 = mustOk(await api('POST', '/api/contracts', {
  customerId: st.cuAbaco.id, type: 'contract', items: [{ serviceVersionId: st.sv1 }], templateId: st.tC.id, receiptTemplateId: st.tR.id, installments: 1, dueDates: [L.addDays(today, 10)],
}), 'C2');
for (const s of ['agendado', 'realizado', 'em_edicao']) mustOk(await api('PUT', `/api/contracts/${st.C2.id}/status`, { status: s }), 'status ' + s);
// R1: recurring (items/invoices done through the UI)
st.R1 = mustOk(await api('POST', '/api/contracts', { customerId: st.cu.id, type: 'invoice', title: 'QAZ Recorrente', invoiceTemplateId: st.tI.id, receiptTemplateId: st.tR.id }), 'R1');

// payments for Painel / Fluxo de Caixa
// (the 'current month' checks need these inside the current month, also on the last days of a month)
const soon = (n) => { const x = L.addDays(today, n); return x.slice(0, 7) === today.slice(0, 7) ? x : today; };
const pay = async (o) => mustOk(await api('POST', '/api/payments', o), 'payment ' + o.description);
st.pLateIn = await pay({ description: 'QAZ-UI entrada atrasada', amount: '123.45', flow: 'in', dueDate: '2026-09-15', customerId: st.cu.id, categoryId: st.catIn.id });
st.pLateOut = await pay({ description: 'QAZ-UI saida atrasada', amount: '67.89', flow: 'out', dueDate: '2026-09-20', categoryId: st.catOut.id });
st.pOpenIn = await pay({ description: 'QAZ-UI entrada aberta', amount: '1234.56', flow: 'in', dueDate: soon(2), customerId: st.cu.id, contractId: st.C1.id, categoryId: st.catIn.id });
st.pOpenOut = await pay({ description: 'QAZ-UI saida a pagar', amount: '1000', flow: 'out', dueDate: soon(1), categoryId: st.catAgua.id });
st.pRecv = await pay({ description: 'QAZ-UI entrada recebida', amount: '50', flow: 'in', dueDate: today, receiptStatus: 'received', receivedDate: today, customerId: st.cu.id });
st.pSent = await pay({ description: 'QAZ-UI entrada enviada', amount: '40', flow: 'in', dueDate: today, receiptStatus: 'sent', receivedDate: today, customerId: st.cu.id });
st.pDone = await pay({ description: 'QAZ-UI saida paga', amount: '30', flow: 'out', dueDate: today, status: 'done', paidDate: today });
st.pNext = await pay({ description: 'QAZ-UI proximo mes', amount: '10', flow: 'out', dueDate: L.addDays(today, 40) });

fs.writeFileSync(path.join(L.QA, 'state.json'), JSON.stringify(st, null, 1));
const sql = await L.sqlConnect();
// make C2 overdue: statusChangedAt 40 days ago
await sql.query('update contracts set status_changed_at = ? where id = ?', [new Date(Date.now() - 40 * 86400000), st.C2.id]);
await sql.end();
const ov = (await api('GET', '/api/contracts/overdue')).body;
ok('C2 shows in overdue API', Array.isArray(ov) && ov.some((o) => o.id === st.C2.id), JSON.stringify(ov).slice(0, 200));
console.log('C1', st.C1.number, 'C2', st.C2.number, 'R1', st.R1.number, 'C1 total', st.C1.total, 'payments', st.C1.payments.length);
L.saveResults('r1.json');

