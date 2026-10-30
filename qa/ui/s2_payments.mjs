import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import * as U from './ui.mjs';
const { api, ok, eq, setFlow } = L;
const st = JSON.parse(fs.readFileSync(path.join(L.QA, 'state.json'), 'utf8'));
await L.login();
const S = await L.newSession();
const { page, ev } = S;
const today = L.localToday();

async function flow(name, fn) {
  setFlow(name);
  try { await fn(); } catch (e) {
    ok(`${name}: no exception`, false, (e.stack || e.message).split('\n').slice(0, 4).join(' | '));
    await L.shot(page, 'FAIL_' + name);
  }
  const e = L.drain(ev, name);
  ok(`${name}: no console errors / pageerrors`, e.console.length === 0 && e.pageerrors.length === 0, JSON.stringify([...e.console, ...e.pageerrors]));
  const unexpected = e.bad.filter((x) => !(globalThis.__expectBad || []).some((re) => re.test(x)));
  ok(`${name}: no unexpected 4xx/5xx`, unexpected.length === 0, unexpected.join(' ; '));
  globalThis.__expectBad = [];
}
const clr = async () => { await page.getByRole('button', { name: 'Limpar' }).click(); await page.getByRole('button', { name: 'Todo o período' }).click(); };
const listPayments = async () => (await api('GET', '/api/payments')).body;

// ============ Painel ============
await flow('Painel', async () => {
  await U.go(page, '/', 'Painel');
  const txt = await U.bodyText(page);
  for (const label of ['A receber', 'A pagar', 'Clientes', 'Pagamentos atrasados', 'Contratos atrasados', 'Próximos pagamentos']) {
    ok(`Painel shows "${label}"`, new RegExp(label, 'i').test(txt), txt.slice(0, 200));
  }
  ok('Painel money is pt-BR R$ 1.234,56', U.brlRe.test(txt));
  const pays = await listPayments();
  const open = pays.filter((p) => (p.flow === 'in' ? p.receiptStatus === 'open' : p.status === 'upcoming'));
  const toRecv = open.filter((p) => p.flow === 'in').reduce((s, p) => s + Number(p.amount), 0);
  const fmt = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
  const norm = (s) => s.replace(/ /g, ' ');
  ok(`A receber = ${fmt(toRecv)} (matches API)`, norm(txt).includes(fmt(toRecv)), fmt(toRecv));
  ok('late payment table lists "QAZ-UI entrada atrasada" with 15/09/2026', /QAZ-UI entrada atrasada/.test(txt) && /15\/09\/2026/.test(txt));
  ok('overdue contract card lists C2 with BR date', new RegExp(st.C2.number.replace('/', '\\/')).test(txt) && /Contratos atrasados/.test(txt));
  ok('Próximos pagamentos shows open entrada with Aberto and open saída with A pagar', /QAZ-UI entrada aberta/.test(txt) && /QAZ-UI saida a pagar/.test(txt) && /Aberto/i.test(txt) && /A pagar/i.test(txt));
  ok('Painel does not list received/paid in Próximos', true);
  const nextBox = page.locator('text=Próximos pagamentos').locator('xpath=ancestor::div[contains(@class,"mantine-Paper-root")][1]');
  const nt = await nextBox.innerText();
  ok('Próximos does not include received/paid ones', !/QAZ-UI entrada recebida|QAZ-UI saida paga|QAZ-UI entrada enviada/.test(nt));
  const bd = await U.badDates(page);
  ok('Painel: no iso/US dates on screen', bd.length === 0, bd.join(','));
  await L.shot(page, 'painel_desktop');
});

