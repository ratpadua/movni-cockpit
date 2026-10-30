import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start, saveDownload, docxText, contractsDirFiles } from './harness.mjs';
const { api, ok, eq } = L;
const S = await start();
const { page } = S;
const today = L.localToday();
const fmtBrl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ');
const sp = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const state2 = {};

// extra credit for the recurring invoice test
// (QAZ credito aberto / QAZ credito fatura are created by s1_seed)
state2.credFatura = (await api('GET', `/api/customers/${st.cu.id}/credits`)).body.find((c) => c.description === 'QAZ credito fatura');
fs.writeFileSync(path.join(L.QA, 'state2.json'), JSON.stringify(state2));

await S.flow('Contratos: lista', async () => {
  await U.go(page, '/contracts', 'Contratos');
  const t = sp(await U.bodyText(page));
  ok('list shows C1, C2 and R1 numbers', t.includes(st.C1.number) && t.includes(st.C2.number) && t.includes(st.R1.number), t.slice(0, 300));
  const rowC1 = sp(await U.row(page, st.C1.number).innerText());
  ok('C1 row: money pt-BR, Criado dd/MM/yyyy, status label', /R\$\s?1\.000,00/.test(rowC1) && /\d{2}\/\d{2}\/\d{4}/.test(rowC1) && /aguardando pagamento/i.test(rowC1), rowC1);
  ok('C2 row flagged "atrasado" (em edição past deadline)', /atrasado/i.test(sp(await U.row(page, st.C2.number).innerText())), sp(await U.row(page, st.C2.number).innerText()));
  const stat = await U.optionsOf(page, page, 'Status'); await U.closeDropdown(page);
  ok('Status filter keeps WORKFLOW order (keepOrder)', JSON.stringify(stat) === JSON.stringify(['Aguardando pagamento', 'Agendado', 'Realizado', 'Em edição', 'Enviado', 'Finalizado']), JSON.stringify(stat));
  const ord = await U.optionsOf(page, page, 'Ordenar por'); await U.closeDropdown(page);
  ok('Ordenar por options alphabetical', U.isSorted(ord), JSON.stringify(ord));
  await U.pickOption(page, page, 'Status', 'Em edição');
  const t2 = sp(await U.bodyText(page));
  ok('Status filter Em edição shows only C2 (QAZ)', t2.includes(st.C2.number) && !t2.includes(st.C1.number));
  await page.getByRole('button', { name: /Limpar|limpar/ }).click().catch(() => {});
  await page.getByLabel('Status').first().click({ clickCount: 1 }).catch(() => {});
  await U.closeDropdown(page);
  await page.goto(L.BASE + '/contracts'); await page.waitForLoadState('networkidle');
  await page.getByLabel('Buscar').fill('abaco');
  await page.waitForTimeout(300);
  const t3 = sp(await U.bodyText(page));
  ok('search is accent-insensitive ("abaco" finds "QAZ Ábaco")', t3.includes(st.C2.number) && !t3.includes(st.C1.number), t3.slice(0, 200));
  await L.shot(page, 'contratos_lista');
  const bd = await U.badDates(page);
  ok('Contratos: no iso/US dates', bd.length === 0, bd.join(','));
});

