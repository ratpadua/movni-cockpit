// UI checks for "multiple credits per contract / fatura" (shared CreditPicker): contract create + edit, fatura new + edit,
// validation messages, summary, disabled after a receipt, customer switching, displays and small viewports.
// Run after s1_seed (see run-all.mjs). Data is QAZ-prefixed and removed by s9_cleanup.
import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start } from './harness.mjs';
const { api, ok, eq } = L;
const S = await start();
const { page } = S;
const sp = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const must = (r, what) => { if (r.status >= 300) throw new Error(`setup ${what}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const q = async (text, params) => { const c = await L.sqlConnect(); try { return await c.query(text, params); } finally { await c.end(); } };
const today = L.localToday();
const num = (s) => Number(String(s).replace(/[^\d,-]/g, '').replace(',', '.')); // 'R$ 1.234,5' -> 1234.5 (the amount field shows no forced decimals)

// ---------- setup ----------
const cu = must(await api('POST', '/api/customers', { name: 'QAZ-P11 Cliente' }), 'customer');
const cuOther = must(await api('POST', '/api/customers', { name: 'QAZ-P11 Outro' }), 'other customer');
const svc = must(await api('POST', '/api/services', { name: 'QAZ-P11 Servico', basePrice: '1000' }), 'service');
const sv = svc.currentVersion.id;
const mkCr = async (cid, v, d) => must(await api('POST', `/api/customers/${cid}/credits`, { description: d, value: String(v) }), 'credit ' + d);
const P1 = await mkCr(cu.id, 100, 'QAZ-P11 credito A'), P2 = await mkCr(cu.id, 250, 'QAZ-P11 credito B'), P3 = await mkCr(cu.id, 60, 'QAZ-P11 credito C');
const rem = async (id) => Number((await api('GET', `/api/customers/${cu.id}/credits?all=1`)).body.find((c) => c.id === id).remaining);
const box = (d, n) => d.getByRole('checkbox', { name: new RegExp('QAZ-P11 credito ' + n) });
const amt = (d, n) => d.getByLabel(new RegExp('Valor a usar do crédito QAZ-P11 credito ' + n));
const setAmt = async (loc, txt) => { await loc.click(); await loc.press('Control+a'); if (txt === '') await loc.press('Backspace'); else await loc.pressSequentially(txt, { delay: 20 }); await loc.press('Tab'); };
const salvar = (d) => d.getByRole('button', { name: 'Salvar', exact: true });
const fillBase = async (d) => {
  await U.pickOption(page, d, 'Cliente', 'QAZ-P11 Cliente');
  await U.pickOption(page, d, 'Serviço (título do contrato)', 'QAZ-P11 Servico');
  await d.getByText(/Preço base: R\$\s?1\.000,00/).waitFor();
  await U.pickOption(page, d, 'Modelo do documento', 'QAZ Modelo Contrato');
  await U.pickOption(page, d, 'Modelo do recibo', 'QAZ Modelo Recibo');
};
let CT; // the contract created through the UI

// =====================================================================
await S.flow('CreditPicker: novo contrato (marcar, valores padrao, validacoes, resumo)', async () => {
  await U.go(page, '/contracts', 'Contratos');
  await page.getByRole('button', { name: 'Novo contrato' }).click();
  const d = U.dlg(page);
  await fillBase(d);
  await box(d, 'A').waitFor();
  const names = await d.getByRole('checkbox').evaluateAll((els) => els.map((e) => (e.closest('div')?.parentElement?.innerText || '').split('\n')[0]).filter((t) => /QAZ-P11 credito/.test(t)));
  eq('picker lists the 3 credits, oldest first (A, B, C)', JSON.stringify(names.map((n) => n.trim().slice(-1))), JSON.stringify(['A', 'B', 'C']));
  ok('each credit shows its "Disponível R$" balance (100 / 250 / 60)', (await d.getByText(/Disponível R\$\s?100,00/).count()) > 0 && (await d.getByText(/Disponível R\$\s?250,00/).count()) > 0 && (await d.getByText(/Disponível R\$\s?60,00/).count()) > 0);
  eq('no amount fields before ticking', await d.getByLabel(/Valor a usar do crédito/).count(), 0);
  await box(d, 'A').check();
  eq('tick A: default amount = its whole balance (R$ 100,00)', num(await amt(d, 'A').inputValue()), 100);
  await d.getByText(/Total de créditos: -R\$\s?100,00 · A parcelar: R\$\s?900,00/).waitFor();
  ok('summary "Total de créditos: -R$ 100,00 · A parcelar: R$ 900,00"', true);
  await box(d, 'B').check();
  eq('tick B: default amount = whole balance (R$ 250,00)', num(await amt(d, 'B').inputValue()), 250);
  await d.getByText(/Total de créditos: -R\$\s?350,00 · A parcelar: R\$\s?650,00/).waitFor();
  ok('summary after A+B: -R$ 350,00 / A parcelar R$ 650,00', true);
  await box(d, 'A').uncheck();
  await d.getByText(/Total de créditos: -R\$\s?250,00 · A parcelar: R\$\s?750,00/).waitFor();
  eq('untick A removes its amount field', await amt(d, 'A').count(), 0);
  // per-row validation
  await setAmt(amt(d, 'B'), '0');
  ok('amount 0 -> "Informe um valor maior que zero." and Salvar disabled', (await d.getByText('Informe um valor maior que zero.').isVisible()) && (await salvar(d).isDisabled()));
  await setAmt(amt(d, 'B'), '251');
  ok('amount above the balance -> "Máximo disponível: R$ 250,00." and Salvar disabled', (await d.getByText('Máximo disponível: R$ 250,00.').isVisible()) && (await salvar(d).isDisabled()));
  await L.shot(page, 'credits_picker_erro_linha');
  await setAmt(amt(d, 'B'), '');
  ok('empty amount -> row error and Salvar disabled', (await d.getByText('Informe um valor maior que zero.').isVisible()) && (await salvar(d).isDisabled()));
  await setAmt(amt(d, 'B'), '250,00');
  ok('valid again: no row error, Salvar enabled', !(await d.getByText(/Máximo disponível|Informe um valor maior/).first().isVisible().catch(() => false)) && (await salvar(d).isEnabled()));
  // sum above the total: reduce the contract with a negative modifier (1000 - 900 = 100 to cover)
  await d.getByRole('button', { name: 'Adicionar' }).first().click();
  await d.getByPlaceholder('Descrição').last().fill('QAZ-P11 desconto');
  const mv = d.locator('input[placeholder="Valor"]').first();
  await mv.click(); await mv.press('Control+a'); await mv.pressSequentially('-900,00'); await mv.press('Tab');
  await page.waitForTimeout(300);
  const overall = await d.getByText(/O total dos créditos \(R\$\s?250,00\) excede o valor a ser coberto \(R\$\s?100,00\)\./).isVisible().catch(() => false);
  ok('credits above the total -> "O total dos créditos (R$ 250,00) excede o valor a ser coberto (R$ 100,00)." and Salvar disabled', overall && (await salvar(d).isDisabled()), sp(await d.innerText()).slice(-300));
  await L.shot(page, 'credits_picker_erro_total');
  await setAmt(amt(d, 'B'), '100');
  ok('amount reduced to the total: error gone, Salvar enabled', !(await d.getByText(/excede o valor a ser coberto/).isVisible().catch(() => false)) && (await salvar(d).isEnabled()));
  // remove the modifier again and create the real contract with 3 credits
  await d.getByRole('button').filter({ has: page.locator('svg.tabler-icon-trash') }).first().click().catch(() => {});
  await U.closeModal(page);
  await page.getByRole('button', { name: 'Novo contrato' }).click();
  const e = U.dlg(page);
  await fillBase(e);
  await box(e, 'A').check(); await box(e, 'B').check(); await box(e, 'C').check();
  await setAmt(amt(e, 'A'), '60'); await setAmt(amt(e, 'C'), '40');
  await e.getByText(/Total de créditos: -R\$\s?350,00 · A parcelar: R\$\s?650,00/).waitFor();
  await U.pickOption(page, e, /Parcelas \(máx/, /^3 \(/);
  await L.shot(page, 'credits_picker_contrato_novo');
  await salvar(e).click();
  ok('toast "Contrato salvo"', await U.toast(page, /Contrato salvo/));
  await page.waitForTimeout(900);
  CT = (await api('GET', '/api/contracts')).body.filter((c) => c.customerId === cu.id).sort((a, b) => b.id - a.id)[0];
  const full = (await api('GET', `/api/contracts/${CT.id}`)).body;
  ok('API: creditApplied 350 and 3 credits with the typed amounts (60 / 250 / 40)', Number(full.creditApplied) === 350 && JSON.stringify(full.credits.map((c) => Number(c.amount)).sort((a, b) => a - b)) === JSON.stringify([40, 60, 250]), JSON.stringify(full.credits));
  const sum = (await q('select coalesce(sum(amount),0) s from payments where contract_id = ? and installment_number is not null', [CT.id]))[0][0].s;
  ok('API: 3 installments sum to the net total 650', Math.abs(Number(sum) - 650) < 0.011, String(sum));
  eq('balances A 40, B 0, C 20', JSON.stringify([await rem(P1.id), await rem(P2.id), await rem(P3.id)]), JSON.stringify([40, 0, 20]));
});

await S.flow('Contrato: exibicao dos creditos, edicao e troca de cliente', async () => {
  await U.go(page, `/contracts/${CT.id}`, undefined);
  await page.getByText('Itens do contrato').waitFor();
  const t = sp(await U.bodyText(page));
  ok('contract page header lists the applied credits ("Créditos aplicados (-R$ 350,00): ... — R$ ...")', /Créditos aplicados \(-R\$\s?350,00\)/.test(t) && /QAZ-P11 credito A — R\$\s?60,00/.test(t) && /QAZ-P11 credito B — R\$\s?250,00/.test(t) && /QAZ-P11 credito C — R\$\s?40,00/.test(t), t.slice(0, 600));
  await L.shot(page, 'credits_contrato_exibicao');
  // edit: the picker is pre-filled; replace the credits
  await U.go(page, '/contracts', 'Contratos');
  await U.row(page, CT.number).getByTitle('Editar').click();
  const d = U.dlg(page);
  await d.getByText(/Editar contrato #/).first().waitFor();
  await box(d, 'A').waitFor();
  ok('edit form: the 3 credits are ticked with the applied amounts (60 / 250 / 40)', (await box(d, 'A').isChecked()) && (await box(d, 'B').isChecked()) && (await box(d, 'C').isChecked()) && num(await amt(d, 'A').inputValue()) === 60 && num(await amt(d, 'B').inputValue()) === 250 && num(await amt(d, 'C').inputValue()) === 40);
  ok('edit form: "Disponível" includes what the contract itself uses (A: 40 + 60 = R$ 100,00, B: R$ 250,00)', (await d.getByText(/Disponível R\$\s?100,00/).count()) > 0 && (await d.getByText(/Disponível R\$\s?250,00/).count()) > 0);
  // switch customer away and back
  await U.pickOption(page, d, 'Cliente', 'QAZ-P11 Outro');
  await page.waitForTimeout(500);
  eq('switching to a customer without credits: the picker is gone', await d.getByRole('checkbox', { name: /QAZ-P11 credito/ }).count(), 0);
  await U.pickOption(page, d, 'Cliente', 'QAZ-P11 Cliente');
  await box(d, 'B').waitFor();
  ok('switching back: the customer\'s credits are listed again, nothing ticked, "Disponível" back to the right values', (await box(d, 'B').isChecked()) === false && (await d.getByText(/Disponível R\$\s?250,00/).count()) > 0 && (await d.getByText(/Disponível R\$\s?100,00/).count()) > 0, sp(await d.innerText()).slice(0, 400));
  await box(d, 'A').check(); await setAmt(amt(d, 'A'), '100');
  await box(d, 'C').check(); await setAmt(amt(d, 'C'), '20');
  await L.shot(page, 'credits_picker_edicao');
  await salvar(d).click();
  ok('toast "Contrato salvo" (edit with new credits)', await U.toast(page, /Contrato salvo/));
  await page.waitForTimeout(900);
  const full = (await api('GET', `/api/contracts/${CT.id}`)).body;
  ok('API: credits replaced (A 100 + C 20 = 120), B reinstated', Number(full.creditApplied) === 120 && full.credits.length === 2, JSON.stringify(full.credits));
  eq('balances A 0, B 250, C 40', JSON.stringify([await rem(P1.id), await rem(P2.id), await rem(P3.id)]), JSON.stringify([0, 250, 40]));
  const sum = (await q('select coalesce(sum(amount),0) s from payments where contract_id = ? and installment_number is not null', [CT.id]))[0][0].s;
  ok('API: installments re-split on 1000 - 120 = 880', Math.abs(Number(sum) - 880) < 0.011, String(sum));
  // after a received payment: the picker is disabled, header-only save still works
  const inst = (await q('select id from payments where contract_id = ? and installment_number = 1', [CT.id]))[0][0].id;
  must(await api('PUT', `/api/payments/${inst}`, { receiptStatus: 'received', receivedDate: today }), 'receive');
  await page.reload(); await page.waitForLoadState('networkidle');
  await U.row(page, CT.number).getByTitle('Editar').click();
  const e = U.dlg(page);
  await e.getByText(/Editar contrato #/).first().waitFor();
  await box(e, 'A').waitFor();
  ok('after a received payment: the credit checkboxes and amounts are disabled + yellow notice', (await box(e, 'A').isDisabled()) && (await box(e, 'B').isDisabled()) && (await amt(e, 'A').isDisabled()) && (await e.getByText(/Já há pagamento\(s\) recebido\(s\) neste contrato/).isVisible()));
  await L.shot(page, 'credits_picker_desabilitado');
  await e.getByLabel('Comentários').fill('QAZ-P11 so cabecalho');
  await salvar(e).click();
  ok('header-only save still works', await U.toast(page, /Contrato salvo/));
  await page.waitForTimeout(800);
  const f2 = (await api('GET', `/api/contracts/${CT.id}`)).body;
  ok('API: credits untouched by the header-only save', Number(f2.creditApplied) === 120 && f2.credits.length === 2 && f2.comments === 'QAZ-P11 so cabecalho', JSON.stringify(f2.credits));
  await q('update payments set receipt_status = ?, received_date = null where id = ?', ['open', inst]);
});

await S.flow('Faturas: CreditPicker na nova fatura e na edicao, exibicao nas linhas', async () => {
  const R = must(await api('POST', '/api/contracts', { customerId: cu.id, type: 'invoice', title: 'QAZ-P11 Recorrente', invoiceTemplateId: st.tI.id, receiptTemplateId: st.tR.id }), 'recurring');
  must(await api('POST', `/api/contracts/${R.id}/items`, { serviceVersionId: sv, items: [{ description: 'QAZ-P11 item 1' }, { description: 'QAZ-P11 item 2' }], performedAt: today }), 'items');
  await U.go(page, `/contracts/${R.id}`, undefined);
  await page.getByText('Faturas').first().waitFor();
  await page.getByRole('button', { name: 'Nova fatura' }).click();
  let d = U.dlg(page);
  await d.getByText('Nova fatura').first().waitFor();
  await d.getByText(/QAZ-P11 item 1/).first().click();
  await d.getByLabel('Referência').fill('QAZ-P11 fatura');
  // credits now left: A 0 (used by the contract), B 250, C 40 (C used 20 of 60 by the contract)
  ok('new fatura: only credits with balance are listed (B and C; A is fully used)', (await box(d, 'B').count()) === 1 && (await box(d, 'C').count()) === 1 && (await box(d, 'A').count()) === 0);
  await box(d, 'B').check(); await box(d, 'C').check();
  ok('default amounts: B 250, C 40 (R$ 290,00 in total)', num(await amt(d, 'B').inputValue()) === 250 && num(await amt(d, 'C').inputValue()) === 40);
  await d.getByText(/Total de créditos: -R\$\s?290,00 · A parcelar: R\$\s?710,00/).waitFor();
  ok('summary "Total de créditos: -R$ 290,00 · A parcelar: R$ 710,00"', true);
  await setAmt(amt(d, 'C'), '41');
  ok('amount above the balance -> "Máximo disponível: R$ 40,00." and "Criar fatura" disabled', (await d.getByText('Máximo disponível: R$ 40,00.').isVisible()) && (await d.getByRole('button', { name: 'Criar fatura' }).isDisabled()));
  console.log('  C after 41:', JSON.stringify(await amt(d, 'C').inputValue()));
  await setAmt(amt(d, 'C'), '40');
  console.log('  C after fill 40:', JSON.stringify(await amt(d, 'C').inputValue()));
  await amt(d, 'C').press('Tab');
  console.log('  C after Tab:', JSON.stringify(await amt(d, 'C').inputValue()));
  await L.shot(page, 'credits_fatura_nova');
  await d.getByRole('button', { name: 'Criar fatura' }).click();
  ok('toast "Fatura criada"', await U.toast(page, /Fatura criada/));
  await page.waitForTimeout(900);
  const t = sp(await U.bodyText(page));
  ok('fatura row lists the credits: "crédito -R$ 290,00 (... credito B: R$ 250,00; ... credito C: R$ 40,00)"', /crédito -R\$\s?290,00/.test(t) && /QAZ-P11 credito B: R\$\s?250,00/.test(t) && /QAZ-P11 credito C: R\$\s?40,00/.test(t), t.slice(-500));
  await L.shot(page, 'credits_fatura_exibicao');
  eq('API: balances B 0, C 0', JSON.stringify([await rem(P2.id), await rem(P3.id)]), JSON.stringify([0, 0]));
  // edit the fatura: the credits fully consumed by itself stay listed and ticked
  const fat = (await api('GET', `/api/contracts/${R.id}`)).body.invoices[0];
  await page.locator('.mantine-Paper-root').filter({ hasText: fat.refNumber }).last().getByTitle('Editar fatura').click();
  d = U.dlg(page);
  await d.getByText('Editar fatura').first().waitFor();
  await box(d, 'B').waitFor();
  ok('edit fatura: B and C (fully consumed by this fatura) are listed, ticked, with the applied amounts', (await box(d, 'B').isChecked()) && (await box(d, 'C').isChecked()) && num(await amt(d, 'B').inputValue()) === 250 && num(await amt(d, 'C').inputValue()) === 40);
  await box(d, 'C').uncheck();
  await setAmt(amt(d, 'B'), '100');
  await d.getByText(/Total de créditos: -R\$\s?100,00 · A parcelar: R\$\s?900,00/).waitFor();
  ok('after unticking C and lowering B: summary -R$ 100,00 / A parcelar R$ 900,00', true);
  await d.getByRole('button', { name: 'Salvar alterações' }).click();
  ok('toast "Fatura atualizada"', await U.toast(page, /Fatura atualizada/));
  await page.waitForTimeout(900);
  eq('API: balances B 150, C 40 (reinstated), nothing above value', JSON.stringify([await rem(P2.id), await rem(P3.id)]), JSON.stringify([150, 40]));
  const fat2 = (await api('GET', `/api/contracts/${R.id}`)).body.invoices[0];
  ok('API: fatura credits = [B 100], creditApplied 100', Number(fat2.creditApplied) === 100 && fat2.credits.length === 1 && Number(fat2.credits[0].amount) === 100, JSON.stringify(fat2.credits));
  // delete the fatura: reinstated
  S.dialogs.length = 0;
  await page.locator('.mantine-Paper-root').filter({ hasText: fat.refNumber }).last().getByTitle('Excluir fatura').click();
  await page.waitForTimeout(1200);
  eq('deleting the fatura reinstates B to its full 250', await rem(P2.id), 250);
});

// =====================================================================
for (const vp of [{ width: 375, height: 812 }, { width: 768, height: 1024 }]) {
  const S2 = await start(vp);
  const pg = S2.page;
  await S2.flow(`CreditPicker aberto em ${vp.width}x${vp.height}: sem rolagem horizontal e sem erros`, async () => {
    await pg.goto(L.BASE + '/contracts'); await pg.waitForLoadState('networkidle');
    await pg.getByRole('button', { name: 'Novo contrato' }).click();
    const dm = pg.locator('.mantine-Modal-content').last();
    await U.pickOption(pg, dm, 'Cliente', 'QAZ-P11 Cliente');
    await U.pickOption(pg, dm, 'Serviço (título do contrato)', 'QAZ-P11 Servico');
    await dm.getByText(/Preço base/).waitFor();
    await dm.getByRole('checkbox', { name: /QAZ-P11 credito B/ }).waitFor();
    await dm.getByRole('checkbox', { name: /QAZ-P11 credito B/ }).check();
    await pg.waitForTimeout(400);
    const m = await pg.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    ok(`${vp.width}px: no page-level horizontal scroll with the picker open`, m.sw <= m.cw + 1, JSON.stringify(m));
    const bb = await dm.boundingBox();
    ok(`${vp.width}px: the modal fits the viewport width`, bb && bb.x >= -1 && bb.x + bb.width <= vp.width + 1, JSON.stringify(bb));
    const af = await dm.getByLabel(/Valor a usar do crédito QAZ-P11 credito B/).boundingBox();
    ok(`${vp.width}px: the amount field is inside the viewport`, af && af.x >= 0 && af.x + af.width <= vp.width + 1, JSON.stringify(af));
    await L.shot(pg, `credits_picker_${vp.width}`);
    await U.closeModal(pg);
  });
  await S2.browser.close();
}

L.saveResults('r11.json'); L.saveEvents('e11.json');
await S.browser.close();
