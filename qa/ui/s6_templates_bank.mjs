import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start, DL } from './harness.mjs';
const { api, ok, eq } = L;
const S = await start();
const { page } = S;
const today = L.localToday();
const sp = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const tpls = async () => (await api('GET', '/api/templates')).body;

await S.flow('Modelos: upload, painel de tags, substituir, excluir', async () => {
  await U.go(page, '/templates', 'Modelos de documentos');
  let t = sp(await U.bodyText(page));
  ok('3 sections (Contrato, Fatura, Recibo) and QAZ models listed with file names', /Modelos de Contrato/.test(t) && /Modelos de Fatura/.test(t) && /Modelos de Recibo/.test(t) && /QAZ Modelo Contrato/.test(t) && /Modelo João Ação\.docx/.test(t));
  ok('tag reference panel visible ("Campos disponíveis no modelo" + {customer_name})', /Campos disponíveis no modelo/.test(t) && /\{customer_name\}/.test(t));
  ok('contract tags: {total_before_credit}, {#installments}…', /\{total_before_credit\}/.test(t) && /\{date_short\}/.test(t));
  await L.shot(page, 'modelos_lista');
  const kinds = await U.optionsOf(page, page, 'Tipo de documento'); await U.closeDropdown(page);
  ok('Tipo de documento options alphabetical (Contrato, Fatura, Recibo)', JSON.stringify(kinds) === JSON.stringify(['Contrato', 'Fatura', 'Recibo']), JSON.stringify(kinds));
  await U.pickOption(page, page, 'Tipo de documento', 'Recibo');
  t = sp(await U.bodyText(page));
  ok('Recibo tags: {amount_left}, {installment}, {invoice_number}', /\{amount_left\}/.test(t) && /\{installment\}/.test(t) && /\{invoice_number\}/.test(t));
  await U.pickOption(page, page, 'Tipo de documento', 'Fatura');
  t = sp(await U.bodyText(page));
  ok('Fatura tags: {#items_summary}, {invoice_reference}', /items_summary/.test(t) && /\{invoice_reference\}/.test(t));
  await L.shot(page, 'modelos_tags_fatura');
  // upload
  const addBtn = page.locator('div').filter({ hasText: /^Modelos de Contrato/ }).first();
  await page.getByRole('button', { name: 'Adicionar' }).first().click();
  let d = U.dlg(page);
  await d.getByText('Adicionar modelo de contrato').waitFor();
  ok('Adicionar disabled with no name/file', await d.getByRole('button', { name: 'Adicionar', exact: true }).isDisabled());
  await d.getByLabel(/Nome do modelo/).fill('QAZ UI Modelo');
  await d.locator('input[type=file]').setInputFiles({ name: 'Modelo UI João.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: L.buildDocx(['Contrato {contract_number} {customer_name}']) });
  await d.getByText('Modelo UI João.docx').waitFor();
  await L.shot(page, 'modelos_modal_upload');
  await d.getByRole('button', { name: 'Adicionar', exact: true }).click();
  ok('toast "Modelo adicionado"', await U.toast(page, /Modelo adicionado/));
  await page.waitForTimeout(600);
  const mine = (await tpls()).find((x) => x.name === 'QAZ UI Modelo');
  ok('API: template stored (kind contract, fileName with accent)', mine && mine.kind === 'contract' && mine.fileName === 'Modelo UI João.docx', JSON.stringify(mine));
  ok('list shows new template', (await U.bodyText(page)).includes('QAZ UI Modelo'));
  // invalid file
  await U.clearToasts(page);
  await page.getByRole('button', { name: 'Adicionar' }).first().click();
  d = U.dlg(page);
  await d.getByLabel(/Nome do modelo/).fill('QAZ UI Modelo Invalido');
  await d.locator('input[type=file]').setInputFiles({ name: 'ruim.docx', mimeType: 'application/octet-stream', buffer: Buffer.from('isto nao e um docx') });
  await d.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await page.waitForTimeout(1200);
  let toasts = await U.toastTexts(page);
  console.log('  invalid upload toasts:', JSON.stringify(toasts));
  ok('invalid docx: error shown ("Falha no envio" + message) and not stored', toasts.some((x) => /Falha no envio/.test(x)) && !(await tpls()).some((x) => x.name === 'QAZ UI Modelo Invalido'), JSON.stringify(toasts));
  S.expectBad.push(/400 POST \/api\/templates/);
  await L.shot(page, 'modelos_upload_invalido');
  await U.closeModal(page);
  // download (accented name)
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), U.row(page, 'QAZ UI Modelo').getByTitle('Baixar').click()]);
  console.log('  template download name:', dl.suggestedFilename());
  ok('template download keeps the real file name (accents intact)', dl.suggestedFilename() === 'Modelo UI João.docx', dl.suggestedFilename());
  // replace
  await U.row(page, 'QAZ UI Modelo').getByTitle(/Substituir/).click();
  d = U.dlg(page);
  await d.getByText(/Substituir modelo — QAZ UI Modelo/).waitFor();
  ok('Substituir disabled until a file is chosen', await d.getByRole('button', { name: 'Substituir', exact: true }).isDisabled());
  await d.locator('input[type=file]').setInputFiles({ name: 'Novo Modelo.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: L.buildDocx(['NOVO {contract_number}']) });
  await L.shot(page, 'modelos_modal_substituir');
  await d.getByRole('button', { name: 'Substituir', exact: true }).click();
  ok('toast "Modelo substituído"', await U.toast(page, /Modelo substituído/));
  await page.waitForTimeout(600);
  const mine2 = (await tpls()).find((x) => x.name === 'QAZ UI Modelo');
  ok('API: same id, new fileName', mine2 && mine2.id === mine.id && mine2.fileName === 'Novo Modelo.docx', JSON.stringify(mine2));
  // delete in use -> blocked
  await U.clearToasts(page);
  S.dialogs.length = 0;
  await U.row(page, 'QAZ Modelo Contrato').getByTitle('Excluir').click();
  await page.waitForTimeout(1200);
  toasts = await U.toastTexts(page);
  console.log('  delete in-use toasts:', JSON.stringify(toasts), 'dialogs', JSON.stringify(S.dialogs));
  ok('delete in-use template shows blocking message (pt-BR) and keeps it', toasts.length > 0 && /uso|Substituir|vinculad|utiliz/i.test(toasts.join(' ')) && (await tpls()).some((x) => x.id === st.tC.id), JSON.stringify(toasts));
  ok('confirm text mentions model name', S.dialogs.some((m) => /Excluir o modelo "QAZ Modelo Contrato"/.test(m)), JSON.stringify(S.dialogs));
  S.expectBad.push(/(400|409) DELETE \/api\/templates/);
  await L.shot(page, 'modelos_excluir_em_uso');
  // delete unused
  await U.clearToasts(page);
  await U.row(page, 'QAZ UI Modelo').getByTitle('Excluir').click();
  ok('toast "Modelo excluído" for unused template', await U.toast(page, /Modelo excluído/));
  await page.waitForTimeout(500);
  ok('API: template deleted', !(await tpls()).some((x) => x.name === 'QAZ UI Modelo'));
});

await S.flow('Importar extrato (OFX)', async () => {
  for (const p of (await api('GET', '/api/payments')).body.filter((x) => /^QAZ-OFX/.test(x.description))) await api('DELETE', `/api/payments/${p.id}`);
  const target = (await api('POST', '/api/payments', { description: 'QAZ-OFX alvo', amount: '321.45', flow: 'in', dueDate: L.addDays(today, 3), customerId: st.cu.id })).body;
  const stm = (extra) => `OFXHEADER:100\r\nDATA:OFXSGML\r\n\r\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>0001<ACCTID>QAZ-ACCT</BANKACCTFROM><BANKTRANLIST>${extra}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const trn = (o) => `<STMTTRN><TRNTYPE>${o.type || 'CREDIT'}<DTPOSTED>${o.date || '20261028120000[-3:BRT]'}<TRNAMT>${o.amt}<FITID>${o.fit}<NAME>${o.name}<MEMO>${o.memo}</STMTTRN>`;
  const ofx = stm([
    trn({ fit: 'QOFX1', amt: '321.45', name: 'PIX Joao Acao', memo: 'QAZ-OFX credito alvo' }),
    trn({ fit: 'QOFX2', amt: '-45.50', type: 'DEBIT', date: '20261027120000[-3:BRT]', name: 'Compra', memo: 'QAZ-OFX debito' }),
    trn({ fit: 'QOFX3', amt: '99.90', date: '20261026120000[-3:BRT]', name: 'PIX Extra', memo: 'QAZ-OFX extra contrato' }),
    trn({ fit: 'QOFXB1', amt: '1,234', name: 'ambiguo', memo: 'QAZ-OFX ambiguo' }),
    trn({ fit: 'QOFXB2', amt: 'abc', name: 'ruim', memo: 'QAZ-OFX valor ruim' }),
  ].join(''));
  const f = path.join(DL, 'QAZ-OFX-ui.ofx');
  fs.writeFileSync(f, ofx, 'latin1');
  const sql = await L.sqlConnect();
  const impCount = async () => Number((await sql.query("select count(*) c from bank_imports where file_name like 'QAZ%'"))[0][0].c);

  await U.go(page, '/bank', 'Extratos bancários');
  let t = sp(await U.bodyText(page));
  ok('empty state explains the OFX flow', /Carregue um arquivo/.test(t));
  await L.shot(page, 'extrato_vazio');
  await page.locator('input[type=file]').setInputFiles(f);
  ok('parse notification shows skipped count ("3 lançamentos lidos · 2 ignorado(s) por valor inválido")', await U.toast(page, /3 lançamentos lidos · 2 ignorado\(s\) por valor inválido/));
  await page.getByText(/Arquivo:/).waitFor();
  t = sp(await U.bodyText(page));
  ok('skipped alert: "2 linhas do arquivo foram ignoradas porque o valor não pôde ser lido."', /2 linhas do arquivo foram ignoradas porque o valor não pôde ser lido\./.test(t), t.slice(0, 500));
  ok('header shows file, Banco 0001, Conta QAZ-ACCT', /QAZ-OFX-ui\.ofx/.test(t) && /Banco 0001/.test(t) && /Conta QAZ-ACCT/.test(t));
  ok('"Importar selecionados (3)" (all new lines pre-selected)', await page.getByRole('button', { name: 'Importar selecionados (3)' }).isVisible());
  await L.shot(page, 'extrato_preview');
  const dates = await page.locator('tbody input[placeholder="dd/mm/aaaa"]').evaluateAll((els) => els.map((e) => e.value));
  ok('preview dates dd/MM/yyyy (28/10, 27/10, 26/10/2026)', JSON.stringify(dates) === JSON.stringify(['28/10/2026', '27/10/2026', '26/10/2026']), JSON.stringify(dates));
  const r1 = page.locator('tbody tr').nth(0), r2 = page.locator('tbody tr').nth(1), r3 = page.locator('tbody tr').nth(2);
  const descs = await page.locator('tbody tr td:nth-child(4) input').evaluateAll((els) => els.map((e) => e.value));
  console.log('  preview descriptions:', JSON.stringify(descs));
  ok('preview descriptions from MEMO', descs.join('|').includes('QAZ-OFX credito alvo') && descs.join('|').includes('QAZ-OFX debito'), JSON.stringify(descs));
  const amts = await page.locator('tbody tr td:nth-child(5) input').evaluateAll((els) => els.map((e) => e.value));
  console.log('  preview amounts:', JSON.stringify(amts));
  ok('preview amounts shown (money) 321.45 / -45.50 / 99.90', amts.length === 3 && /321/.test(amts[0]) && /45/.test(amts[1]) && /99/.test(amts[2]), JSON.stringify(amts));
  ok('amount inputs use pt-BR decimal comma (R$ 1.234,56 style)', amts.every((a) => /,\d{2}$/.test(a) || !/\./.test(a.replace(/\.\d{3}/g, ''))), 'amount inputs display with a dot decimal separator: ' + JSON.stringify(amts));
  // Referência select (income rows) grouped + alphabetical inside groups
  const ref1 = r1.locator('td').nth(6).locator('input').first();
  await ref1.click();
  const opts = (await page.getByRole('option').allInnerTexts()).map((x) => x.trim());
  console.log('  Referência options (first 6):', JSON.stringify(opts.slice(0, 6)));
  const target1 = opts.find((x) => /QAZ-OFX alvo/.test(x));
  ok('Referência dropdown lists the open entrada "QAZ-OFX alvo"', !!target1, JSON.stringify(opts));
  const cur = await ref1.inputValue();
  if (!cur) { await page.getByRole('option', { name: /QAZ-OFX alvo/ }).first().click(); } else { await U.closeDropdown(page); }
  console.log('  line 1 Referência value:', cur || '(picked manually)');
  await L.shot(page, 'extrato_referencia');
  // edit preview: description + category (alphabetical) + date picker
  const d1 = r1.locator('td').nth(3).locator('input').first();
  await d1.fill('QAZ-OFX credito conciliado');
  const catI = r2.locator('td').nth(5).locator('input').first();
  await catI.click();
  const cats = (await page.getByRole('option').allInnerTexts()).map((x) => x.trim());
  ok('preview Categoria options alphabetical', U.isSorted(cats), JSON.stringify(cats));
  await page.getByRole('option', { name: 'QAZ Cat Out' }).click();
  // edit date of line 2 via the calendar (pick day 27 of displayed month)
  const dateInput2 = r2.locator('input[placeholder="dd/mm/aaaa"]');
  await dateInput2.click();
  await page.locator('.mantine-Popover-dropdown button.mantine-DateInput-day:not([data-outside])').filter({ visible: true }).filter({ hasText: /^20$/ }).last().click();
  eq('line 2 date picked 20/10/2026', await dateInput2.inputValue(), '20/10/2026');
  // line 3: extra contract without category -> error + toast
  const ctr = r3.locator('td').nth(7).locator('input').first();
  await ctr.click();
  const contractOpts = (await page.getByRole('option').allInnerTexts()).map((x) => x.trim());
  ok('Contrato (extra) options alphabetical', U.isSorted(contractOpts), JSON.stringify(contractOpts));
  await page.getByRole('option', { name: new RegExp(st.C1.number) }).first().click();
  await page.waitForTimeout(300);
  ok('"Categoria obrigatória" shown on the contract select', /Categoria obrigatória/.test(await r3.innerText()), await r3.innerText());
  await U.clearToasts(page);
  await page.getByRole('button', { name: /Importar selecionados/ }).click();
  ok('import blocked with message about mandatory category', await U.toast(page, /Selecione uma categoria para os lançamentos associados a um contrato/));
  eq('no bank_imports recorded on blocked import', await impCount(), 0);
  await L.shot(page, 'extrato_categoria_obrigatoria');
  await r3.locator('td').nth(5).locator('input').first().click();
  await page.getByRole('option', { name: 'QAZ Cat In' }).click();
  ok('error disappears once category chosen', !/Categoria obrigatória/.test(await r3.innerText()));
  // untick select-all/uncheck behavior: uncheck line 2 then re-check
  const cb2 = r2.locator('input[type=checkbox]');
  await r2.locator('label, .mantine-Checkbox-root').first().click().catch(() => {});
  const sel = await page.getByRole('button', { name: /Importar selecionados/ }).innerText();
  console.log('  after toggling line 2:', sp(sel));
  await r2.locator('label, .mantine-Checkbox-root').first().click().catch(() => {});
  await U.clearToasts(page);
  await page.getByRole('button', { name: 'Importar selecionados (3)' }).click();
  ok('import result toast "1 conciliado(s) · 2 criado(s)"', await U.toast(page, /1 conciliado\(s\) · 2 criado\(s\)/, 12000));
  await page.waitForTimeout(800);
  const pays = (await api('GET', '/api/payments')).body;
  const tg = pays.find((p) => p.id === target.id);
  ok('API: open entrada reconciled (received, receivedDate 2026-10-28)', tg.receiptStatus === 'received' && tg.receivedDate === '2026-10-28', JSON.stringify([tg.receiptStatus, tg.receivedDate]));
  const deb = pays.find((p) => p.description === 'QAZ-OFX debito');
  ok('API: saída created paid with edited date 2026-10-20 and category QAZ Cat Out, amount 45.50', deb && deb.flow === 'out' && deb.status === 'done' && deb.paidDate === '2026-10-20' && Number(deb.amount) === 45.5 && deb.categoryId !== null, JSON.stringify(deb));
  const ext = pays.find((p) => p.description === 'QAZ-OFX extra contrato');
  ok('API: extra payment linked to contract, no installment number, category set', ext && ext.contractId === st.C1.id && ext.installmentNumber === null && ext.categoryId === st.catIn.id, JSON.stringify(ext));
  eq('bank_imports recorded (1)', await impCount(), 1);
  ok('UI reset after import (preview gone, empty-state alert back)', /Carregue um arquivo/.test(await U.bodyText(page)));
  await L.shot(page, 'extrato_apos_importar');
  // re-upload -> Já importado. (The file input still holds the previous file and a browser fires no change event when the
  // same file is picked again, so clear it first. Product note: FileButton has no resetRef.)
  await page.locator('input[type=file]').setInputFiles([]);
  await page.locator('input[type=file]').setInputFiles(f);
  await page.getByText(/Arquivo:/).waitFor();
  await page.waitForTimeout(600);
  t = sp(await U.bodyText(page));
  const badges = await page.getByText('Já importado', { exact: true }).count();
  eq('3 "Já importado" badges on re-upload', badges, 3);
  ok('yellow alert "3 lançamentos deste extrato já foram importados antes e vieram desmarcados"', /3 lançamentos deste extrato já foram importados antes e vieram desmarcados/.test(t), t.slice(0, 600));
  ok('Importar selecionados (0) disabled', await page.getByRole('button', { name: 'Importar selecionados (0)' }).isDisabled());
  ok('skipped alert still shows 2 ignoradas', /2 linhas do arquivo foram ignoradas/.test(t));
  await L.shot(page, 'extrato_ja_importado');
  const hdr = page.locator('thead input[type=checkbox]');
  ok('select-all stays unchecked while all lines are flagged', !(await hdr.isChecked()));
  await hdr.check({ force: true }).catch(() => {});
  await page.waitForTimeout(300);
  ok('select-all skips flagged lines (still 0 selected)', await page.getByRole('button', { name: 'Importar selecionados (0)' }).isVisible());
  await page.locator('tbody tr').nth(0).locator('.mantine-Checkbox-root').click();
  ok('ticking a flagged line manually selects it (1)', await page.getByRole('button', { name: 'Importar selecionados (1)' }).isVisible());
  const bd = await U.badDates(page);
  ok('Extratos: no iso/US dates on screen', bd.length === 0, bd.join(','));
  await sql.end();
});

L.saveResults('r6.json'); L.saveEvents('e6.json');
await S.browser.close();

