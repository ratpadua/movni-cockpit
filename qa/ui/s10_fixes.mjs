// UI checks for the "UI-bug fixes" batch (run after s1_seed, before s9_cleanup; see run-all.mjs).
//  1. DateField: typed dates are parsed strictly as dd/MM/yyyy, in EVERY screen that has a date field
//  2. "Editar fatura" shows the credit it already used (even when fully used) and the net amount;
//     a NEW invoice cannot select fully used credits
//  3. money NumberInputs use pt-BR (1.234,56), values sent to the server stay numbers
//  4. "Pagamento extra": Situação follows Tipo; an entrada marked Recebido really becomes received
//  5. bank import fingerprint uses the ORIGINAL statement values (edit date + amount, re-upload under
//     another file name -> every line "Já importado"; rows with NULL originals still match)
//  6. "Novo pagamento" / "Pagamento extra" validation (inline pt-BR messages, 0 is not changed to 0.01)
// All data is created through the API/UI with the QAZ prefix and removed by s9_cleanup.
import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start, DL } from './harness.mjs';
const { api, ok, eq } = L;
const S = await start();
const { page } = S;
const sp = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const today = L.localToday();
const must = (r, what) => { if (r.status >= 300) throw new Error(`setup ${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const q = async (text, params) => { const c = await L.sqlConnect(); try { return await c.query(text, params); } finally { await c.end(); } };

// ---------- helpers ----------
const typeKeys = async (loc, txt) => {
  await loc.click();
  await loc.press('Control+a');
  await loc.pressSequentially(txt, { delay: 25 });
  await loc.press('Tab');
  return loc.inputValue();
};
// Full typed-date probe for one DateField (`loc` = the text input). Leaves the field on 15/11/2026.
async function dateProbe(label, loc, { clearable = false } = {}) {
  eq(`${label}: typing 15/11/2026 keeps 15/11/2026`, await typeKeys(loc, '15/11/2026'), '15/11/2026');
  eq(`${label}: typing 03/04/2027 is 3 April (03/04/2027)`, await typeKeys(loc, '03/04/2027'), '03/04/2027');
  eq(`${label}: impossible date 31/02/2027 is ignored (value kept)`, await typeKeys(loc, '31/02/2027'), '03/04/2027');
  eq(`${label}: partial input "1/1" is harmless (value kept)`, await typeKeys(loc, '1/1'), '03/04/2027');
  eq(`${label}: garbage "abc" is harmless (value kept)`, await typeKeys(loc, 'abc'), '03/04/2027');
  eq(`${label}: 1/2/2027 (d/M/yyyy) is 01/02/2027`, await typeKeys(loc, '1/2/2027'), '01/02/2027');
  await loc.click();
  await loc.press('Control+a');
  await loc.press('Backspace');
  await loc.press('Tab');
  const cleared = await loc.inputValue();
  if (clearable) eq(`${label}: clearing the field works (empty)`, cleared, '');
  else ok(`${label}: clearing a required field reverts to the previous valid date (or empties)`, cleared === '' || cleared === '01/02/2027', cleared);
  // calendar picking
  let picked = '';
  for (let attempt = 0; attempt < 3 && !/^20\/\d{2}\/\d{4}$/.test(picked); attempt++) { // a freshly opened popover can swallow a click
    await loc.click();
    const day = page.locator('.mantine-Popover-dropdown button.mantine-DateInput-day:not([data-outside])').filter({ visible: true }).filter({ hasText: /^20$/ }).last();
    await day.waitFor({ timeout: 5000 });
    await day.click();
    await page.waitForFunction((el) => /^20\/\d{2}\/\d{4}$/.test(el.value), await loc.elementHandle(), { timeout: 1500 }).catch(() => {});
    picked = await loc.inputValue();
  }
  ok(`${label}: calendar pick day 20 shows dd/MM/yyyy`, /^20\/\d{2}\/\d{4}$/.test(picked), picked);
  eq(`${label}: typing again after picking works (15/11/2026)`, await typeKeys(loc, '15/11/2026'), '15/11/2026');
}
const typeMoney = async (loc, txt) => { await loc.click(); await loc.press('Control+a'); await loc.pressSequentially(txt, { delay: 25 }); await loc.press('Tab'); return sp(await loc.inputValue()); };
// poll an input until it shows `want` (or the timeout), return the last value
const settle = async (loc, want, ms = 2500) => { const t0 = Date.now(); let v = await loc.inputValue(); while (v !== want && Date.now() - t0 < ms) { await page.waitForTimeout(100); v = await loc.inputValue(); } return v; };
// money probe for one field: (1) the way a pt-BR user types a thousand: "1.234,56" key by key, (2) plain "1234,56".
// Returns the display after (2); both must read R$ 1.234,56.
async function moneyBoth(label, loc, { prefix = 'R$ ', neg = false } = {}) {
  const a = await typeMoney(loc, '1.234,56');
  ok(label + ': typing "1.234,56" key by key shows ' + prefix + '1.234,56', a === prefix + '1.234,56', 'shows "' + a + '"');
  // pasting / programmatic fill of the same text
  await loc.fill('1.234,56'); await loc.press('Tab');
  const c = sp(await loc.inputValue());
  ok(label + ': pasting "1.234,56" shows ' + prefix + '1.234,56', c === prefix + '1.234,56', 'shows "' + c + '"');
  if (sp(await typeMoney(loc, '1.234,56')) !== prefix + '1.234,56') { await typeMoney(loc, '1.234,56'); await L.shot(page, 'BUG_money_typed_' + label); }
  const b = await typeMoney(loc, '1234,56');
  eq(label + ': typing "1234,56" shows ' + prefix + '1.234,56', b, prefix + '1.234,56');
  const h = await typeMoney(loc, '0,5');
  ok(label + ': typing "0,5" shows ' + prefix + '0,5 (or 0,50)', h === prefix + '0,5' || h === prefix + '0,50' || (/Settings minimum/.test(label) && h === 'R$ 1,00') /* field min is R$ 1 by design */, 'shows "' + h + '"');
  if (neg) {
    const n = await typeMoney(loc, '-1.234,56');
    ok(label + ': typing "-1.234,56" shows -' + prefix + '1.234,56', n === '-' + prefix + '1.234,56', 'shows "' + n + '"');
  }
  await loc.fill('1234.56'); await loc.press('Tab');
  const pp = sp(await loc.inputValue());
  console.log('  PASTE "1234.56" in ' + label + ' ->', pp);
  L.results.push({ flow: 'info', name: label + ': paste "1234.56" yields "' + pp + '"', pass: true, extra: '' });
  await typeMoney(loc, '1234,56');
  return b;
}
const dbl = (n) => Math.round(Number(n) * 100) / 100;

// ---------- setup (API) ----------
L.setFlow('s10 setup');
const cuF = must(await api('POST', '/api/customers', { name: 'QAZ Fix Cliente', nickname: 'Fix Cli', email: 'qazfix@example.test' }), 'customer');
const svF = must(await api('POST', '/api/services', { name: 'QAZ Fix Servico', basePrice: '450' }), 'service');
const svFv = svF.currentVersion.id;
const crUsed = must(await api('POST', `/api/customers/${cuF.id}/credits`, { description: 'QAZ Fix credito 510', value: '510' }), 'credit');
const crSpare = must(await api('POST', `/api/customers/${cuF.id}/credits`, { description: 'QAZ Fix credito 200', value: '200' }), 'credit');
const R2 = must(await api('POST', '/api/contracts', { customerId: cuF.id, type: 'invoice', title: 'QAZ Fix Recorrente', invoiceTemplateId: st.tI.id, receiptTemplateId: st.tR.id }), 'recurring');
must(await api('POST', `/api/contracts/${R2.id}/items`, { serviceVersionId: svFv, items: [{ description: 'QAZ fix A' }, { description: 'QAZ fix B' }], performedAt: today }), 'items 2');
must(await api('POST', `/api/contracts/${R2.id}/items`, { serviceVersionId: svFv, quantity: 1, description: 'QAZ fix C livre', performedAt: today }), 'item C');
let r2 = (await api('GET', `/api/contracts/${R2.id}`)).body;
const itemsAB = r2.items.filter((i) => /QAZ fix [AB]/.test(i.description || '')).map((i) => i.id);
const inv1 = must(await api('POST', `/api/contracts/${R2.id}/invoices`, { itemIds: itemsAB, reference: 'QAZ Fix Fatura', creditId: crUsed.id, installments: 1, dueDates: [L.addDays(today, 15)], discountPercent: 0 }), 'invoice');
r2 = (await api('GET', `/api/contracts/${R2.id}`)).body;
const inv1Row = r2.invoices.find((i) => i.reference === 'QAZ Fix Fatura');
ok('setup: invoice of 2 x R$ 450 consumed the whole R$ 510 credit (creditApplied 510)', inv1Row && Number(inv1Row.creditApplied) === 510, JSON.stringify(inv1Row));
const credNow = (await api('GET', `/api/customers/${cuF.id}/credits?all=1`)).body.find((c) => c.id === crUsed.id);
eq('setup: credit remaining is 0 (fully used)', Number(credNow.remaining), 0);
// one-time contract for the extra-payment flows
const C9 = must(await api('POST', '/api/contracts', { customerId: cuF.id, type: 'contract', items: [{ serviceVersionId: svFv }], templateId: st.tC.id, receiptTemplateId: st.tR.id, installments: 1, dueDates: [L.addDays(today, 20)] }), 'one-time contract');
const catIn = st.catIn;

// =====================================================================
await S.flow('Fix 1 - DateField: Fluxo de Caixa (Novo pagamento, recorrente, receber, filtros)', async () => {
  await U.go(page, '/payments', 'Fluxo de Caixa');
  // filters (clearable)
  const from = page.getByLabel('Venc. de').first(), to = page.getByLabel('Venc. até').first();
  await dateProbe('filter "Venc. de"', from, { clearable: true });
  await dateProbe('filter "Venc. até"', to, { clearable: true });
  await typeKeys(from, '01/11/2026'); await typeKeys(to, '30/11/2026');
  await page.waitForTimeout(500);
  const dts = (await page.locator('tbody tr').allInnerTexts()).map((t) => (t.match(/\d{2}\/\d{2}\/\d{4}/) || [''])[0]).filter(Boolean);
  ok('filters De/Até typed 01/11/2026-30/11/2026: every listed due date inside November 2026', dts.length > 0 && dts.every((x) => x.endsWith('/11/2026')), JSON.stringify(dts));
  await L.shot(page, 'fix1_fluxo_filtros_digitados');
  await from.click(); await from.press('Control+a'); await from.press('Backspace'); await from.press('Tab');
  await to.click(); await to.press('Control+a'); await to.press('Backspace'); await to.press('Tab');
  eq('filters cleared (De)', await from.inputValue(), ''); eq('filters cleared (Até)', await to.inputValue(), '');
  // Novo pagamento: Vencimento typed, saved, compared with the API (stays yyyy-mm-dd)
  await page.getByRole('button', { name: 'Novo pagamento' }).click();
  let d = U.dlg(page);
  const due = d.getByLabel('Vencimento').first();
  await dateProbe('Novo pagamento "Vencimento"', due);
  await d.getByLabel('Descrição').fill('QAZ-FIX data digitada');
  await U.pickOption(page, d, 'Tipo', 'Entrada');
  await typeMoney(d.getByLabel('Valor (R$)'), '10');
  eq('Novo pagamento: typed 03/04/2027 before saving', await typeKeys(due, '03/04/2027'), '03/04/2027');
  await d.getByRole('button', { name: 'Salvar' }).click();
  await d.waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(600);
  const p1 = (await api('GET', '/api/payments')).body.find((p) => p.description === 'QAZ-FIX data digitada');
  ok('API: dueDate stored as yyyy-mm-dd 2027-04-03 (3 April, not 4 March)', p1 && p1.dueDate === '2027-04-03', JSON.stringify(p1));
  // recurring: Primeiro vencimento + Repetir até
  await page.getByRole('button', { name: 'Novo pagamento' }).click();
  d = U.dlg(page);
  await d.getByLabel('Descrição').fill('QAZ-FIX recorrente digitado');
  await typeMoney(d.getByLabel('Valor (R$)'), '5,5');
  await d.getByText('Pagamento recorrente', { exact: true }).click();
  await dateProbe('recorrente "Primeiro vencimento"', d.getByLabel('Primeiro vencimento').first());
  await dateProbe('recorrente "Repetir até"', d.getByLabel('Repetir até').first());
  await typeKeys(d.getByLabel('Primeiro vencimento').first(), '30/11/2026');
  await typeKeys(d.getByLabel('Repetir até').first(), '28/02/2027');
  await U.pickOption(page, d, 'Frequência', 'Mensal');
  await d.getByRole('button', { name: 'Criar pagamentos' }).click();
  ok('recurring created (toast "4 pagamentos criados")', await U.toast(page, /4 pagamentos criados/, 10000));
  await page.waitForTimeout(800);
  const rec = (await api('GET', '/api/payments')).body.filter((p) => p.description === 'QAZ-FIX recorrente digitado').map((p) => p.dueDate).sort();
  eq('API: recurring dates 30/11, 30/12, 30/01, 28/02 from the typed dates', JSON.stringify(rec), JSON.stringify(['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28']));
  // Marcar como recebido (receive modal) + edit modal "Data de recebimento"
  await U.go(page, '/payments', 'Fluxo de Caixa');
  await page.getByLabel('Venc. de').first().click();
  await typeKeys(page.getByLabel('Venc. de').first(), '01/04/2027'); await typeKeys(page.getByLabel('Venc. até').first(), '30/04/2027');
  await U.row(page, 'QAZ-FIX data digitada').getByRole('button', { name: 'Marcar recebido' }).click();
  d = U.dlg(page);
  await dateProbe('"Marcar recebido" -> "Data de recebimento"', d.getByLabel('Data de recebimento').first());
  await typeKeys(d.getByLabel('Data de recebimento').first(), '28/10/2026');
  await d.getByRole('button', { name: 'Confirmar' }).click();
  await page.waitForTimeout(900);
  const p2 = (await api('GET', '/api/payments')).body.find((p) => p.description === 'QAZ-FIX data digitada');
  ok('API: receivedDate 2026-10-28 and receiptStatus received', p2.receivedDate === '2026-10-28' && p2.receiptStatus === 'received', JSON.stringify([p2.receivedDate, p2.receiptStatus]));
  // edit modal of a received entrada: Data de recebimento
  await U.row(page, 'QAZ-FIX data digitada').getByTitle('Editar').click();
  d = U.dlg(page);
  await d.getByLabel('Data de recebimento').first().waitFor();
  await dateProbe('editar pagamento "Data de recebimento"', d.getByLabel('Data de recebimento').first());
  await U.closeModal(page);
});

await S.flow('Fix 1+3 - Contrato novo: datas digitadas, parcelas e modificador em pt-BR', async () => {
  await U.go(page, '/contracts', 'Contratos');
  await page.getByRole('button', { name: 'Novo contrato' }).click();
  const d = U.dlg(page);
  await U.pickOption(page, d, 'Cliente', 'QAZ Fix Cliente');
  await U.pickOption(page, d, 'Serviço (título do contrato)', 'QAZ Fix Servico');
  await d.getByText(/Preço base: R\$\s?450,00/).waitFor();
  await U.pickOption(page, d, 'Modelo do documento', 'QAZ Modelo Contrato');
  await U.pickOption(page, d, 'Modelo do recibo', 'QAZ Modelo Recibo');
  await dateProbe('contrato "Data"', d.getByLabel('Data', { exact: true }).first(), { clearable: true });
  await typeKeys(d.getByLabel('Data', { exact: true }).first(), '03/04/2027');
  // modifier with negative value in pt-BR
  await d.getByRole('button', { name: 'Adicionar' }).first().click().catch(() => {});
  const modName = d.getByPlaceholder('Descrição').last();
  await modName.fill('QAZ fix modificador');
  const modVal = d.locator('input[placeholder="Valor"]').first();
  const shown = await typeMoney(modVal, '-1.234,56');
  ok('contract modifier: typing "-1.234,56" key by key shows -R$ 1.234,56', /^-\s?R\$\s?1\.234,56$/.test(shown), 'shows "' + shown + '"');
  const shownB = await typeMoney(modVal, '-1234,56');
  ok('contract modifier: typing "-1234,56" shows -R$ 1.234,56', /^-\s?R\$\s?1\.234,56$/.test(shownB), shownB);
  const shown2 = await typeMoney(modVal, '-50,5');
  ok('contract modifier "-50,5" displays as -R$ 50,5 / -R$ 50,50', /^-\s?R\$\s?50,5/.test(shown2), shown2);
  const t = sp(await d.innerText());
  ok('summary reflects 450 - 50,50 = R$ 399,50', /399,50/.test(t), t.slice(-300));
  // installments: 2 -> typed first date + typed per-row date
  await U.pickOption(page, d, /Parcelas \(máx/, /^2 \(/);
  await dateProbe('contrato "Primeiro vencimento"', d.getByLabel('Primeiro vencimento').first());
  await typeKeys(d.getByLabel('Primeiro vencimento').first(), '10/01/2027');
  const rows = d.locator('table input[placeholder="dd/mm/aaaa"]');
  await rows.first().waitFor();
  eq('2 monthly rows from the typed first date', JSON.stringify(await rows.evaluateAll((e) => e.map((x) => x.value))), JSON.stringify(['10/01/2027', '10/02/2027']));
  await dateProbe('contrato parcela (linha 2)', rows.nth(1));
  await typeKeys(rows.nth(1), '15/02/2027');
  await L.shot(page, 'fix1_contrato_datas_digitadas');
  await d.getByRole('button', { name: 'Salvar' }).click();
  ok('toast "Contrato salvo"', await U.toast(page, /Contrato salvo/));
  await page.waitForTimeout(900);
  const created = (await api('GET', '/api/contracts')).body.filter((c) => c.customerName === 'QAZ Fix Cliente' && c.id !== C9.id && c.id !== R2.id).sort((a, b) => b.id - a.id)[0];
  const full = (await api('GET', `/api/contracts/${created.id}`)).body;
  eq('API: executionDate 2027-04-03', full.executionDate, '2027-04-03');
  const ins = full.payments.filter((p) => p.installmentNumber).sort((a, b) => a.installmentNumber - b.installmentNumber);
  eq('API: installment dates 2027-01-10, 2027-02-15', JSON.stringify(ins.map((p) => p.dueDate)), JSON.stringify(['2027-01-10', '2027-02-15']));
  eq('API: installments sum 399.50 (450 - 50.50)', dbl(ins.reduce((s, p) => s + Number(p.amount), 0)), 399.5);
  const mods = (await q('select price from contract_modifiers where contract_id = ?', [created.id]))[0];
  eq('DB: contract modifier price -50.50 (number, not a locale string)', Number(mods[0]?.price), -50.5);
  // contract EDIT modal (from the list) shows the saved modifier in pt-BR and has the same date field
  await U.go(page, '/contracts', 'Contratos');
  await U.row(page, full.number).getByTitle('Editar').click();
  const e = U.dlg(page);
  await e.getByText(/Editar contrato #/).first().waitFor();
  await page.waitForTimeout(600);
  const mv = await e.locator('input[placeholder="Valor"]').first().inputValue();
  ok('contract EDIT modal shows the modifier as -R$ 50,50 (pt-BR)', /^-\s?R\$\s?50,5/.test(sp(mv)), mv);
  eq('contract EDIT modal "Data" shows 03/04/2027', await e.getByLabel('Data', { exact: true }).first().inputValue(), '03/04/2027');
  await dateProbe('contrato EDIT "Data"', e.getByLabel('Data', { exact: true }).first(), { clearable: true });
  await U.closeModal(page);
  fs.writeFileSync(path.join(L.QA, 'state10.json'), JSON.stringify({ contractId: created.id }));
});

await S.flow('Fix 1+2+3 - Faturas: editar fatura com credito usado, nova fatura sem credito usado, modificador pt-BR', async () => {
  await U.go(page, `/contracts/${R2.id}`, undefined);
  await page.getByText('Faturas').first().waitFor();
  const card = page.locator('.mantine-Paper-root').filter({ hasText: 'QAZ Fix Fatura' }).last();
  await L.shot(page, 'fix2_recorrente_antes');
  await card.getByTitle('Editar fatura').click();
  let d = U.dlg(page);
  await d.getByText('Editar fatura').first().waitFor();
  await page.waitForTimeout(800);
  const credInput = d.getByLabel('Usar crédito do cliente').first();
  const credVal = sp(await credInput.inputValue());
  ok('Editar fatura: the fully used credit is shown selected ("QAZ Fix credito 510 — restante R$ 510,00")', /QAZ Fix credito 510/.test(credVal) && /restante R\$\s?510,00/.test(credVal), credVal);
  const t = sp(await d.innerText());
  ok('Editar fatura summary: Total R$ 900,00 · Crédito -R$ 510,00 · A parcelar R$ 390,00', /Total: R\$\s?900,00/.test(t) && /Crédito: -R\$\s?510,00/.test(t) && /A parcelar: R\$\s?390,00/.test(t), t.slice(-300));
  const opts = await U.optionsOf(page, d, 'Usar crédito do cliente'); await U.closeDropdown(page);
  ok('Editar fatura: options = applied credit + still-open credit', opts.some((o) => /credito 510/.test(o)) && opts.some((o) => /credito 200 — restante R\$\s?200,00/.test(sp(o))), JSON.stringify(opts));
  const dd = await d.locator('table input[placeholder="dd/mm/aaaa"]').evaluateAll((e) => e.map((x) => x.value));
  ok('Editar fatura: installment date dd/MM/yyyy', dd.length === 1 && /^\d{2}\/\d{2}\/\d{4}$/.test(dd[0]), JSON.stringify(dd));
  await dateProbe('fatura "Primeiro vencimento"', d.getByLabel('Primeiro vencimento').first());
  await typeKeys(d.getByLabel('Primeiro vencimento').first(), '20/01/2027');
  await L.shot(page, 'fix2_editar_fatura_credito_usado');
  await d.getByRole('button', { name: 'Salvar alterações' }).click();
  ok('toast "Fatura atualizada"', await U.toast(page, /Fatura atualizada/));
  await page.waitForTimeout(900);
  r2 = (await api('GET', `/api/contracts/${R2.id}`)).body;
  const i1 = r2.invoices.find((i) => i.reference === 'QAZ Fix Fatura');
  eq('API: credit still applied 510 after re-save', Number(i1.creditApplied), 510);
  const cr1 = (await api('GET', `/api/customers/${cuF.id}/credits?all=1`)).body.find((c) => c.id === crUsed.id);
  eq('API: credit remaining still 0 (not double-spent / not refunded)', Number(cr1.remaining), 0);
  const instPay = (await q('select amount, date_format(due_date, "%Y-%m-%d") d from payments where invoice_id = ?', [i1.id]))[0];
  eq('DB: invoice installment 390.00 on 2027-01-20 (net of the R$ 510 credit)', JSON.stringify(instPay.map((p) => [dbl(p.amount), p.d])), JSON.stringify([[390, '2027-01-20']]));

  // NEW invoice: fully used credit must not be offered; the open one is
  await page.getByRole('button', { name: 'Nova fatura' }).click();
  d = U.dlg(page);
  await d.getByText('Nova fatura').first().waitFor();
  await d.getByText(/QAZ fix C livre/).first().click();
  const nopts = await U.optionsOf(page, d, 'Usar crédito do cliente'); await U.closeDropdown(page);
  ok('Nova fatura: fully used credit NOT selectable', !nopts.some((o) => /credito 510/.test(o)), JSON.stringify(nopts));
  ok('Nova fatura: open credit (R$ 200,00) selectable', nopts.some((o) => /credito 200 — restante R\$\s?200,00/.test(sp(o))), JSON.stringify(nopts));
  // invoice modifier in pt-BR
  await d.getByRole('button', { name: 'Adicionar' }).first().click();
  await d.getByPlaceholder('Descrição').last().fill('QAZ fix mod fatura');
  const mv = d.locator('input[placeholder="Valor"]').first();
  await moneyBoth('invoice modifier Valor', mv, { neg: true });
  const t2 = sp(await d.innerText());
  ok('summary: Modificadores R$ 1.234,56 · Total R$ 1.684,56', /Modificadores: R\$\s?1\.234,56/.test(t2) && /Total: R\$\s?1\.684,56/.test(t2), t2.slice(-300));
  await d.getByLabel('Referência').fill('QAZ Fix Nova');
  await d.getByRole('button', { name: 'Criar fatura' }).click();
  ok('toast "Fatura criada"', await U.toast(page, /Fatura criada/));
  await page.waitForTimeout(900);
  const [mrow] = (await q("select m.price from invoice_modifiers m join invoices i on i.id = m.invoice_id where m.name = 'QAZ fix mod fatura'"))[0];
  eq('DB: invoice modifier stored as 1234.56', Number(mrow?.price), 1234.56);
});

await S.flow('Fix 4+6 - Pagamento extra: Situacao segue o Tipo, entrada Recebido, validacao', async () => {
  await U.go(page, `/contracts/${C9.id}`, undefined);
  await page.getByText('Itens do contrato').waitFor();
  await page.getByRole('button', { name: 'Pagamento extra' }).click();
  let x = U.dlg(page);
  // validation: empty description / 0
  await x.getByLabel('Valor (R$)').click();
  await U.pickOption(page, x, 'Categoria', 'QAZ Cat In');
  await x.getByRole('button', { name: 'Adicionar' }).click();
  ok('extra: empty description -> inline "Informe a descrição."', await x.getByText('Informe a descrição.').isVisible());
  ok('extra: empty amount -> inline "Informe um valor maior que zero."', await x.getByText('Informe um valor maior que zero.').isVisible());
  eq('extra: nothing created by the refused submit', (await api('GET', `/api/contracts/${C9.id}`)).body.payments.filter((p) => !p.installmentNumber).length, 0);
  await L.shot(page, 'fix6_extra_validacao');
  await x.getByLabel('Descrição').fill('QAZ-FIX extra zero');
  const z = await typeMoney(x.getByLabel('Valor (R$)'), '0');
  ok('extra: a typed 0 stays 0 (NOT silently changed to 0,01)', !/0,01/.test(z) && /^R\$\s?0(,00)?$/.test(z), z);
  await x.getByRole('button', { name: 'Adicionar' }).click();
  ok('extra: amount 0 -> "Informe um valor maior que zero."', await x.getByText('Informe um valor maior que zero.').isVisible());
  const neg = await typeMoney(x.getByLabel('Valor (R$)'), '-5');
  ok('extra: negative typed stays negative on screen (-R$ 5)', /^-\s?R\$\s?5/.test(neg), neg);
  await x.getByRole('button', { name: 'Adicionar' }).click();
  ok('extra: negative amount -> "Informe um valor maior que zero."', await x.getByText('Informe um valor maior que zero.').isVisible());
  eq('extra: still nothing created', (await api('GET', `/api/contracts/${C9.id}`)).body.payments.filter((p) => !p.installmentNumber).length, 0);
  // Situação options follow Tipo
  await moneyBoth('extra payment Valor (R$)', x.getByLabel('Valor (R$)'));
  const sitIn = await U.optionsOf(page, x, 'Situação'); await U.closeDropdown(page);
  eq('extra entrada: Situação options = Aberto, Recebido', JSON.stringify(sitIn), JSON.stringify(['Aberto', 'Recebido']));
  const tipo = await U.optionsOf(page, x, 'Tipo'); await U.closeDropdown(page);
  console.log('  Tipo options:', JSON.stringify(tipo));
  await U.pickOption(page, x, 'Tipo', 'Saída');
  const sitOut = await U.optionsOf(page, x, 'Situação'); await U.closeDropdown(page);
  eq('extra saída: Situação options = A pagar, Pago', JSON.stringify(sitOut), JSON.stringify(['A pagar', 'Pago']));
  eq('extra saída: Situação reset to the default "A pagar"', await settle(x.getByLabel('Situação').first(), 'A pagar'), 'A pagar');
  await U.pickOption(page, x, 'Tipo', 'Entrada');
  eq('extra back to entrada: Situação reset to "Aberto"', await settle(x.getByLabel('Situação').first(), 'Aberto'), 'Aberto');
  await dateProbe('extra "Vencimento"', x.getByLabel('Vencimento').first());
  await typeKeys(x.getByLabel('Vencimento').first(), '18/11/2026');
  await U.pickOption(page, x, 'Situação', 'Recebido');
  await L.shot(page, 'fix4_extra_recebido');
  await x.getByRole('button', { name: 'Adicionar' }).click();
  ok('toast "Pagamento adicionado"', await U.toast(page, /Pagamento adicionado/));
  await page.waitForTimeout(900);
  const full = (await api('GET', `/api/contracts/${C9.id}`)).body;
  const ex = full.payments.find((p) => p.description === 'QAZ-FIX extra zero');
  ok('API: extra entrada Recebido => receiptStatus received, amount 1234.56, due 2026-11-18, receivedDate set, no installment', ex && ex.receiptStatus === 'received' && Number(ex.amount) === 1234.56 && ex.dueDate === '2026-11-18' && !!ex.receivedDate && ex.installmentNumber === null && ex.flow === 'in', JSON.stringify(ex));
  const row = U.row(page, 'QAZ-FIX extra zero');
  const rowTxt = sp(await row.innerText());
  ok('screen: row shows R$ 1.234,56 and Recebido', /R\$\s?1\.234,56/.test(rowTxt) && /recebido/i.test(rowTxt), rowTxt);
  ok('screen: receipt button (Baixar) appears for the received extra entrada', (await row.getByRole('button', { name: 'Baixar' }).count()) > 0, rowTxt);
  ok('screen: no "Marcar recebido" on an already received entrada', (await row.getByRole('button', { name: 'Marcar recebido' }).count()) === 0);
  await L.shot(page, 'fix4_extra_recebido_linha');
  // saída Pago
  await page.getByRole('button', { name: 'Pagamento extra' }).click();
  x = U.dlg(page);
  await x.getByLabel('Descrição').fill('QAZ-FIX extra saida');
  await typeMoney(x.getByLabel('Valor (R$)'), '99,9');
  await U.pickOption(page, x, 'Tipo', 'Saída');
  await U.pickOption(page, x, 'Categoria', 'QAZ Cat Out');
  await U.pickOption(page, x, 'Situação', 'Pago');
  await x.getByRole('button', { name: 'Adicionar' }).click();
  ok('toast "Pagamento adicionado" (saída)', await U.toast(page, /Pagamento adicionado/));
  await page.waitForTimeout(900);
  const sx = (await api('GET', `/api/contracts/${C9.id}`)).body.payments.find((p) => p.description === 'QAZ-FIX extra saida');
  ok('API: extra saída Pago => status done, paidDate set, amount 99.90, flow out', sx && sx.status === 'done' && !!sx.paidDate && Number(sx.amount) === 99.9 && sx.flow === 'out', JSON.stringify(sx));
  // an entrada left "Aberto" stays open and offers "Marcar recebido"
  await page.getByRole('button', { name: 'Pagamento extra' }).click();
  x = U.dlg(page);
  await x.getByLabel('Descrição').fill('QAZ-FIX extra aberto');
  await typeMoney(x.getByLabel('Valor (R$)'), '20');
  await U.pickOption(page, x, 'Categoria', 'QAZ Cat In');
  await x.getByRole('button', { name: 'Adicionar' }).click();
  await U.toast(page, /Pagamento adicionado/);
  await page.waitForTimeout(900);
  const ox = (await api('GET', `/api/contracts/${C9.id}`)).body.payments.find((p) => p.description === 'QAZ-FIX extra aberto');
  ok('API: extra entrada Aberto => receiptStatus open', ox && ox.receiptStatus === 'open' && ox.status === 'upcoming', JSON.stringify(ox));
  const orow = U.row(page, 'QAZ-FIX extra aberto');
  await orow.getByRole('button', { name: 'Marcar recebido' }).click();
  const dlg2 = U.dlg(page);
  await dateProbe('contrato "Marcar recibo como recebido" -> "Data de recebimento"', dlg2.getByLabel('Data de recebimento').first());
  await typeKeys(dlg2.getByLabel('Data de recebimento').first(), '28/10/2026');
  await dlg2.getByRole('button', { name: 'Confirmar' }).click();
  await page.waitForTimeout(900);
  const ox2 = (await api('GET', `/api/contracts/${C9.id}`)).body.payments.find((p) => p.description === 'QAZ-FIX extra aberto');
  ok('"Marcar como recebido" still works (received, receivedDate 2026-10-28)', ox2.receiptStatus === 'received' && ox2.receivedDate === '2026-10-28', JSON.stringify(ox2));
});

await S.flow('Fix 6 - Novo pagamento / editar: validacao inline e pagamento legado com valor 0', async () => {
  await U.go(page, '/payments', 'Fluxo de Caixa');
  await page.getByRole('button', { name: 'Novo pagamento' }).click();
  let d = U.dlg(page);
  await d.getByRole('button', { name: 'Salvar' }).click();
  ok('empty description -> inline "Informe a descrição."', await d.getByText('Informe a descrição.').isVisible());
  ok('empty amount -> inline "Informe um valor maior que zero."', await d.getByText('Informe um valor maior que zero.').isVisible());
  await d.getByLabel('Descrição').fill('QAZ-FIX zero');
  const z = await typeMoney(d.getByLabel('Valor (R$)'), '0');
  ok('typed 0 stays 0 on screen (not changed to 0,01)', !/0,01/.test(z) && /^R\$\s?0(,00)?$/.test(z), z);
  await d.getByRole('button', { name: 'Salvar' }).click();
  ok('amount 0 refused with inline message', await d.getByText('Informe um valor maior que zero.').isVisible());
  const n = await typeMoney(d.getByLabel('Valor (R$)'), '-1,5');
  ok('negative stays negative on screen', /^-\s?R\$\s?1,5/.test(n), n);
  await d.getByRole('button', { name: 'Salvar' }).click();
  ok('negative refused with inline message', await d.getByText('Informe um valor maior que zero.').isVisible());
  await d.getByLabel('Descrição').fill('   ');
  await d.getByRole('button', { name: 'Salvar' }).click();
  ok('whitespace-only description refused ("Informe a descrição.")', await d.getByText('Informe a descrição.').isVisible());
  await L.shot(page, 'fix6_novo_pagamento_validacao');
  eq('nothing was created by the refused submits', (await api('GET', '/api/payments')).body.filter((p) => /^QAZ-FIX zero/.test(p.description)).length, 0);
  // valid: 1.234,56 (dot thousands typed)
  await d.getByLabel('Descrição').fill('QAZ-FIX money milhar');
  await moneyBoth('Novo pagamento Valor (R$)', d.getByLabel('Valor (R$)'));
  await d.getByRole('button', { name: 'Salvar' }).click();
  await d.waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(600);
  const p = (await api('GET', '/api/payments')).body.find((x) => x.description === 'QAZ-FIX money milhar');
  eq('API: "1.234,56" -> 1234.56', Number(p?.amount), 1234.56);
  // "1234,56" (no thousands dot)
  await page.getByRole('button', { name: 'Novo pagamento' }).click();
  d = U.dlg(page);
  await d.getByLabel('Descrição').fill('QAZ-FIX money simples');
  eq('typed "1234,56" shows R$ 1.234,56', await typeMoney(d.getByLabel('Valor (R$)'), '1234,56'), 'R$ 1.234,56');
  await d.getByRole('button', { name: 'Salvar' }).click();
  await d.waitFor({ state: 'hidden', timeout: 8000 });
  await page.waitForTimeout(600);
  eq('API: "1234,56" -> 1234.56', Number((await api('GET', '/api/payments')).body.find((x) => x.description === 'QAZ-FIX money simples')?.amount), 1234.56);
  // edit modal shows pt-BR and keeps the value
  const [leg] = (await q("insert into payments (description, amount, flow, due_date) values ('QAZ-FIX legado zero', '0', 'in', ?)", [today]));
  await U.go(page, '/payments', 'Fluxo de Caixa');
  await U.row(page, 'QAZ-FIX money milhar').getByTitle('Editar').click();
  d = U.dlg(page);
  await d.getByLabel('Descrição').waitFor();
  eq('edit modal shows the stored 1234.56 as R$ 1.234,56', sp(await d.getByLabel('Valor (R$)').inputValue()), 'R$ 1.234,56');
  await U.closeModal(page);
  // legacy payment with amount 0: other fields editable, amount <= 0 not accepted as a change
  await U.row(page, 'QAZ-FIX legado zero').getByTitle('Editar').click();
  d = U.dlg(page);
  await d.getByLabel('Descrição').fill('QAZ-FIX legado zero editado');
  await d.getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(1000);
  const lg = (await api('GET', '/api/payments')).body.find((x) => x.id === leg.insertId);
  ok('legacy 0 payment: description edit saved, amount still 0 (no silent 0,01)', lg && lg.description === 'QAZ-FIX legado zero editado' && Number(lg.amount) === 0, JSON.stringify(lg));
  await U.row(page, 'QAZ-FIX legado zero editado').getByTitle('Editar').click();
  d = U.dlg(page);
  await typeMoney(d.getByLabel('Valor (R$)'), '-3');
  await d.getByRole('button', { name: 'Salvar' }).click();
  ok('legacy 0 payment: changing the amount to a negative value is refused inline', await d.getByText('Informe um valor maior que zero.').isVisible());
  await U.closeModal(page);
});

await S.flow('Fix 3 - Dinheiro pt-BR: Cliente (credito), Servicos, Configuracoes', async () => {
  // customer credit
  await U.go(page, `/customers/${cuF.id}`, undefined);
  await page.getByRole('button', { name: 'Novo crédito' }).click();
  let d = U.dlg(page);
  await d.getByLabel('Descrição').fill('QAZ-FIX credito digitado');
  await moneyBoth('customer credit Valor', d.getByLabel('Valor'));
  await d.getByRole('button', { name: 'Adicionar' }).click();
  ok('toast "Crédito adicionado"', await U.toast(page, /Crédito adicionado/));
  await page.waitForTimeout(700);
  const cr = (await api('GET', `/api/customers/${cuF.id}/credits?all=1`)).body.find((c) => c.description === 'QAZ-FIX credito digitado');
  eq('API: credit value 1234.56', Number(cr?.value), 1234.56);
  ok('screen lists the credit as R$ 1.234,56', /R\$\s?1\.234,56/.test(sp(await U.bodyText(page))));
  await L.shot(page, 'fix3_cliente_credito');
  await page.getByRole('button', { name: 'Novo crédito' }).click();
  d = U.dlg(page);
  await d.getByLabel('Descrição').fill('QAZ-FIX credito negativo');
  await typeMoney(d.getByLabel('Valor'), '-10');
  ok('credit Valor: a negative value cannot be added (button disabled or refused)', await d.getByRole('button', { name: 'Adicionar' }).isDisabled(), 'Adicionar enabled with a negative value');
  await U.closeModal(page);

  // services
  await U.go(page, '/services', 'Serviços');
  await page.getByRole('button', { name: 'Novo serviço' }).click();
  d = U.dlg(page);
  await d.getByLabel('Nome').fill('QAZ Fix Servico Novo');
  await moneyBoth('service Preço base', d.getByLabel('Preço base'));
  await d.getByRole('button', { name: 'Adicionar' }).first().click();
  await d.getByPlaceholder('Nome do adicional').fill('QAZ adicional');
  eq('service additional "Preço" 99,9 shows R$ 99,9', sp(await typeMoney(d.getByPlaceholder('Preço'), '99,9')).replace(/,90$/, ',9'), 'R$ 99,9');
  await L.shot(page, 'fix3_servico_novo');
  await d.getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(1200);
  const svcs = (await api('GET', '/api/services')).body;
  const ns = svcs.find((s) => s.name === 'QAZ Fix Servico Novo');
  eq('API: service basePrice 1234.56', Number(ns?.currentVersion?.basePrice), 1234.56);
  eq('API: additional price 99.90', Number(ns?.currentVersion?.additionals?.[0]?.price), 99.9);
  // edit modal: new additional price field
  await U.row(page, 'QAZ Fix Servico Novo').getByTitle('Editar').click();
  d = U.dlg(page);
  await d.getByLabel('Novo adicional').fill('QAZ adicional 2');
  await moneyBoth('edit service Preço (novo adicional)', d.getByLabel('Preço', { exact: true }));
  await d.getByRole('button', { name: 'Adicionar' }).last().click();
  await page.waitForTimeout(1000);
  const ns2 = (await api('GET', '/api/services')).body.find((s) => s.name === 'QAZ Fix Servico Novo');
  ok('API: second additional price 1234.56', (ns2?.currentVersion?.additionals || []).some((a) => Number(a.price) === 1234.56), JSON.stringify(ns2?.currentVersion?.additionals));
  await U.closeModal(page);

  // settings: minimum installment
  const orig = (await api('GET', '/api/settings')).body;
  await U.go(page, '/settings', 'Aparência');
  const min = page.getByLabel('Valor mínimo por parcela (R$)');
  eq('Settings minimum shows the stored value in pt-BR', sp(await min.inputValue()), 'R$ ' + Number(orig.minInstallmentValue).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  await moneyBoth('Settings minimum', min);
  await page.getByRole('button', { name: 'Salvar parcelamento' }).click();
  ok('toast "Parcelamento salvo"', await U.toast(page, /Parcelamento salvo/));
  await page.waitForTimeout(700);
  eq('API: minInstallmentValue 1234.56', Number((await api('GET', '/api/settings')).body.minInstallmentValue), 1234.56);
  await typeMoney(min, '150,5');
  await page.getByRole('button', { name: 'Salvar parcelamento' }).click();
  await U.toast(page, /Parcelamento salvo/); await page.waitForTimeout(600);
  eq('API: minInstallmentValue 150.5', Number((await api('GET', '/api/settings')).body.minInstallmentValue), 150.5);
  await typeMoney(min, String(orig.minInstallmentValue).replace('.', ','));
  await page.getByRole('button', { name: 'Salvar parcelamento' }).click();
  await U.toast(page, /Parcelamento salvo/); await page.waitForTimeout(600);
  eq('API: minInstallmentValue restored', Number((await api('GET', '/api/settings')).body.minInstallmentValue), Number(orig.minInstallmentValue));
});

await S.flow('Fix 1 - DateField: Relatorios', async () => {
  await U.go(page, '/reports', 'Relatórios');
  await dateProbe('Relatórios "De"', page.getByLabel('De', { exact: true }).first(), { clearable: true });
  await dateProbe('Relatórios "Até"', page.getByLabel('Até', { exact: true }).first(), { clearable: true });
  await typeKeys(page.getByLabel('De', { exact: true }).first(), '01/10/2026');
  await typeKeys(page.getByLabel('Até', { exact: true }).first(), '31/10/2026');
  await page.getByRole('button', { name: 'Filtrar' }).click();
  await page.waitForTimeout(900);
  const sum = (await api('GET', '/api/reports/summary?from=2026-10-01&to=2026-10-31')).body;
  const fmt = (n) => sp(n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
  ok('typed 01/10/2026-31/10/2026 filter matches the API summary for 2026-10-01..2026-10-31', sp(await U.bodyText(page)).includes(fmt(Number(sum.totalIn))), JSON.stringify(sum));
  await L.shot(page, 'fix1_relatorios');
});

await S.flow('Fix 1 - DateField: Contrato recorrente (Adicionar servico realizado)', async () => {
  await U.go(page, `/contracts/${R2.id}`, undefined);
  await page.getByText('Serviços realizados').waitFor();
  await page.getByRole('button', { name: 'Adicionar serviço' }).click();
  const d = U.dlg(page);
  await U.pickOption(page, d, 'Serviço', 'QAZ Fix Servico');
  await d.getByText('Total do item').waitFor();
  await dateProbe('serviço realizado "Data de realização"', d.getByLabel('Data de realização').first());
  await typeKeys(d.getByLabel('Data de realização').first(), '05/10/2026');
  await d.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await U.toast(page, /adicionad/i);
  await page.waitForTimeout(900);
  const it = (await api('GET', `/api/contracts/${R2.id}`)).body.items.filter((i) => i.performedAt === '2026-10-05');
  ok('API: performedAt 2026-10-05 saved from the typed date', it.length >= 1, JSON.stringify(it.map((i) => i.performedAt)));
  // edit the new item's date
  await page.getByTitle('Editar').first().click().catch(() => {});
  const e = U.dlg(page);
  if (await e.getByLabel('Data de realização').first().isVisible().catch(() => false)) await dateProbe('editar serviço realizado "Data de realização"', e.getByLabel('Data de realização').first());
  await U.closeModal(page);
});

await S.flow('Fix 5 - Importar extrato: fingerprint com valores originais (data e valor editados)', async () => {
  const stm = (extra) => `OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0001<ACCTID>QAZ-ACCT</BANKACCTFROM><BANKTRANLIST>${extra}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const trn = (o) => `<STMTTRN><TRNTYPE>${o.type || 'CREDIT'}<DTPOSTED>${o.date}<TRNAMT>${o.amt}<FITID>${o.fit}<NAME>${o.name}<MEMO>${o.memo}</STMTTRN>`;
  const ofx = stm([
    trn({ fit: 'QFX1', amt: '321.45', date: '20261020120000[-3:BRT]', name: 'PIX Fix', memo: 'QAZ-FIX linha 1' }),
    trn({ fit: 'QFX2', amt: '-45.50', type: 'DEBIT', date: '20261021120000[-3:BRT]', name: 'Compra', memo: 'QAZ-FIX linha 2' }),
    trn({ fit: 'QFX3', amt: '99.90', date: '20261022120000[-3:BRT]', name: 'PIX Fix', memo: 'QAZ-FIX linha 3' }),
  ].join(''));
  const f1 = path.join(DL, 'QAZ-FIX-extrato-a.ofx'), f2 = path.join(DL, 'QAZ-FIX-extrato-OUTRO-NOME.ofx');
  fs.writeFileSync(f1, ofx, 'latin1'); fs.writeFileSync(f2, ofx, 'latin1');
  await U.go(page, '/bank', 'Extratos bancários');
  await page.locator('input[type=file]').setInputFiles(f1);
  await page.getByText(/Arquivo:/).waitFor();
  const rowsLoc = page.locator('tbody tr');
  eq('3 preview lines', await rowsLoc.count(), 3);
  const amtInputs = page.locator('tbody tr td:nth-child(5) input');
  eq('preview amount of line 1 shown in pt-BR (321,45)', sp(await amtInputs.nth(0).inputValue()), '321,45');
  // edit date AND amount of every line
  const dateIns = page.locator('tbody input[placeholder="dd/mm/aaaa"]');
  await dateProbe('extrato preview "data" (linha 1)', dateIns.nth(0));
  await moneyBoth('bank preview amount (line 1)', amtInputs.nth(0), { prefix: '', neg: true });
  // line 2 is a saída (negative): typing a negative value over the selected text must keep the sign
  const negTyped = await typeMoney(amtInputs.nth(1), '-50,25');
  ok('bank preview: select-all + typing "-50,25" on a saída line keeps the minus sign', negTyped === '-50,25', 'shows "' + negTyped + '"');
  if (negTyped !== '-50,25') {
    await L.shot(page, 'BUG_bank_preview_negativo');
    await amtInputs.nth(1).click(); await amtInputs.nth(1).press('Home'); await amtInputs.nth(1).pressSequentially('-'); await amtInputs.nth(1).press('Tab');
  }
  const edits = [['01/11/2026', null], ['02/11/2026', null], ['03/11/2026', '100']];
  for (let i = 0; i < 3; i++) {
    await typeKeys(dateIns.nth(i), edits[i][0]);
    if (edits[i][1]) await typeMoney(amtInputs.nth(i), edits[i][1]);
  }
  eq('line 1 amount shows 1.234,56', sp(await amtInputs.nth(0).inputValue()), '1.234,56');
  eq('line 2 amount (saída) shows -50,25', sp(await amtInputs.nth(1).inputValue()), '-50,25');
  await L.shot(page, 'fix5_extrato_editado');
  await U.clearToasts(page);
  await page.getByRole('button', { name: 'Importar selecionados (3)' }).click();
  ok('import toast shows 3 created', await U.toast(page, /3 criado\(s\)/, 12000));
  await page.waitForTimeout(900);
  const [tr] = await q("select fit_id, date_format(date,'%Y-%m-%d') d, amount, date_format(orig_date,'%Y-%m-%d') od, orig_amount oa from transactions where fit_id in ('QFX1','QFX2','QFX3') order by fit_id");
  eq('DB: stored (edited) dates', JSON.stringify(tr.map((x) => x.d)), JSON.stringify(['2026-11-01', '2026-11-02', '2026-11-03']));
  eq('DB: stored (edited) amounts', JSON.stringify(tr.map((x) => Number(x.amount))), JSON.stringify([1234.56, -50.25, 100]));
  eq('DB: orig_date = statement dates', JSON.stringify(tr.map((x) => x.od)), JSON.stringify(['2026-10-20', '2026-10-21', '2026-10-22']));
  eq('DB: orig_amount = statement amounts', JSON.stringify(tr.map((x) => Number(x.oa))), JSON.stringify([321.45, -45.5, 99.9]));
  const pays = (await api('GET', '/api/payments')).body.filter((p) => /^QAZ-FIX linha/.test(p.description));
  ok('API: payments created with the EDITED date/amount', pays.length === 3 && pays.some((p) => p.dueDate === '2026-11-01' && Number(p.amount) === 1234.56), JSON.stringify(pays.map((p) => [p.dueDate, p.amount, p.flow])));
  // re-upload the same statement under ANOTHER file name: all lines must be flagged
  await page.locator('input[type=file]').setInputFiles(f2);
  await page.getByText(/Arquivo:/).waitFor();
  await page.waitForTimeout(700);
  eq('re-upload (other file name): 3 "Já importado" badges', await page.getByText('Já importado', { exact: true }).count(), 3);
  ok('re-upload: "Importar selecionados (0)" (all unselected)', await page.getByRole('button', { name: 'Importar selecionados (0)' }).isVisible());
  ok('re-upload: summary alert "3 lançamentos deste extrato já foram importados antes"', /3 lançamentos deste extrato já foram importados antes/.test(sp(await U.bodyText(page))));
  await L.shot(page, 'fix5_extrato_reupload_marcado');
  // legacy row (NULL originals) still matches on the stored values
  const [bi] = await q("insert into bank_imports (file_name, bank_id, account_id, item_count) values ('QAZ-FIX-old.ofx', '0001', 'QAZ-ACCT', 1)");
  await q("insert into transactions (import_id, fit_id, date, description, memo, amount, flow, imported) values (?, 'QFXOLD', '2026-10-24', 'PIX Old', 'QAZ-FIX old', '45.67', 'in', 1)", [bi.insertId]);
  const oldOfx = stm(trn({ fit: 'QFXOLD', amt: '45.67', date: '20261024120000[-3:BRT]', name: 'PIX Old', memo: 'QAZ-FIX old' }) + trn({ fit: 'QFXNEW', amt: '45.67', date: '20261024120000[-3:BRT]', name: 'PIX New', memo: 'QAZ-FIX new line' }));
  const f3 = path.join(DL, 'QAZ-FIX-extrato-old.ofx'); fs.writeFileSync(f3, oldOfx, 'latin1');
  await U.go(page, '/bank', 'Extratos bancários');
  await page.locator('input[type=file]').setInputFiles(f3);
  await page.getByText(/Arquivo:/).waitFor();
  await page.waitForTimeout(600);
  eq('legacy row (orig_* NULL): exactly 1 "Já importado" (the old line), the new one is not flagged', await page.getByText('Já importado', { exact: true }).count(), 1);
  ok('"Importar selecionados (1)" (new line only)', await page.getByRole('button', { name: 'Importar selecionados (1)' }).isVisible());
  await L.shot(page, 'fix5_extrato_linha_legada');
});

await S.flow('Painel e telas principais (fumaca)', async () => {
  for (const [p, h] of [['/', 'Painel'], ['/payments', 'Fluxo de Caixa'], ['/contracts', 'Contratos'], ['/customers', 'Clientes'], ['/services', 'Serviços'], ['/templates', 'Modelos'], ['/bank', 'Extratos bancários'], ['/reports', 'Relatórios'], ['/settings', 'Aparência']]) {
    await U.go(page, p, h);
    const bd = await U.badDates(page);
    ok(`${p}: renders, no iso/US dates on screen`, bd.length === 0, bd.join(','));
    await L.shot(page, 'fix_smoke_' + (h.replace(/\W+/g, '_')));
  }
});

L.saveResults('r10.json'); L.saveEvents('e10.json');
await S.browser.close();
