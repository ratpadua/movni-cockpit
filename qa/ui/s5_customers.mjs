import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start } from './harness.mjs';
const { api, ok, eq } = L;
const S = await start();
const { page } = S;
const sp = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const custs = async () => (await api('GET', '/api/customers')).body;

await S.flow('Clientes: lista e ResourceManager (criar/editar/excluir/validacao)', async () => {
  await U.go(page, '/customers', 'Clientes');
  const t = sp(await U.bodyText(page));
  ok('list shows QAZ customers', t.includes('QAZ Cliente Teste') && t.includes('QAZ Ábaco') && t.includes('QAZ Zebra'));
  await L.shot(page, 'clientes_lista');
  const ord = await U.optionsOf(page, page, 'Ordenar por'); await U.closeDropdown(page);
  ok('Ordenar por options alphabetical', U.isSorted(ord), JSON.stringify(ord));
  // sort order of rows by Nome default asc with accents: Ábaco before Cliente Teste? (QAZ Ábaco < QAZ Cliente < QAZ Num 2 < QAZ Num 10 < QAZ Zebra)
  const names = (await page.locator('tbody tr td:first-child').allInnerTexts()).map((s) => s.trim());
  const q = names.filter((n) => /^QAZ/.test(n));
  ok('rows sorted by Nome pt-BR (Ábaco, Cliente Teste, Num 2, Num 10, Zebra)', JSON.stringify(q) === JSON.stringify(['QAZ Ábaco', 'QAZ Cliente Teste', 'QAZ Num 2', 'QAZ Num 10', 'QAZ Zebra']), JSON.stringify(q));
  await page.getByLabel('Buscar').fill('acao');
  await page.waitForTimeout(300);
  const t2 = sp(await U.bodyText(page));
  ok('search accent-insensitive (acao finds João Ação)', t2.includes('QAZ Cliente Teste') && !t2.includes('QAZ Zebra'));
  await page.getByRole('button', { name: 'Limpar' }).click();
  // ---- validation: save empty
  await page.getByRole('button', { name: 'Novo', exact: true }).click();
  let d = U.dlg(page);
  await d.getByText('Novo', { exact: true }).first().waitFor();
  const before = (await custs()).length;
  await U.clearToasts(page); await d.getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(1200);
  let toasts = await U.toastTexts(page);
  console.log('  empty customer save toasts:', JSON.stringify(toasts));
  ok('empty Nome: error shown in red (no silent failure) and nothing created', toasts.length > 0 && (await custs()).length === before && !/Salvo com sucesso/.test(toasts.join(' ')), JSON.stringify(toasts));
  ok('error message is in Portuguese', toasts.some((x) => /nome|obrigat|inv[aá]lid|preench/i.test(x)), JSON.stringify(toasts));
  await L.shot(page, 'clientes_validacao_nome_vazio');
  S.expectBad.push(/400 POST \/api\/customers/);
  // too long name
  await d.getByLabel('Nome').fill('a'.repeat(300));
  await U.clearToasts(page); await d.getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(1000);
  toasts = await U.toastTexts(page);
  ok('300-char Nome: validation message shown (pt-BR)', toasts.some((x) => /caracter|longo|máximo|inv[aá]lid|exced/i.test(x)), JSON.stringify(toasts));
  // valid
  await d.getByLabel('Nome').fill('QAZ UI Cliente');
  await d.getByLabel('Apelido').fill('Zé Ação');
  await d.getByLabel('E-mail').fill('qaz.ui@example.test');
  await d.getByLabel('Cidade').fill('Florianópolis');
  const cp = await U.optionsOf(page, d, 'Contato preferido');
  ok('Contato preferido options alphabetical (E-mail, WhatsApp)', JSON.stringify(cp) === JSON.stringify(['E-mail', 'WhatsApp']), JSON.stringify(cp));
  await page.getByRole('option', { name: 'WhatsApp' }).click();
  await U.clearToasts(page); await d.getByRole('button', { name: 'Salvar' }).click();
  ok('toast "Salvo com sucesso"', await U.toast(page, /Salvo com sucesso/));
  await page.waitForTimeout(600);
  const c = (await custs()).find((x) => x.name === 'QAZ UI Cliente');
  ok('API: customer saved with accents and preferredContact', c && c.nickname === 'Zé Ação' && c.preferredContact === 'whatsapp' && c.city === 'Florianópolis', JSON.stringify(c));
  ok('row visible in list', (await U.bodyText(page)).includes('QAZ UI Cliente'));
  // edit
  await U.row(page, 'QAZ UI Cliente').locator('button').first().click();
  d = U.dlg(page);
  await d.getByText('Editar', { exact: true }).first().waitFor();
  eq('edit modal preloaded name', await d.getByLabel('Nome').inputValue(), 'QAZ UI Cliente');
  await d.getByLabel('Cidade').fill('Joinville');
  await d.getByLabel('Nome').fill('');
  await U.clearToasts(page); await d.getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(900);
  toasts = await U.toastTexts(page);
  ok('edit with empty Nome rejected with message', toasts.length > 0 && !/Salvo com sucesso/.test(toasts.join(' ')), JSON.stringify(toasts));
  await d.getByLabel('Nome').fill('QAZ UI Cliente');
  await U.clearToasts(page); await d.getByRole('button', { name: 'Salvar' }).click();
  await U.toast(page, /Salvo com sucesso/);
  await page.waitForTimeout(600);
  eq('API: city updated', (await custs()).find((x) => x.name === 'QAZ UI Cliente').city, 'Joinville');
  // delete
  S.dialogs.length = 0; await U.clearToasts(page);
  await U.row(page, 'QAZ UI Cliente').locator('button').nth(1).click();
  await page.waitForTimeout(900);
  ok('delete asks confirm', S.dialogs.some((m) => /Excluir este registro/.test(m)));
  ok('API: customer deleted', !(await custs()).some((x) => x.name === 'QAZ UI Cliente'));
  // delete a customer that has a contract (behaviour probe)
  const inUse = (await api('POST', '/api/customers', { name: 'QAZ UI Em Uso' })).body;
  const ct = (await api('POST', '/api/contracts', { customerId: inUse.id, type: 'contract', items: [{ serviceVersionId: st.sv1 }], templateId: st.tC.id, receiptTemplateId: st.tR.id, installments: 1, dueDates: [L.addDays(L.localToday(), 9)] })).body;
  await page.reload(); await page.waitForLoadState('networkidle');
  await U.clearToasts(page);
  await U.row(page, 'QAZ UI Em Uso').locator('button').nth(1).click();
  await page.waitForTimeout(1200);
  toasts = await U.toastTexts(page);
  const stillThere = (await custs()).some((x) => x.id === inUse.id);
  const ctAfter = (await api('GET', `/api/contracts/${ct.id}`)).body;
  console.log('  delete customer with contract -> toasts', JSON.stringify(toasts), 'customer still exists:', stillThere, 'contract customerId now:', ctAfter.customerId);
  L.known('deleting a customer that has contracts is blocked with a message OR keeps contracts linked (no orphaned contract) [KNOWN: contracts.customer_id is ON DELETE SET NULL]', stillThere || (ctAfter.customerId != null), `customer deleted, contract ${ct.number} orphaned (customerId=${ctAfter.customerId}); toasts=${JSON.stringify(toasts)}; confirm text=${JSON.stringify(S.dialogs)}`);
  await L.shot(page, 'clientes_excluir_em_uso');  S.expectBad.push(/409|400|500 DELETE \/api\/customers/, /DELETE \/api\/customers/);
});