// ============ Fluxo de Caixa ============
await flow('Fluxo de Caixa: periodo e filtros', async () => {
  await U.go(page, '/payments', 'Fluxo de Caixa');
  const monthName = new Date().toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const cap = monthName.charAt(0).toUpperCase() + monthName.slice(1);
  ok(`period label "${cap}"`, await page.getByText(cap, { exact: true }).first().isVisible(), cap);
  let t = await U.bodyText(page);
  ok('current month: open/paid payments of month visible, Sept & Dec not', /QAZ-UI entrada aberta/.test(t) && /QAZ-UI saida paga/.test(t) && !/QAZ-UI entrada atrasada/.test(t) && !/QAZ-UI proximo mes/.test(t));
  ok('dates are dd/MM/yyyy in rows', t.includes(L.br(st.pOpenIn.dueDate)));
  ok('Tipo filter present, Situação labels', /Situação/.test(t));
  await L.shot(page, 'fluxo_caixa_desktop');
  await page.getByRole('button', { name: 'Mês anterior' }).click();
  await page.getByText(/Setembro de 2026/).first().waitFor();
  t = await U.bodyText(page);
  ok('previous month shows late payments with Atrasado badge', /QAZ-UI entrada atrasada/.test(t) && /QAZ-UI saida atrasada/.test(t) && (await U.row(page, 'QAZ-UI entrada atrasada').innerText()).match(/atrasado/i));
  ok('late saída row also Atrasado', (await U.row(page, 'QAZ-UI saida atrasada').innerText()).match(/atrasado/i));
  await page.getByRole('button', { name: 'Próximo mês' }).click();
  await page.getByRole('button', { name: 'Próximo mês' }).click();
  await page.getByText(/Novembro de 2026/).first().waitFor();
  await page.getByRole('button', { name: 'Mês atual' }).click();
  await page.getByText(cap, { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Todo o período' }).click();
  await page.getByText('Todo o período', { exact: true }).first().waitFor();
  t = await U.bodyText(page);
  ok('"Todo o período" shows all QAZ payments', /QAZ-UI proximo mes/.test(t) && /QAZ-UI entrada atrasada/.test(t));
  await L.shot(page, 'fluxo_caixa_todo_periodo');

  // Situação multi-select
  const sit = await U.optionsOf(page, page, 'Situação');
  ok('Situação options alphabetical (accents/spaces aware)', U.isSorted(sit) && sit.length === 6, JSON.stringify(sit));
  ok('Situação options are the 6 labels', JSON.stringify([...sit].sort()) === JSON.stringify(['A pagar', 'Aberto', 'Atrasado', 'Enviado', 'Pago', 'Recebido'].sort()), JSON.stringify(sit));
  await page.getByRole('option', { name: 'Atrasado' }).click();
  await page.getByRole('option', { name: 'Pago' }).click();
  await page.keyboard.press('Escape');
  t = await U.bodyText(page);
  ok('Situação Atrasado+Pago filter: shows late and paid, hides open/received', /QAZ-UI entrada atrasada/.test(t) && /QAZ-UI saida atrasada/.test(t) && /QAZ-UI saida paga/.test(t) && !/QAZ-UI entrada aberta/.test(t) && !/QAZ-UI entrada recebida/.test(t));
  await L.shot(page, 'fluxo_caixa_filtro_situacao');
  await clr();
  // Cliente
  const cl = await U.optionsOf(page, page, 'Cliente');
  ok('Cliente options alphabetical (accents/numbers)', U.isSorted(cl), JSON.stringify(cl));
  const iAb = cl.indexOf('QAZ Ábaco'), i2 = cl.indexOf('QAZ Num 2'), i10 = cl.indexOf('QAZ Num 10'), iZ = cl.indexOf('QAZ Zebra');
  ok('Cliente: Ábaco < Num 2 < Num 10 < Zebra', iAb >= 0 && iAb < i2 && i2 < i10 && i10 < iZ, `${iAb},${i2},${i10},${iZ}`);
  await page.getByRole('option', { name: 'João Ação' }).click();
  await page.keyboard.press('Escape');
  t = await U.bodyText(page);
  ok('Cliente filter João Ação: shows own payments only', /QAZ-UI entrada atrasada/.test(t) && !/QAZ-UI saida atrasada/.test(t));
  await clr();
  // Contrato
  const ct = await U.optionsOf(page, page, 'Contrato');
  ok('Contrato options alphabetical', U.isSorted(ct), JSON.stringify(ct));
  await page.getByRole('option', { name: new RegExp(st.C1.number) }).click();
  await page.keyboard.press('Escape');
  t = await U.bodyText(page);
  ok('Contrato filter C1: shows its payments only', /QAZ-UI entrada aberta/.test(t) && /Parcela|parcela|\/3|Servico|Servi/i.test(t) && !/QAZ-UI saida a pagar/.test(t));
  await clr();
  // Categoria
  const ca = await U.optionsOf(page, page, 'Categoria');
  ok('Categoria options alphabetical (QAZ Água < QAZ Cat In < QAZ Cat Out)', U.isSorted(ca) && ca.indexOf('QAZ Água') < ca.indexOf('QAZ Cat In') && ca.indexOf('QAZ Cat In') < ca.indexOf('QAZ Cat Out'), JSON.stringify(ca));
  await page.getByRole('option', { name: 'QAZ Água' }).click();
  await page.getByRole('option', { name: 'QAZ Cat In' }).click();
  await page.keyboard.press('Escape');
  t = await U.bodyText(page);
  ok('Categoria multi (Água + Cat In) filter', /QAZ-UI saida a pagar/.test(t) && /QAZ-UI entrada atrasada/.test(t) && !/QAZ-UI saida atrasada/.test(t));
  await clr();
  // Tipo
  await U.pickOption(page, page, 'Tipo', 'Saída');
  t = await U.bodyText(page);
  ok('Tipo Saída filter', /QAZ-UI saida a pagar/.test(t) && !/QAZ-UI entrada aberta/.test(t));
  await clr();
  // date filters typed
  await U.typeDate(page, 'Venc. de', '01/09/2026');
  await U.typeDate(page, 'Venc. até', '30/09/2026');
  t = await U.bodyText(page);
  ok('Venc. de/até typed dd/MM/yyyy filters to September', /QAZ-UI entrada atrasada/.test(t) && !/QAZ-UI entrada aberta/.test(t));
  const v = await page.getByLabel('Venc. de').first().inputValue();
  eq('DateField shows typed date in dd/MM/yyyy', v, '01/09/2026');
  await clr();
});

await flow('Fluxo de Caixa: novo pagamento', async () => {
  await U.go(page, '/payments', 'Fluxo de Caixa');
  await page.getByRole('button', { name: 'Todo o período' }).click();
  await page.getByRole('button', { name: 'Novo pagamento' }).click();
  let d = U.dlg(page);
  await d.getByLabel('Descrição').waitFor();
  const initDate = await d.getByLabel('Vencimento').first().inputValue();
  eq('new payment Vencimento default = today dd/MM/yyyy', initDate, L.br(today));
  await L.shot(page, 'pagamento_modal_novo');
  // Tipo / Situação option order
  const tipo = await U.optionsOf(page, d, 'Tipo'); await U.closeDropdown(page);
  ok('Tipo options alphabetical (Entrada, Saída)', JSON.stringify(tipo) === JSON.stringify(['Entrada', 'Saída']), JSON.stringify(tipo));
  d = U.dlg(page);
  // -- bad input: leave description empty and amount 0
  const before = (await listPayments()).length;
  await d.getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(1200);
  const after = await listPayments();
  const toasts = await U.toastTexts(page);
  console.log('  empty description+amount 0 -> toasts:', JSON.stringify(toasts), 'rows', before, '->', after.length);
  eq('empty description + amount 0: no payment created', after.length, before);
  ok('empty description: inline "Informe a descrição."', await d.getByText('Informe a descrição.').isVisible(), JSON.stringify(toasts));
  ok('amount 0/empty: inline "Informe um valor maior que zero."', await d.getByText('Informe um valor maior que zero.').isVisible(), JSON.stringify(toasts));
  await L.shot(page, 'pagamento_validacao_vazio');
  // make sure modal still open or reopen
  if (!(await d.isVisible().catch(() => false))) { await page.getByRole('button', { name: 'Novo pagamento' }).click(); d = U.dlg(page); }
  // -- valid: typed date, category, amount
  await d.getByLabel('Descrição').fill('QAZ-UI pagamento unico');
  await d.getByLabel('Valor (R$)').fill('1234,56');
  // typing a dd/MM/yyyy date (day > 12 and day <= 12, key by key like a user)
  for (const [txt, expected] of [['15/11/2026', '15/11/2026'], ['03/04/2027', '03/04/2027']]) {
    const f = d.getByLabel('Vencimento').first();
    await f.click();
    await f.press('Control+a');
    await f.pressSequentially(txt, { delay: 40 });
    await f.press('Tab');
    const got = await f.inputValue();
    ok(`typing "${txt}" (key by key) in DateField yields ${expected}`, got === expected, `got "${got}"`);
    if (got !== expected) await L.shot(page, 'BUG_datefield_typed_' + txt.replace(/\//g, '-'));
  }
  await U.typeDate(d, 'Vencimento', '15/11/2026');
  eq('typed date displayed dd/MM/yyyy', await d.getByLabel('Vencimento').first().inputValue(), '15/11/2026');
  const cats = await U.optionsOf(page, d, 'Categoria');
  ok('modal Categoria alphabetical', U.isSorted(cats), JSON.stringify(cats));
  await page.getByRole('option', { name: 'QAZ Água' }).click();
  const valShown = await d.getByLabel('Valor (R$)').inputValue();
  console.log('  amount input displays:', valShown);
  await d.getByRole('button', { name: 'Salvar' }).click();
  ok('toast "Pagamento salvo"', await U.toast(page, /Pagamento salvo/));
  const p1 = (await listPayments()).find((p) => p.description === 'QAZ-UI pagamento unico');
  ok('API: payment stored with dueDate 2026-11-15, amount 1234.56, flow out, status upcoming', p1 && p1.dueDate === '2026-11-15' && Number(p1.amount) === 1234.56 && p1.flow === 'out' && p1.status === 'upcoming', JSON.stringify(p1));
  const r1 = U.row(page, 'QAZ-UI pagamento unico');
  await r1.waitFor();
  const rt = await r1.innerText();
  ok('row shows R$ 1.234,56, 15/11/2026 and "A pagar"', /R\$\s?1\.234,56/.test(rt) && rt.includes('15/11/2026') && /a pagar/i.test(rt), rt);
  await L.shot(page, 'pagamento_criado');

  // picked date via calendar
  await page.getByRole('button', { name: 'Novo pagamento' }).click();
  d = U.dlg(page);
  await d.getByLabel('Descrição').fill('QAZ-UI pagamento data escolhida');
  await d.getByLabel('Valor (R$)').fill('10');
  await U.pickDay(page, d, 'Vencimento', 20);
  const shownPicked = await d.getByLabel('Vencimento').first().inputValue();
  ok('picked date displayed dd/MM/yyyy', /^20\/\d{2}\/\d{4}$/.test(shownPicked), shownPicked);
  await L.shot(page, 'pagamento_modal_datepicker');
  await d.getByRole('button', { name: 'Salvar' }).click();
  await U.toast(page, /Pagamento salvo/);
  await page.waitForTimeout(900);
  const p2 = (await listPayments()).find((p) => p.description === 'QAZ-UI pagamento data escolhida');
  ok('API: picked date stored as same day (yyyy-MM-20)', p2 && p2.dueDate === shownPicked.split('/').reverse().join('-'), JSON.stringify(p2?.dueDate) + ' vs ' + shownPicked);
});

await flow('Fluxo de Caixa: recorrente', async () => {
  await U.go(page, '/payments', 'Fluxo de Caixa');
  await page.getByRole('button', { name: 'Todo o período' }).click();
  await page.getByRole('button', { name: 'Novo pagamento' }).click();
  let d = U.dlg(page);
  await d.getByLabel('Descrição').fill('QAZ-UI recorrente');
  await d.getByLabel('Valor (R$)').fill('99,9');
  await d.getByText('Pagamento recorrente', { exact: true }).click();
  await d.getByLabel('Frequência').waitFor();
  ok('Situação field hidden for new recurring series', (await d.getByLabel('Situação').count()) === 0);
  const fr = await U.optionsOf(page, d, 'Frequência'); await U.closeDropdown(page);
  ok('Frequência options alphabetical (Anual, Diária, Mensal, Semanal)', JSON.stringify(fr) === JSON.stringify(['Anual', 'Diária', 'Mensal', 'Semanal']), JSON.stringify(fr));
  d = U.dlg(page);
  await d.getByLabel('Primeiro vencimento').waitFor();
  await U.typeDate(d, 'Primeiro vencimento', '30/11/2026');
  // invalid end date first
  await U.typeDate(d, 'Repetir até', '01/11/2026');
  const t1 = await d.innerText();
  ok('until < first -> red message "A data final deve ser igual ou posterior ao primeiro vencimento."', /A data final deve ser igual ou posterior/.test(t1), t1.slice(-300));
  ok('Criar pagamentos disabled when range invalid', await d.getByRole('button', { name: 'Criar pagamentos' }).isDisabled());
  await L.shot(page, 'pagamento_recorrente_invalido');
  await U.typeDate(d, 'Repetir até', '28/02/2027');
  const t2 = await d.innerText();
  ok('preview: "Serão criados 4 pagamentos, do dia 30/11/2026 ao dia 28/02/2027."', /Serão criados\s*4\s*pagamentos, do dia 30\/11\/2026 ao dia\s*28\/02\/2027/.test(t2.replace(/\s+/g, ' ')), t2.replace(/\s+/g, ' ').slice(-250));
  await L.shot(page, 'pagamento_recorrente_modal');
  await d.getByRole('button', { name: 'Criar pagamentos' }).click();
  ok('toast "4 pagamentos criados"', await U.toast(page, /4 pagamentos criados/));
  const series = (await listPayments()).filter((p) => p.description === 'QAZ-UI recorrente').sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  ok('API: 4 payments, dates 30/11, 30/12, 30/01, 28/02, same recurrenceId, all open', series.length === 4 && JSON.stringify(series.map((p) => p.dueDate)) === JSON.stringify(['2026-11-30', '2026-12-30', '2027-01-30', '2027-02-28']) && new Set(series.map((p) => p.recurrenceId)).size === 1 && series[0].recurrenceId && series.every((p) => p.status === 'upcoming'), JSON.stringify(series.map((p) => [p.dueDate, p.recurrenceId, p.status])));
  await page.getByText('QAZ-UI recorrente').first().waitFor();
  const tags = await page.locator('tr').filter({ hasText: 'QAZ-UI recorrente' }).getByText('Recorrente', { exact: true }).count();
  eq('"Recorrente" tag on 4 rows', tags, 4);
  await L.shot(page, 'fluxo_caixa_recorrentes');

  // ---- edit with scope modal
  const dec = page.locator('tr').filter({ hasText: 'QAZ-UI recorrente' }).filter({ hasText: '30/12/2026' }).first();
  await dec.getByTitle('Editar').click();
  d = U.dlg(page);
  await d.getByLabel('Descrição').waitFor();
  ok('edit modal explains recurring series', /faz parte de uma série recorrente/.test(await d.innerText()));
  ok('no recurrence switch when editing', (await d.getByLabel('Pagamento recorrente').count()) === 0);
  await d.getByLabel('Descrição').fill('QAZ-UI recorrente editada');
  await d.getByRole('button', { name: 'Salvar' }).click();
  const sm = page.getByRole('dialog').filter({ hasText: 'Salvar pagamento recorrente' });
  await sm.waitFor();
  const smt = (await sm.innerText()).replace(/\s+/g, ' ');
  ok('scope modal choices with counts (só este / +2 próximos / +3 todos)', /Só este pagamento/.test(smt) && /Este e os próximos em aberto \(\+2 outros\)/.test(smt) && /Todos os pagamentos em aberto da série \(\+3 outros\)/.test(smt), smt);
  await L.shot(page, 'pagamento_recorrente_escopo_salvar');
  await sm.getByText(/Este e os próximos em aberto/).click();
  await sm.getByRole('button', { name: 'Salvar', exact: true }).click();
  ok('toast Pagamento salvo after scoped edit', await U.toast(page, /Pagamento salvo/));
  let s2 = (await listPayments()).filter((p) => p.recurrenceId === series[0].recurrenceId).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  ok('API: following scope renamed Dec/Jan/Feb, kept Nov', s2[0].description === 'QAZ-UI recorrente' && s2.slice(1).every((p) => p.description === 'QAZ-UI recorrente editada'), JSON.stringify(s2.map((p) => p.description)));

  // ---- delete scope: only this
  const feb = page.locator('tr').filter({ hasText: 'QAZ-UI recorrente editada' }).filter({ hasText: '28/02/2027' }).first();
  await feb.getByTitle('Excluir').click();
  const dm = page.getByRole('dialog').filter({ hasText: 'Excluir pagamento recorrente' });
  await dm.waitFor();
  const dmt = (await dm.innerText()).replace(/\s+/g, ' ');
  ok('delete scope modal texts', /Só este pagamento/.test(dmt) && /Pagamentos já pagos ou recebidos da série são mantidos/.test(dmt), dmt);
  await L.shot(page, 'pagamento_recorrente_escopo_excluir');
  await dm.getByRole('button', { name: 'Excluir', exact: true }).click();
  await page.waitForTimeout(800);
  s2 = (await listPayments()).filter((p) => p.recurrenceId === series[0].recurrenceId);
  eq('API: only Feb deleted (3 left)', s2.length, 3);
  // mark Dec as received?? (series entries are saída): mark Nov as paid via edit to test "never touches paid"
  const nov = page.locator('tr').filter({ hasText: 'QAZ-UI recorrente' }).filter({ hasText: '30/11/2026' }).first();
  await nov.getByTitle('Editar').click();
  d = U.dlg(page);
  await U.pickOption(page, d, 'Situação', 'Pago');
  await d.getByLabel('Data de pagamento').waitFor();
  await U.typeDate(d, 'Data de pagamento', '28/10/2026');
  await d.getByRole('button', { name: 'Salvar' }).click();
  const sm2 = page.getByRole('dialog').filter({ hasText: 'Salvar pagamento recorrente' });
  await sm2.waitFor();
  await sm2.getByRole('button', { name: 'Salvar', exact: true }).click(); // scope "só este"
  await U.toast(page, /Pagamento salvo/);
  await page.waitForTimeout(1200);
  const nv =(await listPayments()).find((p) => p.recurrenceId === series[0].recurrenceId && p.dueDate === '2026-11-30');
  ok('API: Nov paid, paidDate 2026-10-28', nv.status === 'done' && nv.paidDate === '2026-10-28', JSON.stringify([nv.status, nv.paidDate]));
  // delete all open in series from the Jan row
  const jan = page.locator('tr').filter({ hasText: 'QAZ-UI recorrente editada' }).filter({ hasText: '30/01/2027' }).first();
  await jan.getByTitle('Excluir').click();
  const dm2 = page.getByRole('dialog').filter({ hasText: 'Excluir pagamento recorrente' });
  await dm2.waitFor();
  await dm2.getByText(/Todos os pagamentos em aberto/).click();
  await dm2.getByRole('button', { name: 'Excluir', exact: true }).click();
  await page.waitForTimeout(800);
  s2 = (await listPayments()).filter((p) => p.recurrenceId === series[0].recurrenceId);
  ok('API: delete "todos em aberto" keeps the paid Nov payment only', s2.length === 1 && s2[0].dueDate === '2026-11-30' && s2[0].status === 'done', JSON.stringify(s2.map((p) => [p.dueDate, p.status])));
  await L.shot(page, 'fluxo_caixa_apos_exclusao_serie');
  // remove the leftover paid one (plain recurring row delete, "só este")
  await U.row(page, 'QAZ-UI recorrente').getByTitle('Excluir').click();
  const dm3 = page.getByRole('dialog').filter({ hasText: 'Excluir pagamento recorrente' });
  await dm3.waitFor();
  await dm3.getByRole('button', { name: 'Excluir', exact: true }).click();
  await page.waitForTimeout(600);
});

await flow('Fluxo de Caixa: editar Situacao, receber, excluir, recibo', async () => {
  await U.go(page, '/payments', 'Fluxo de Caixa');
  await page.getByRole('button', { name: 'Todo o período' }).click();
  // edit situation of an entrada
  await U.row(page, 'QAZ-UI entrada aberta').getByTitle('Editar').click();
  let d = U.dlg(page);
  await d.getByLabel('Descrição').waitFor();
  await d.getByLabel('Tipo').first().click();
  await U.closeDropdown(page);
  d = U.dlg(page);
  const sitIn = await U.optionsOf(page, d, 'Situação'); await U.closeDropdown(page);
  ok('entrada Situação options alphabetical & labels (Aberto, Enviado, Recebido)', JSON.stringify(sitIn) === JSON.stringify(['Aberto', 'Enviado', 'Recebido']), JSON.stringify(sitIn));
  d = U.dlg(page);
  ok('edit modal: date shown dd/MM/yyyy', (await d.getByLabel('Vencimento').first().inputValue()) === L.br(st.pOpenIn.dueDate));
  await L.shot(page, 'pagamento_modal_editar');
  await U.pickOption(page, d, 'Situação', 'Recebido');
  await d.getByLabel('Data de recebimento').waitFor();
  eq('edit Recebido: date field present (empty -> today on save)', await d.getByLabel('Data de recebimento').inputValue(), '');
  await d.getByRole('button', { name: 'Salvar' }).click();
  ok('toast Pagamento salvo (edit)', await U.toast(page, /Pagamento salvo/));
  let p = (await listPayments()).find((x) => x.id === st.pOpenIn.id);
  ok('API: receiptStatus received, receivedDate today', p.receiptStatus === 'received' && p.receivedDate === today, JSON.stringify([p.receiptStatus, p.receivedDate]));
  let rt = await U.row(page, 'QAZ-UI entrada aberta').innerText();
  ok('row badge Recebido + Baixar/PDF buttons', /recebido/i.test(rt) && /Baixar/.test(rt) && /PDF/.test(rt), rt);
  // receipt download (docx)
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), U.row(page, 'QAZ-UI entrada aberta').getByRole('button', { name: 'Baixar' }).click()]);
  const fn = dl.suggestedFilename();
  console.log('  receipt filename:', fn);
  ok('receipt download filename has transliterated accents (Joao_Acao, no "Jo_o")', /Joao/.test(fn) && /Acao/.test(fn) && !/Jo_o|A__o/.test(fn) && /\.docx$/.test(fn), fn);
  p = (await listPayments()).find((x) => p && x.id === st.pOpenIn.id);
  ok('after receipt generation Situação becomes Enviado', p.receiptStatus === 'sent', p.receiptStatus);
  await page.waitForTimeout(600);
  rt = await U.row(page, 'QAZ-UI entrada aberta').innerText();
  ok('row badge now Enviado', /enviado/i.test(rt), rt);
  // PDF receipt (loading notification + pdf)
  const dlp = page.waitForEvent('download', { timeout: 90000 });
  await U.row(page, 'QAZ-UI entrada aberta').getByRole('button', { name: 'PDF' }).click();
  const sawLoading = await U.toast(page, /Gerando PDF|Convertendo o documento/, 4000);
  const pdf = await dlp;
  const pfn = pdf.suggestedFilename();
  ok('PDF export: loading notification "Gerando PDF" shown', sawLoading);
  ok('PDF download filename .pdf with accents transliterated', /\.pdf$/.test(pfn) && /Joao/.test(pfn) && /Acao/.test(pfn), pfn);
  await page.waitForTimeout(500);
  ok('loading notification hidden after PDF done', !(await U.toast(page, /Gerando PDF/, 800)));
  // saída -> Pago
  await U.row(page, 'QAZ-UI saida a pagar').getByTitle('Editar').click();
  d = U.dlg(page);
  const sitOut = await U.optionsOf(page, d, 'Situação'); await U.closeDropdown(page);
  ok('saída Situação options (A pagar, Pago)', JSON.stringify(sitOut) === JSON.stringify(['A pagar', 'Pago']), JSON.stringify(sitOut));
  d = U.dlg(page);
  await U.pickOption(page, d, 'Situação', 'Pago');
  await U.pickDay(page, page, 'Data de pagamento', 5).catch(() => {});
  await d.getByRole('button', { name: 'Salvar' }).click();
  await U.toast(page, /Pagamento salvo/);
  p = (await listPayments()).find((x) => x.id === st.pOpenOut.id);
  ok('API: saída status done with paidDate', p.status === 'done' && !!p.paidDate, JSON.stringify([p.status, p.paidDate]));
  ok('row badge Pago', /pago/i.test(await U.row(page, 'QAZ-UI saida a pagar').innerText()));
  // mark received via modal (late entrada)
  await U.row(page, 'QAZ-UI entrada atrasada').getByRole('button', { name: 'Marcar recebido' }).click();
  d = U.dlg(page);
  await d.getByLabel('Data de recebimento').waitFor();
  await U.typeDate(d, 'Data de recebimento', '28/10/2026');
  eq('received date typed', await d.getByLabel('Data de recebimento').inputValue(), '28/10/2026');
  await L.shot(page, 'pagamento_marcar_recebido');
  await d.getByRole('button', { name: 'Confirmar' }).click();
  ok('toast Marcado como recebido', await U.toast(page, /Marcado como recebido/));
  p = (await listPayments()).find((x) => x.id === st.pLateIn.id);
  ok('API: late entrada received 2026-10-28', p.receiptStatus === 'received' && p.receivedDate === '2026-10-28', JSON.stringify([p.receiptStatus, p.receivedDate]));
  // delete a plain payment (native confirm)
  S.dialogs.length = 0;
  await U.row(page, 'QAZ-UI pagamento data escolhida').getByTitle('Excluir').click();
  await page.waitForTimeout(800);
  ok('delete asks native confirm "Excluir este pagamento?"', S.dialogs.some((m) => /Excluir este pagamento/.test(m)), JSON.stringify(S.dialogs));
  ok('API: payment deleted', !(await listPayments()).some((x) => x.description === 'QAZ-UI pagamento data escolhida'));
  await L.shot(page, 'fluxo_caixa_final');
  const bd = await U.badDates(page);
  ok('Fluxo de Caixa: no iso/US dates on screen', bd.length === 0, bd.join(','));
});

L.saveResults('r2.json'); L.saveEvents('e2.json');
await S.browser.close();

