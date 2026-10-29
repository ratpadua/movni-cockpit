import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start, saveDownload, docxText, contractsDirFiles } from './harness.mjs';
const { api, ok, eq } = L;
const S = await start();
const { page } = S;
const today = L.localToday();
const sp = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const R = st.R1.id;
const getR = async () => (await api('GET', `/api/contracts/${R}`)).body;

await S.flow('Contrato recorrente: novo via modal (Tipo Fatura)', async () => {
  await U.go(page, '/contracts', 'Contratos');
  await page.getByRole('button', { name: 'Novo contrato' }).click();
  const d = U.dlg(page);
  await d.getByText('Novo contrato', { exact: true }).first().waitFor();
  await U.pickOption(page, d, 'Cliente', 'QAZ Zebra');
  await U.pickOption(page, d, 'Tipo', 'Fatura (recorrente)');
  await d.getByLabel('Título').fill('QAZ Recorrente UI');
  ok('recurring form hides installment planner, shows info Alert', /Os serviços realizados são adicionados depois/.test(await d.innerText()));
  await U.pickOption(page, d, 'Modelo da fatura', 'QAZ Modelo Fatura');
  await U.pickOption(page, d, 'Modelo do recibo', 'QAZ Modelo Recibo');
  await L.shot(page, 'contrato_recorrente_modal_novo');
  await d.getByRole('button', { name: 'Salvar', exact: true }).click();
  ok('toast Contrato salvo', await U.toast(page, /Contrato salvo/));
  await page.waitForURL(/\/contracts\/\d+/, { timeout: 8000 });
  ok('creating a recurring contract navigates to its detail page', /\/contracts\/\d+$/.test(page.url()), page.url());
  const idNew = Number(page.url().split('/').pop());
  const c = (await api('GET', `/api/contracts/${idNew}`)).body;
  ok('API: type invoice, number F###', c.type === 'invoice' && /^F\d{3,}$/.test(c.number), JSON.stringify([c.type, c.number]));
  await page.getByText('Serviços realizados').waitFor();
  ok('detail of empty recurring: "Nenhum serviço realizado ainda." + Nova fatura disabled', /Nenhum serviço realizado ainda/.test(await U.bodyText(page)) && await page.getByRole('button', { name: 'Nova fatura' }).isDisabled());
  await L.shot(page, 'contrato_recorrente_novo_detalhe');
});