await S.flow('Cliente: detalhe (creditos, utilizados, cobrancas)', async () => {
  // make sure there is an active credit to list (earlier specs may have consumed every seeded credit)
  await api('POST', '/api/customers/' + st.cu.id + '/credits', { description: 'QAZ credito ativo', value: '80,5' });
  await U.go(page, '/customers', 'Clientes');
  await U.row(page, 'QAZ Cliente Teste').locator('td').first().click();
  await page.waitForURL(/\/customers\/\d+/);
  await page.getByRole('heading', { name: 'QAZ Cliente Teste' }).waitFor();
  await page.waitForLoadState('networkidle');
  let t = sp(await U.bodyText(page));
  ok('detail: header with nickname/email', /João Ação/.test(t) && /qaz@example\.test/.test(t));
  const credits = (await api('GET', `/api/customers/${st.cu.id}/credits?all=1`)).body;
  const active = credits.filter((c) => Number(c.remaining) > 0);
  const used = credits.filter((c) => Number(c.remaining) <= 0);
  console.log('  credits active', active.length, 'used', used.length);
  for (const c of active) await page.getByText(c.description).first().waitFor({ timeout: 8000 }).catch(() => {});
  t = sp(await U.bodyText(page));
  ok('active credits listed with R$ pt-BR (original + restante)', active.every((c) => t.includes(c.description)) && U.brlRe.test(t), 'active=' + JSON.stringify(active.map((c) => [c.description, c.remaining])) + ' missing=' + JSON.stringify(active.filter((c) => !t.includes(c.description)).map((c) => c.description)) + ' hasBRL=' + U.brlRe.test(t));
  ok('used credits hidden by default', used.every((c) => !t.includes(c.description)) && !/Utilizados/.test(t));
  await L.shot(page, 'cliente_detalhe');
  await page.getByText('Mostrar utilizados', { exact: true }).click();
  await page.waitForTimeout(400);
  t = sp(await U.bodyText(page));
  ok('"Mostrar utilizados" reveals used credits (R$ 0,00 restante)', /Utilizados/.test(t) && used.every((c) => t.includes(c.description)) && /R\$\s?0,00/.test(t), t.slice(0, 500));
  await L.shot(page, 'cliente_detalhe_utilizados');
  // pending charges
  const pays = (await api('GET', '/api/payments')).body.filter((p) => p.customerId === st.cu.id && p.flow === 'in' && p.receiptStatus === 'open');
  const total = pays.reduce((s, p) => s + Number(p.amount), 0);
  ok('pending charges lists open entradas with due dd/MM/yyyy and contract number', pays.length > 0 && pays.every((p) => t.includes(L.br(p.dueDate))) && t.includes(st.C1.number), `${pays.length}`);
  ok(`pending charges total ${total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`, t.includes(sp(total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }))), t.slice(-400));
  // add credit validation
  await page.getByRole('button', { name: 'Novo crédito' }).click();
  const d = U.dlg(page);
  ok('Adicionar disabled with empty description / zero value', await d.getByRole('button', { name: 'Adicionar' }).isDisabled());
  await d.getByLabel('Descrição').fill('QAZ UI credito');
  ok('Adicionar still disabled with value 0', await d.getByRole('button', { name: 'Adicionar' }).isDisabled());
  await d.getByLabel('Valor').fill('55,5');
  ok('Adicionar enabled with description + value', await d.getByRole('button', { name: 'Adicionar' }).isEnabled());
  await L.shot(page, 'cliente_novo_credito');
  await d.getByRole('button', { name: 'Adicionar' }).click();
  ok('toast "Crédito adicionado"', await U.toast(page, /Crédito adicionado/));
  await page.waitForTimeout(700);
  t = sp(await U.bodyText(page));
  ok('new credit shown with R$ 55,50', /QAZ UI credito/.test(t) && /R\$\s?55,50/.test(t));
  const nc = (await api('GET', `/api/customers/${st.cu.id}/credits`)).body.find((c) => c.description === 'QAZ UI credito');
  ok('API: credit value 55.50', nc && Number(nc.value) === 55.5);
  S.dialogs.length = 0;
  await U.row(page, 'QAZ UI credito').getByTitle('Excluir crédito').click();
  await page.waitForTimeout(800);
  ok('delete credit asks confirm', S.dialogs.some((m) => /Excluir este crédito/.test(m)));
  ok('API: credit deleted', !(await api('GET', `/api/customers/${st.cu.id}/credits`)).body.some((c) => c.description === 'QAZ UI credito'));
  ok('used credits have no delete button (only untouched ones)', (await page.locator('tr').filter({ hasText: 'QAZ credito usado' }).getByTitle('Excluir crédito').count()) === 0);
  const bd = await U.badDates(page);
  ok('detail: no iso/US dates', bd.length === 0, bd.join(','));
});