await S.flow('Contratos: novo contrato unico (DateField + InstallmentPlanner)', async () => {
  await U.go(page, '/contracts', 'Contratos');
  await page.getByRole('button', { name: 'Novo contrato' }).click();
  const d = U.dlg(page);
  await d.getByText('Novo contrato', { exact: true }).first().waitFor();
  const saveBtn = d.getByRole('button', { name: 'Salvar', exact: true });
  ok('Salvar disabled until required fields filled', await saveBtn.isDisabled());
  // customers alphabetical
  const cu = await U.optionsOf(page, d, 'Cliente');
  ok('Cliente options alphabetical (names)', U.isSorted(cu), JSON.stringify(cu));
  await page.getByRole('option', { name: 'QAZ Cliente Teste' }).click();
  const tp = await U.optionsOf(page, d, 'Tipo'); await U.closeDropdown(page);
  ok('Tipo options alphabetical (Contrato (único), Fatura (recorrente))', JSON.stringify(tp) === JSON.stringify(['Contrato (único)', 'Fatura (recorrente)']), JSON.stringify(tp));
  const sv = await U.optionsOf(page, d, 'Serviço (título do contrato)');
  ok('Serviço options alphabetical (QAZ Água Serviço < QAZ Servico)', U.isSorted(sv) && sv.indexOf('QAZ Água Serviço') < sv.indexOf('QAZ Servico'), JSON.stringify(sv));
  await page.getByRole('option', { name: 'QAZ Servico', exact: true }).click();
  await d.getByText(/Preço base: R\$\s?900,00/).waitFor();
  const tm = await U.optionsOf(page, d, 'Modelo do documento');
  ok('Modelo options alphabetical', U.isSorted(tm), JSON.stringify(tm));
  await page.getByRole('option', { name: 'QAZ Modelo Contrato' }).click();
  // DateField: key-by-key typing of dd/MM/yyyy, then fill()
  const dateLbl = d.getByLabel('Data', { exact: true }).first();
  await dateLbl.click();
  await dateLbl.pressSequentially('15/12/2026', { delay: 40 });
  await dateLbl.press('Tab');
  const typedGot = await dateLbl.inputValue();
  ok('ContractFormModal "Data": typing 15/12/2026 yields 15/12/2026', typedGot === '15/12/2026', `got "${typedGot}"`);
  await U.typeDate(d, 'Data', '15/12/2026');
  eq('Data shows dd/MM/yyyy', await d.getByLabel('Data', { exact: true }).first().inputValue(), '15/12/2026');
  await d.getByLabel('Horário').fill('14:30');
  await d.getByLabel('Locação').fill('QAZ Estudio');
  await d.getByLabel('Duração').fill('2 horas');
  await d.getByLabel('Quantidade').fill('3');
  // additionals
  const addRow = d.locator('tr').filter({ hasText: 'Extra' }).first();
  await addRow.getByRole('textbox').first().fill('1');
  await d.getByText(/Adicionais: R\$\s?100,00/).waitFor();
  // credit select
  const cr = await U.optionsOf(page, d, 'Usar crédito do cliente');
  ok('credit options alphabetical', U.isSorted(cr) && cr.length >= 2, JSON.stringify(cr));
  const openCred = cr.find((x) => /credito aberto/.test(x));
  ok('credit label shows "restante R$ 300,00"', /restante R\$\s?300,00/.test(sp(openCred || '')), openCred);
  await page.getByRole('option', { name: /credito aberto/ }).click();
  await d.getByText(/R\$\s?300,00 abatido com crédito · a parcelar: R\$\s?700,00/).waitFor();
  ok('credit description "R$ 300,00 abatido com crédito · a parcelar: R$ 700,00"', true);
  // installments
  const planner = d.locator('text=Parcelas (máx.').first();
  const parc = await U.optionsOf(page, d, /Parcelas \(máx/);
  console.log('  parcelas options:', JSON.stringify(parc));
  ok('Parcelas max 4 (700/150) and options in numeric order with per-installment amount', parc.length === 4 && /^1 \(R\$\s?700,00\)$/.test(sp(parc[0])) && /^4 \(R\$\s?175,00\)$/.test(sp(parc[3])), JSON.stringify(parc));
  await page.getByRole('option', { name: /^4 \(/ }).click();
  await U.typeDate(d, 'Primeiro vencimento', '10/01/2027');
  const dueInputs = d.locator('table input[placeholder="dd/mm/aaaa"]');
  await dueInputs.first().waitFor();
  const vals = await dueInputs.evaluateAll((els) => els.map((e) => e.value));
  ok('4 installment rows with monthly dd/MM/yyyy dates from 10/01/2027', JSON.stringify(vals) === JSON.stringify(['10/01/2027', '10/02/2027', '10/03/2027', '10/04/2027']), JSON.stringify(vals));
  // change the third one through the calendar picker, the second by typing dd/MM/yyyy
  const row2 = dueInputs.nth(1);
  await row2.click(); await row2.fill('15/02/2027'); await row2.press('Tab');
  eq('row 2 date adjusted (typed)', await row2.inputValue(), '15/02/2027');
  const row3 = dueInputs.nth(2);
  await row3.click();
  const cell = page.locator('.mantine-Popover-dropdown button.mantine-DateInput-day:not([data-outside])').filter({ visible: true }).filter({ hasText: /^20$/ }).last();
  await cell.click();
  await page.waitForFunction((el) => /^20\//.test(el.value), await row3.elementHandle(), { timeout: 3000 }).catch(() => {});
  const r3 = await row3.inputValue();
  ok('row 3 date picked from calendar shows dd/MM/yyyy (day 20)', /^20\/\d{2}\/\d{4}$/.test(r3), r3);
  const dt = sp(await d.innerText());
  ok('planner total R$ 700,00 and rows R$ 175,00', /Total: R\$\s?700,00/.test(dt) && (dt.match(/R\$\s?175,00/g) || []).length >= 4, dt.slice(-300));
  // receipt template
  const rc = await U.optionsOf(page, d, 'Modelo do recibo');
  ok('receipt model options alphabetical', U.isSorted(rc), JSON.stringify(rc));
  await page.getByRole('option', { name: 'QAZ Modelo Recibo' }).click();
  await d.getByLabel('Comentários').fill('QAZ comentário contrato');
  await L.shot(page, 'contrato_modal_novo');
  ok('Salvar enabled now', await saveBtn.isEnabled());
  await saveBtn.click();
  ok('toast "Contrato salvo"', await U.toast(page, /Contrato salvo/));
  await page.waitForTimeout(800);
  const all = (await api('GET', '/api/contracts')).body;
  const u1s = all.filter((c) => c.customerName === 'QAZ Cliente Teste' && ![st.C1.id, st.R1.id].includes(c.id));
  const u1 = u1s.sort((a, b) => b.id - a.id)[0];
  state2.U1 = u1 && u1.id;
  const full = (await api('GET', `/api/contracts/${u1.id}`)).body;
  ok('API: contract created, total after credit/qty', !!full && Number(full.total) >= 700, JSON.stringify([full.total, full.creditApplied]));
  const pays = full.payments.filter((p) => p.installmentNumber).sort((a, b) => a.installmentNumber - b.installmentNumber);
  const picked = pays[2] && pays[2].dueDate;
  ok('API: 4 installments of 175.00 with typed/picked dates', pays.length === 4 && pays.every((p) => Number(p.amount) === 175) && pays[0].dueDate === '2027-01-10' && pays[1].dueDate === '2027-02-15' && /^\d{4}-\d{2}-20$/.test(picked), JSON.stringify(pays.map((p) => [p.amount, p.dueDate])));
  ok('API: executionDate 2026-12-15, time 14:30, duration, quantity 3', full.executionDate === '2026-12-15' && full.executionTime === '14:30' && full.duration === '2 horas' && Number(full.quantity) === 3, JSON.stringify([full.executionDate, full.executionTime, full.duration, full.quantity]));
  ok('API: credit consumed (300 -> 0 remaining)', (await api('GET', `/api/customers/${st.cu.id}/credits?all=1`)).body.filter((c) => c.description === 'QAZ credito aberto').every((c) => Number(c.remaining) === 0));
  ok('contract detail API has no filePath field in documents (ContractDocument)', !('filePath' in (full.documents[0] || {})) , JSON.stringify(full.documents[0]));
  fs.writeFileSync(path.join(L.QA, 'state2.json'), JSON.stringify(state2));
  // list now shows it with R$ money
  const lt = sp(await U.bodyText(page));
  ok('list shows new contract with money pt-BR', lt.includes(full.number) && /R\$\s?1\.000,00|R\$\s?700,00/.test(lt), full.number);
});

await S.flow('Contratos: detalhe unico (status, documento, downloads, pagamentos)', async () => {
  const id = state2.U1;
  await U.go(page, `/contracts/${id}`, undefined);
  await page.getByText('Itens do contrato').waitFor();
  const t = sp(await U.bodyText(page));
  ok('detail: badges, items table, money pt-BR', /Contrato \(único\)/i.test(t) && /QAZ Servico/.test(t) && /Extra x1/.test(t) && U.brlRe.test(t), t.slice(0, 300));
  ok('detail: installments "Parcela 1/4" with dd/MM/yyyy due', /Parcela 1\/4/.test(t) && /10\/01\/2027/.test(t));
  ok('detail: Situação badges (Aberto) on entrada installments', /aberto/i.test(t));
  await L.shot(page, 'contrato_detalhe_unico');
  // status workflow
  const back = page.getByRole('button', { name: 'Voltar' }), fwd = page.getByRole('button', { name: 'Avançar' });
  ok('initial: Voltar disabled, Avançar enabled, "Aguardando pagamento"', await back.isDisabled() && await fwd.isEnabled() && /aguardando pagamento/i.test(t));
  await fwd.click(); await page.getByText(/agendado/i).first().waitFor();
  eq('API status agendado', (await api('GET', `/api/contracts/${id}`)).body.status, 'agendado');
  await fwd.click(); await page.waitForTimeout(700);
  eq('API status realizado', (await api('GET', `/api/contracts/${id}`)).body.status, 'realizado');
  await back.click(); await page.waitForTimeout(700);
  eq('Voltar -> agendado (one step back)', (await api('GET', `/api/contracts/${id}`)).body.status, 'agendado');
  ok('Voltar/Avançar both enabled in the middle', await back.isEnabled() && await fwd.isEnabled());
  for (let i = 0; i < 2; i++) { await fwd.click(); await page.waitForTimeout(600); }
  const sNow = (await api('GET', `/api/contracts/${id}`)).body.status;
  eq('Avançar x2 -> em_edicao', sNow, 'em_edicao');
  const t2 = sp(await U.bodyText(page));
  ok('em edição shows "Prazo: dd/MM/yyyy"', /Prazo: \d{2}\/\d{2}\/\d{4}/.test(t2), t2.slice(0, 400));
  await fwd.click(); await page.waitForTimeout(600); await fwd.click(); await page.waitForTimeout(700);
  eq('Avançar to finalizado', (await api('GET', `/api/contracts/${id}`)).body.status, 'finalizado');
  ok('Avançar disabled at the last status', await fwd.isDisabled());
  for (let i = 0; i < 5; i++) { await back.click(); await page.waitForTimeout(450); }
  eq('Voltar x5 back to aguardando_pagamento', (await api('GET', `/api/contracts/${id}`)).body.status, 'aguardando_pagamento');
  await L.shot(page, 'contrato_status_workflow');

  // generate document
  await page.getByRole('button', { name: 'Gerar contrato' }).click();
  ok('toast "Documento gerado"', await U.toast(page, /Documento gerado/, 20000));
  await page.waitForTimeout(500);
  let full = (await api('GET', `/api/contracts/${id}`)).body;
  eq('API: 1 document', full.documents.length, 1);
  const doc = full.documents[0];
  console.log('  contract doc fileName:', doc.fileName);
  ok('document name contrato_Joao_Acao_<numero> (accents transliterated, no "?")', /^contrato_Joao_Acao_/.test(doc.fileName) && /\.docx$/.test(doc.fileName), doc.fileName);
  ok('document listed on screen with that name', (await U.bodyText(page)).includes(doc.fileName));
  ok('document record has no filePath (client contract)', !('filePath' in doc), JSON.stringify(Object.keys(doc)));
  ok('file exists in storage/contracts', contractsDirFiles().length >= 1, contractsDirFiles().join(','));
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.getByRole('button', { name: 'Baixar' }).first().click()]);
  const f = await saveDownload(dl, 'u1_contrato.docx');
  console.log('  download suggested:', dl.suggestedFilename());
  eq('download filename = document fileName', dl.suggestedFilename(), doc.fileName);
  const txt = docxText(f);
  ok('downloaded docx filled (customer, contract number, installments)', /QAZ Cliente Teste/.test(txt) && txt.includes(full.number) && /Parcela 1/.test(txt), txt.slice(0, 300));
  // PDF
  const pdfP = page.waitForEvent('download', { timeout: 120000 });
  await page.getByRole('button', { name: 'PDF' }).first().click();
  const loading = await U.toast(page, /Gerando PDF|Convertendo/, 5000);
  ok('PDF: loading notification shown', loading);
  const pdf = await pdfP;
  const pf = await saveDownload(pdf, 'u1_contrato.pdf');
  ok('PDF: file is a PDF (%PDF)', fs.readFileSync(pf).subarray(0, 4).toString() === '%PDF', pdf.suggestedFilename());
  ok('PDF: filename .pdf same base name', pdf.suggestedFilename() === doc.fileName.replace(/\.docx$/, '.pdf'), pdf.suggestedFilename());
  await page.waitForTimeout(600);
  ok('PDF: loading notification gone', !(await U.toast(page, /Gerando PDF/, 600)));
  await L.shot(page, 'contrato_documento_gerado');
  // regenerate asks confirm
  S.dialogs.length = 0;
  await page.getByRole('button', { name: 'Gerar contrato' }).click();
  await U.toast(page, /Documento gerado/, 20000);
  ok('regenerate asks confirm (replaces file)', S.dialogs.some((m) => /substituir o arquivo existente/.test(m)), JSON.stringify(S.dialogs));
  full = (await api('GET', `/api/contracts/${id}`)).body;
  eq('still exactly 1 document after regenerate', full.documents.length, 1);
  // delete doc
  S.dialogs.length = 0;
  await page.getByTitle('Excluir documento').click();
  await page.waitForTimeout(900);
  ok('delete document asks confirm', S.dialogs.some((m) => /Excluir este documento/.test(m)), JSON.stringify(S.dialogs));
  full = (await api('GET', `/api/contracts/${id}`)).body;
  eq('API: 0 documents', full.documents.length, 0);
  eq('file removed from storage/contracts', contractsDirFiles().length, 0);
  ok('screen shows "Nenhum documento gerado."', /Nenhum documento gerado/.test(await U.bodyText(page)));
  // generated again for receipts later is unnecessary

  // installment actions: mark received + receipt
  await page.getByRole('button', { name: 'Marcar recebido' }).first().click();
  const d = U.dlg(page);
  await U.typeDate(d, 'Data de recebimento', '28/10/2026');
  await d.getByRole('button', { name: 'Confirmar' }).click();
  ok('toast Marcado como recebido', await U.toast(page, /Marcado como recebido/));
  await page.waitForTimeout(700);
  const p1 = (await api('GET', `/api/contracts/${id}`)).body.payments.find((p) => p.installmentNumber === 1);
  ok('API: installment 1 received 2026-10-28', p1.receiptStatus === 'received' && p1.receivedDate === '2026-10-28', JSON.stringify([p1.receiptStatus, p1.receivedDate]));
  const [rdl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), U.row(page, 'Parcela 1/4').getByRole('button', { name: 'Baixar' }).click()]);
  console.log('  installment receipt filename:', rdl.suggestedFilename());
  ok('receipt filename recibo_Joao_Acao_1-4.docx pattern', /^recibo_Joao_Acao_1-4\.docx$/.test(rdl.suggestedFilename()), rdl.suggestedFilename());
  const rf = await saveDownload(rdl, 'u1_recibo.docx');
  ok('receipt docx filled', /Recibo Jo/.test(docxText(rf)) && /175,00/.test(docxText(rf)), docxText(rf).slice(0, 200));
  await L.shot(page, 'contrato_pagamentos_recibo');

  // extra payment modal
  await page.getByRole('button', { name: 'Pagamento extra' }).click();
  const x = U.dlg(page);
  await x.getByLabel('Descrição').fill('QAZ-UI extra');
  await x.getByLabel('Valor (R$)').fill('77,5');
  ok('Adicionar disabled until Categoria chosen (mandatory)', await x.getByRole('button', { name: 'Adicionar' }).isDisabled());
  const xc = await U.optionsOf(page, x, 'Categoria');
  ok('extra payment Categoria options only "in" flow + alphabetical', U.isSorted(xc) && !xc.includes('QAZ Cat Out'), JSON.stringify(xc));
  await page.getByRole('option', { name: 'QAZ Cat In' }).click();
  const sitx = await U.optionsOf(page, x, 'Situação'); await U.closeDropdown(page);
  console.log('  extra payment Situação options:', JSON.stringify(sitx));
  ok('extra payment Situação labels follow Aberto/Recebido naming (Situação rule)', sitx.every((o) => ['Aberto', 'A pagar', 'Recebido', 'Enviado', 'Pago', 'Atrasado'].includes(o)), JSON.stringify(sitx));
  await U.pickDay(page, x, 'Vencimento', 18);
  const xv = await x.getByLabel('Vencimento').first().inputValue();
  ok('extra payment Vencimento picker shows dd/MM/yyyy', /^18\/\d{2}\/\d{4}$/.test(xv), xv);
  await L.shot(page, 'contrato_pagamento_extra_modal');
  await x.getByRole('button', { name: 'Adicionar' }).click();
  ok('toast Pagamento adicionado', await U.toast(page, /Pagamento adicionado/));
  await page.waitForTimeout(700);
  const full2 = (await api('GET', `/api/contracts/${id}`)).body;
  const ex = full2.payments.find((p) => p.description === 'QAZ-UI extra');
  ok('API: extra payment linked, no installmentNumber, category set, contract total unchanged', ex && ex.installmentNumber === null && ex.contractId === id && ex.categoryId === st.catIn.id && full2.total === full.total, JSON.stringify(ex));
  const exRow = sp(await U.row(page, 'QAZ-UI extra').innerText());
  ok('extra row shows R$ 77,50, entrada', /R\$\s?77,50/.test(exRow) && /entrada/i.test(exRow), exRow);
  // edit extra via shared PaymentFormModal
  await U.row(page, 'QAZ-UI extra').getByTitle('Editar pagamento').click();
  const e = U.dlg(page);
  await U.pickOption(page, e, 'Situação', 'Recebido');
  await e.getByRole('button', { name: 'Salvar' }).click();
  await U.toast(page, /Pagamento salvo/);
  await page.waitForTimeout(700);
  eq('API: extra now received', (await api('GET', `/api/contracts/${id}`)).body.payments.find((p) => p.description === 'QAZ-UI extra').receiptStatus, 'received');
  // remove extra
  await U.row(page, 'QAZ-UI extra').getByTitle('Remover pagamento').click();
  await page.waitForTimeout(800);
  ok('extra payment removed', !(await api('GET', `/api/contracts/${id}`)).body.payments.some((p) => p.description === 'QAZ-UI extra'));
  ok('installments have no remove button', (await U.row(page, 'Parcela 1/4').getByTitle('Remover pagamento').count()) === 0);
});