await S.flow('Contrato recorrente: servicos realizados', async () => {
  await U.go(page, `/contracts/${R}`, undefined);
  await page.getByText('Serviços realizados').waitFor();
  const t0 = sp(await U.bodyText(page));
  ok('recurring detail badge "Fatura (recorrente)"', /Fatura \(recorrente\)/i.test(t0));
  // add 2 units of QAZ Servico
  await page.getByRole('button', { name: 'Adicionar serviço' }).click();
  let d = U.dlg(page);
  await U.pickOption(page, d, 'Serviço', 'QAZ Servico');
  await d.getByText('Total do item').waitFor();
  ok('Adicionar enabled after service picked', await d.getByRole('button', { name: 'Adicionar', exact: true }).isEnabled());
  await d.getByLabel('Quantidade').fill('2');
  await d.getByText('Item 2').waitFor();
  const descs = d.getByLabel('Descrição');
  await descs.nth(0).fill('QAZ item A');
  await descs.nth(1).fill('QAZ item B');
  await d.locator('tr').filter({ hasText: 'Extra' }).first().getByRole('textbox').first().fill('1');
  await U.typeDate(d, 'Data de realização', '05/10/2026');
  eq('date shows dd/MM/yyyy', await d.getByLabel('Data de realização').first().inputValue(), '05/10/2026');
  const dt = sp(await d.innerText());
  ok('modal total for 2 items R$ 1.900,00 (1000 + 900)', /Total \(2 itens\): R\$\s?1\.900,00/.test(dt), dt.slice(-200));
  await L.shot(page, 'recorrente_adicionar_servico');
  await d.getByRole('button', { name: 'Adicionar', exact: true }).click();
  ok('toast "2 serviços adicionados"', await U.toast(page, /2 serviços adicionados/));
  // add C (other service, no date) and D
  for (const [svc, desc] of [['QAZ Água Serviço', 'QAZ item C'], ['QAZ Servico', 'QAZ item D']]) {
    await page.getByRole('button', { name: 'Adicionar serviço' }).click();
    d = U.dlg(page);
    await U.pickOption(page, d, 'Serviço', svc);
    await d.getByLabel('Descrição').first().fill(desc);
    await d.getByRole('button', { name: 'Adicionar', exact: true }).click();
    await U.toast(page, /Serviço adicionado/);
    await page.waitForTimeout(500);
  }
  const full = await getR();
  const mine = full.items.filter((i) => /^QAZ item/.test(i.description || ''));
  ok('API: 4 performed items (A with additional, B, C, D)', mine.length === 4, JSON.stringify(mine.map((i) => i.description)));
  const A = mine.find((i) => i.description === 'QAZ item A');
  ok('API: item A performedAt 2026-10-05 + additional Extra', A.performedAt === '2026-10-05' && A.additionals.length === 1, JSON.stringify([A.performedAt, A.additionals]));
  const t = sp(await U.bodyText(page));
  ok('table: 05/10/2026 shown dd/MM/yyyy, "Em aberto" badges, R$ money', /05\/10\/2026/.test(t) && /em aberto/i.test(t) && /R\$\s?1\.000,00/.test(t), t.slice(0, 400));
  ok('undated item shows "—"', /—/.test(sp(await U.row(page, 'QAZ item C').innerText())));
  // edit item
  await U.row(page, 'QAZ item D').getByTitle('Editar').click();
  d = U.dlg(page);
  await d.getByText('Editar serviço realizado').first().waitFor();
  await d.getByLabel('Descrição').first().fill('QAZ item D editado');
  await d.getByRole('button', { name: 'Salvar', exact: true }).click();
  ok('toast "Serviço atualizado"', await U.toast(page, /Serviço atualizado/));
  await page.waitForTimeout(600);
  ok('API: item D description updated', (await getR()).items.some((i) => i.description === 'QAZ item D editado'));
  await L.shot(page, 'recorrente_servicos_realizados');
  // remove D and re-add
  await U.row(page, 'QAZ item D editado').getByTitle('Remover').click();
  await page.waitForTimeout(700);
  ok('API: item D removed', !(await getR()).items.some((i) => /item D/.test(i.description || '')));
  await page.getByRole('button', { name: 'Adicionar serviço' }).click();
  d = U.dlg(page);
  await U.pickOption(page, d, 'Serviço', 'QAZ Servico');
  await d.getByLabel('Descrição').first().fill('QAZ item D');
  await d.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await U.toast(page, /Serviço adicionado/);
  await page.waitForTimeout(600);
  const bd = await U.badDates(page);
  ok('recorrente: no iso/US dates on screen', bd.length === 0, bd.join(','));
});