await S.flow('Categorias e Servicos (ResourceManager / smoke)', async () => {
  await U.go(page, '/categories', 'Categorias');
  let t = sp(await U.bodyText(page));
  ok('categories list shows QAZ categories with Entrada/Saída labels', /QAZ Cat In/.test(t) && /Entrada/.test(t) && /Saída/.test(t));
  await page.getByRole('button', { name: 'Novo', exact: true }).click();
  const d = U.dlg(page);
  const tp = await U.optionsOf(page, d, 'Tipo'); await U.closeDropdown(page);
  ok('Tipo options alphabetical (Entrada, Saída)', JSON.stringify(tp) === JSON.stringify(['Entrada', 'Saída']), JSON.stringify(tp));
  await U.clearToasts(page); await d.getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(900);
  const toasts = await U.toastTexts(page);
  ok('empty category name: validation message shown', toasts.length > 0 && !/Salvo com sucesso/.test(toasts.join(' ')), JSON.stringify(toasts));
  S.expectBad.push(/400 POST \/api\/categories/);
  await U.closeModal(page);
  await L.shot(page, 'categorias');
  await U.go(page, '/services', 'Serviços');
  t = sp(await U.bodyText(page));
  ok('services page lists QAZ Servico with R$ price', /QAZ Servico/.test(t) && U.brlRe.test(t));
  await L.shot(page, 'servicos');
});

L.saveResults('r5.json'); L.saveEvents('e5.json');
await S.browser.close();