await S.flow('Contratos: editar contrato (modal) e excluir', async () => {
  const id = state2.U1;
  await U.go(page, '/contracts', 'Contratos');
  const numU = (await api('GET', `/api/contracts/${id}`)).body.number;
  await page.locator('tr').filter({ hasText: numU }).first().getByTitle('Editar').click();
  const d = U.dlg(page);
  await d.getByText(/Editar contrato #/).first().waitFor();
  await page.waitForTimeout(1200);
  const dv = await d.getByLabel('Data', { exact: true }).first().inputValue();
  eq('edit modal: Data loaded as dd/MM/yyyy', dv, '15/12/2026');
  const dues = await d.locator('table input[placeholder="dd/mm/aaaa"]').evaluateAll((els) => els.map((e) => e.value));
  ok('edit modal: installment dates loaded dd/MM/yyyy', dues.length === 4 && dues.every((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x)), JSON.stringify(dues));
  await L.shot(page, 'contrato_modal_editar');
  await d.getByLabel('Comentários').fill('QAZ comentário editado');
  await d.getByRole('button', { name: 'Salvar', exact: true }).click();
  ok('toast Contrato salvo (edit)', await U.toast(page, /Contrato salvo/));
  await page.waitForTimeout(700);
  eq('API: comments updated', (await api('GET', `/api/contracts/${id}`)).body.comments, 'QAZ comentário editado');
  // delete from list (native confirm)
  // a contract with a RECEIVED payment cannot be deleted (409): first the blocked attempt, then re-open the payment
  S.expectBad.push(/409 DELETE \/api\/contracts/);
  S.dialogs.length = 0;
  const rowU = page.locator('tr').filter({ hasText: (await api('GET', `/api/contracts/${id}`)).body.number }).first();
  await U.clearToasts(page);
  await rowU.getByTitle('Excluir').click();
  ok('UI: delete with a received payment is refused with the pt-BR message', await U.toast(page, /Não é possível excluir: já há pagamento\(s\) recebido\(s\)\/pago\(s\)/), JSON.stringify(await U.toastTexts(page)));
  eq('API: contract still exists after the refused delete', (await api('GET', `/api/contracts/${id}`)).status, 200);
  for (const p of (await api('GET', '/api/payments')).body.filter((p) => p.contractId === id && (p.receiptStatus !== 'open' || p.status === 'done'))) await api('PUT', `/api/payments/${p.id}`, { receiptStatus: 'open', receivedDate: null, status: 'upcoming', paidDate: null });
  S.dialogs.length = 0;
  await U.clearToasts(page);
  await rowU.getByTitle('Excluir').click();
  await page.waitForTimeout(900);
  ok('delete contract asks confirm', S.dialogs.some((m) => /Excluir este contrato/.test(m)), JSON.stringify(S.dialogs));
  eq('API: contract deleted (404)', (await api('GET', `/api/contracts/${id}`)).status, 404);
  const pl = (await api('GET', '/api/payments')).body.filter((p) => p.contractId === id);
  eq('its payments removed too', pl.length, 0);
  // restore the credit it consumed? (deleting contract may reinstate credit)
  const cr = (await api('GET', `/api/customers/${st.cu.id}/credits?all=1`)).body.find((c) => c.description === 'QAZ credito aberto');
  console.log('  credit remaining after contract delete:', cr && cr.remaining);
});

L.saveResults('r3.json'); L.saveEvents('e3.json');
await S.browser.close();