await S.flow('Contrato recorrente: faturas', async () => {
  await U.go(page, `/contracts/${R}`, undefined);
  await page.getByText('Serviços realizados').waitFor();
  const openInvoice = async () => { await page.getByRole('button', { name: 'Nova fatura' }).click(); const d = U.dlg(page); await d.getByText('Nova fatura').first().waitFor(); return d; };
  // Invoice 1: item B, empty ref
  let d = await openInvoice();
  const def = await d.locator('table input[placeholder="dd/mm/aaaa"]').first().inputValue();
  ok('new invoice default due date is dd/MM/yyyy (5 business days)', /^\d{2}\/\d{2}\/\d{4}$/.test(def), def);
  ok('Criar fatura disabled with no item selected', await d.getByRole('button', { name: 'Criar fatura' }).isDisabled());
  await d.getByText(/QAZ item B/).first().click();
  await L.shot(page, 'recorrente_nova_fatura_modal');
  await d.getByRole('button', { name: 'Criar fatura' }).click();
  ok('toast "Fatura criada" (inv 1, empty reference)', await U.toast(page, /Fatura criada/));
  await page.waitForTimeout(700);
  // Invoice 2: item C, empty ref
  d = await openInvoice();
  await d.getByText(/QAZ item C/).first().click();
  const nParc = sp(await d.innerText());
  ok('invoice of R$ 50 allows only 1 installment (max 1)', /Parcelas \(máx\. 1\)/.test(nParc), nParc.slice(-300));
  await d.getByRole('button', { name: 'Criar fatura' }).click();
  ok('toast "Fatura criada" (inv 2, empty reference)', await U.toast(page, /Fatura criada/));
  await page.waitForTimeout(700);
  // Invoice 3: item A, discount, credit, 2 installments, ref Mensal
  d = await openInvoice();
  await d.getByLabel('Referência').fill('Mensal');
  await d.getByText(/QAZ item A/).first().click();
  await d.getByLabel('Desconto (%)').fill('10');
  const cr = await U.optionsOf(page, d, 'Usar crédito do cliente');
  ok('invoice credit options alphabetical and labeled "restante"', U.isSorted(cr) && cr.every((x) => /restante R\$/.test(x)), JSON.stringify(cr));
  await page.getByRole('option', { name: /credito fatura/ }).first().click();
  const calc = sp(await d.innerText());
  ok('summary: Subtotal R$ 1.000,00 · Total R$ 900,00 · Crédito -R$ 120,00 · A parcelar R$ 780,00', /Subtotal: R\$\s?1\.000,00/.test(calc) && /Total: R\$\s?900,00/.test(calc) && /Crédito: -R\$\s?120,00/.test(calc) && /A parcelar: R\$\s?780,00/.test(calc), calc.slice(-400));
  await U.pickOption(page, d, /Parcelas \(máx/, /^2 \(/);
  await L.shot(page, 'recorrente_fatura_credito');
  await d.getByRole('button', { name: 'Criar fatura' }).click();
  ok('toast "Fatura criada" (inv 3, Mensal)', await U.toast(page, /Fatura criada/));
  await page.waitForTimeout(700);
  // Invoice 4: item D, ref Mensal, modifier
  d = await openInvoice();
  await d.getByLabel('Referência').fill('Mensal');
  await d.getByText(/QAZ item D/).first().click();
  await d.getByRole('button', { name: 'Adicionar' }).first().click();
  await d.getByPlaceholder('Descrição').fill('QAZ mod');
  await d.locator('input[placeholder="Valor"]').fill('-50');
  const calc4 = sp(await d.innerText());
  ok('modifier reflected: Modificadores -R$ 50,00 · Total R$ 850,00', /Modificadores: -R\$\s?50,00/.test(calc4) && /Total: R\$\s?850,00/.test(calc4), calc4.slice(-300));
  await d.getByRole('button', { name: 'Criar fatura' }).click();
  ok('toast "Fatura criada" (inv 4)', await U.toast(page, /Fatura criada/));
  await page.waitForTimeout(900);
  const full = await getR();
  const invs = full.invoices.sort((a, b) => a.id - b.id);
  ok('API: 4 invoices, unique NNN-YY refNumbers', invs.length === 4 && new Set(invs.map((i) => i.refNumber)).size === 4 && invs.every((i) => /^\d{3}-\d{2}$/.test(i.refNumber)), JSON.stringify(invs.map((i) => [i.refNumber, i.reference])));
  ok('API: two invoices with empty reference', invs.filter((i) => !i.reference).length === 2);
  const t = sp(await U.bodyText(page));
  for (const i of invs) ok(`screen lists invoice ${i.refNumber}`, t.includes(i.refNumber), i.refNumber);
  ok('empty-reference invoices shown as "Fatura #id" (distinct)', invs.filter((i) => !i.reference).every((i) => t.includes(`Fatura #${i.id}`)));
  ok('invoice line shows ·desc. 10% and crédito -R$ 120,00 and 2x', /desc\. 10%/.test(t) && /crédito -R\$\s?120,00/.test(t) && /2x/.test(t), t.slice(-600));
  ok('invoice money R$ 1.234,56 style', U.brlRe.test(t));
  await L.shot(page, 'recorrente_faturas');
  // items now invoiced
  await page.getByText('Mostrar faturados', { exact: true }).click();
  await page.waitForTimeout(400);
  const t2 = sp(await U.bodyText(page));
  ok('Mostrar faturados shows "Faturado · Mensal" badges', /faturado\s*·\s*mensal/i.test(t2), t2.slice(0, 300));
  await L.shot(page, 'recorrente_mostrar_faturados');
  // edit invoice 2 (empty ref) -> set a reference
  const cardOf = (i) => page.locator('.mantine-Paper-root').filter({ hasText: i.reference ? i.refNumber : `Fatura #${i.id}` }).last();
  await cardOf(invs[1]).getByTitle('Editar fatura').click();
  d = U.dlg(page);
  await d.getByText('Editar fatura').first().waitFor();
  eq('edit modal Referência empty for empty-ref invoice', await d.getByLabel('Referência').inputValue(), '');
  await d.getByLabel('Referência').fill('QAZ Ref Editada');
  await L.shot(page, 'recorrente_fatura_editar');
  await d.getByRole('button', { name: 'Salvar alterações' }).click();
  ok('toast "Fatura atualizada"', await U.toast(page, /Fatura atualizada/));
  await page.waitForTimeout(800);
  const f2 = await getR();
  ok('API: invoice 2 reference updated', f2.invoices.some((i) => i.id === invs[1].id && i.reference === 'QAZ Ref Editada'), JSON.stringify(f2.invoices.map((i) => i.reference)));
  // edit invoice 3 (credit): reopen shows credit reinstated and dd/MM due dates
  await cardOf(invs[2]).getByTitle('Editar fatura').click();
  d = U.dlg(page);
  await d.getByText('Editar fatura').first().waitFor();
  const dd = await d.locator('table input[placeholder="dd/mm/aaaa"]').evaluateAll((els) => els.map((e) => e.value));
  ok('edit invoice 3: 2 due dates dd/MM/yyyy', dd.length === 2 && dd.every((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x)), JSON.stringify(dd));
  await U.closeModal(page);
  fs.writeFileSync(path.join(L.QA, 'state3.json'), JSON.stringify({ invs: invs.map((i) => i.id) }));
});

await S.flow('Contrato recorrente: documentos da fatura + downloads', async () => {
  const full = await getR();
  const invs = full.invoices.sort((a, b) => a.id - b.id);
  await U.go(page, `/contracts/${R}`, undefined);
  await page.getByText('Faturas').first().waitFor();
  // generate for invoices 1 and 2 (both formerly empty reference)
  const btns = page.getByRole('button', { name: 'Gerar documento' });
  await btns.nth(0).click();
  ok('toast "Documento da fatura gerado" (inv 1, empty ref)', await U.toast(page, /Documento da fatura gerado/, 20000));
  await page.waitForTimeout(700);
  await btns.nth(1).click();
  await page.waitForTimeout(1500);
  await btns.nth(2).click();
  await page.waitForTimeout(1500);
  const f = await getR();
  const docs = f.invoices.sort((a, b) => a.id - b.id).map((i) => (i.documents[0] || {}).fileName);
  console.log('  invoice doc names:', JSON.stringify(docs));
  ok('3 invoice documents generated', docs.filter(Boolean).length === 3, JSON.stringify(docs));
  ok('names fatura_Joao_Acao_<ref> (accents transliterated)', docs.filter(Boolean).every((n) => /^fatura_Joao_Acao_/.test(n)), JSON.stringify(docs));
  ok('document names are distinct (two empty-reference invoices do not collide)', new Set(docs.filter(Boolean)).size === docs.filter(Boolean).length, JSON.stringify(docs));
  eq('invoices have docs in separate records (storage files == 3)', contractsDirFiles().length, 3);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: 'Baixar' }).first().click()]);
  console.log('  invoice download:', dl.suggestedFilename());
  ok('invoice download filename equals document name', docs.includes(dl.suggestedFilename()), dl.suggestedFilename());
  const fx = await saveDownload(dl, 'inv1.docx');
  ok('invoice docx filled', /Fatura \d{3}-\d{2}/.test(docxText(fx)) && /QAZ item/.test(docxText(fx)), docxText(fx).slice(0, 250));
  const pP = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: 'PDF' }).first().click();
  ok('invoice PDF: loading notification', await U.toast(page, /Gerando PDF|Convertendo/, 5000));
  const pd = await pP;
  ok('invoice PDF valid, name .pdf', pd.suggestedFilename().endsWith('.pdf') && fs.readFileSync(await saveDownload(pd, 'inv1.pdf')).subarray(0, 4).toString() === '%PDF', pd.suggestedFilename());
  await L.shot(page, 'recorrente_documentos');
  // delete documents
  S.dialogs.length = 0;
  while ((await page.getByTitle('Excluir documento').count()) > 0) {
    await page.getByTitle('Excluir documento').first().click();
    await page.waitForTimeout(900);
  }
  ok('delete doc asks confirm', S.dialogs.some((m) => /Excluir este documento/.test(m)));
  eq('storage/contracts empty after deleting invoice docs', contractsDirFiles().length, 0);
  // delete one invoice via confirm -> its items come back "Em aberto"
  S.dialogs.length = 0;
  await page.getByTitle('Excluir fatura').last().click();
  await page.waitForTimeout(1200);
  ok('delete invoice asks confirm', S.dialogs.some((m) => /Excluir a fatura/.test(m)), JSON.stringify(S.dialogs));
  const g = await getR();
  eq('API: 3 invoices left', g.invoices.length, 3);
  ok('API: its item back to open (invoiceId null)', g.items.filter((i) => !i.invoiceId).length === 1, JSON.stringify(g.items.map((i) => [i.description, i.invoiceId])));
  await L.shot(page, 'recorrente_apos_excluir_fatura');
});

L.saveResults('r4.json'); L.saveEvents('e4.json');
await S.browser.close();

