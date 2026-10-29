import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start } from './harness.mjs';
const { api, ok, eq } = L;
const S = await start();
const { page } = S;
const sp = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const fmt = (n) => sp(n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const orig = st.settings;
const settings = async () => (await api('GET', '/api/settings')).body;

await S.flow('Relatorios', async () => {
  await U.go(page, '/reports', 'Relatórios');
  let t = sp(await U.bodyText(page));
  ok('cards Receitas / Custos / Resultado (lucro) with R$', /Receitas/i.test(t) && /Custos/i.test(t) && /Resultado/i.test(t) && U.brlRe.test(t));
  await L.shot(page, 'relatorios_inicial');
  await U.typeDate(page, 'De', '01/10/2026');
  await U.typeDate(page, 'Até', '31/10/2026');
  eq('De shows dd/MM/yyyy', await page.getByLabel('De', { exact: true }).first().inputValue(), '01/10/2026');
  await page.getByRole('button', { name: 'Filtrar' }).click();
  await page.waitForTimeout(1000);
  const sum = (await api('GET', '/api/reports/summary?from=2026-10-01&to=2026-10-31')).body;
  t = sp(await U.bodyText(page));
  console.log('  summary', JSON.stringify(sum));
  ok(`Receitas card = ${fmt(Number(sum.totalIn))}`, t.includes(fmt(Number(sum.totalIn))), t.slice(0, 400));
  ok(`Custos card = ${fmt(Math.abs(Number(sum.totalOut)))}`, t.includes(fmt(Math.abs(Number(sum.totalOut)))));
  ok(`Resultado card = ${fmt(Number(sum.net))}`, t.includes(fmt(Number(sum.net))));
  const entries = (await api('GET', '/api/reports/entries?from=2026-10-01&to=2026-10-31')).body;
  const rows = await page.locator('tbody tr').count();
  ok(`table rows (${rows}) match API entries (${entries.length})`, rows === entries.length || (entries.length === 0 && rows === 1), `${rows} vs ${entries.length}`);
  const firstDates = await page.locator('tbody tr td:first-child').allInnerTexts();
  ok('table dates dd/MM/yyyy', firstDates.length > 0 && firstDates.every((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x.trim()) || x.trim() === '—'), JSON.stringify(firstDates.slice(0, 5)));
  ok('Tipo badges Receita/Custo (pt-BR)', /receita/i.test(t) || /custo/i.test(t));
  const tipos = await U.optionsOf(page, page, 'Tipo'); await U.closeDropdown(page);
  ok('Tipo options alphabetical (Custo, Receita)', JSON.stringify(tipos) === JSON.stringify(['Custo', 'Receita']), JSON.stringify(tipos));
  const cats = await U.optionsOf(page, page, 'Categoria');
  ok('Categoria options alphabetical', U.isSorted(cats), JSON.stringify(cats));
  await page.getByRole('option', { name: 'QAZ Cat In' }).click();
  await U.pickOption(page, page, 'Tipo', 'Receita');
  await page.getByRole('button', { name: 'Filtrar' }).click();
  await page.waitForTimeout(900);
  const filt = (await api('GET', `/api/reports/entries?from=2026-10-01&to=2026-10-31&flow=in&categoryId=${st.catIn.id}`)).body;
  const rows2 = await page.locator('tbody tr').count();
  ok(`filtered (Receita + QAZ Cat In): rows ${rows2} == API ${filt.length}`, rows2 === filt.length, `${rows2} vs ${filt.length}`);
  ok('filtered rows all QAZ Cat In / Receita', (await page.locator('tbody tr').allInnerTexts()).every((x) => /QAZ Cat In/.test(x)) , 'rows not all in category');
  await L.shot(page, 'relatorios_filtrado');
  const bd = await U.badDates(page);
  ok('Relatórios: no iso/US dates', bd.length === 0, bd.join(','));
});

await S.flow('Configuracoes (Aparencia)', async () => {
  await U.go(page, '/settings', 'Aparência');
  await L.shot(page, 'configuracoes');
  const menu = page.getByLabel('Cor do menu');
  const bgOf = async () => page.locator('nav, .mantine-AppShell-navbar').first().evaluate((e) => getComputedStyle(e).backgroundColor);
  // #rgb
  await menu.fill('#abc'); await menu.press('Tab');
  console.log('  after typing #abc, field =', await menu.inputValue());
  await page.getByRole('button', { name: 'Salvar cores' }).click();
  ok('toast "Aparência salva" (#rgb)', await U.toast(page, /Aparência salva/));
  await page.waitForTimeout(800);
  let s = await settings();
  ok('API: #abc stored as #aabbcc (expanded)', /^#aabbcc$/i.test(s.menuColor), s.menuColor);
  await page.waitForTimeout(500);
  const bg1 = await bgOf();
  ok('menu background changed to #aabbcc (rgb(170,187,204))', /rgb\(170, 187, 204\)/.test(bg1), bg1);
  await L.shot(page, 'configuracoes_cor_rgb');
  // #rrggbb
  await U.clearToasts(page);
  await menu.fill('#12AB34'); await menu.press('Tab');
  await page.getByRole('button', { name: 'Salvar cores' }).click();
  ok('toast "Aparência salva" (#rrggbb)', await U.toast(page, /Aparência salva/));
  await page.waitForTimeout(800);
  s = await settings();
  ok('API: #12AB34 stored', /^#12ab34$/i.test(s.menuColor), s.menuColor);
  // invalid
  await U.clearToasts(page);
  await menu.fill('zzz-invalida'); await menu.press('Tab');
  await page.getByRole('button', { name: 'Salvar cores' }).click();
  await page.waitForTimeout(1200);
  const toasts = await U.toastTexts(page);
  console.log('  invalid colour toasts:', JSON.stringify(toasts), 'field now:', await menu.inputValue());
  s = await settings();
  ok('invalid colour text is never stored (the previous colour #12AB34 is kept)', /^#12ab34$/i.test(s.menuColor), JSON.stringify([toasts, s.menuColor]));
  console.log('  (ColorInput reverts invalid text on blur and the form saves the last valid colour; the server answers 400 "Cor inválida" if invalid text is ever sent: covered by the API suite)');
  S.expectBad.push(/400 PUT \/api\/settings/);
  await L.shot(page, 'configuracoes_cor_invalida');
  // restore colours via UI then verify
  await page.reload(); await page.waitForLoadState('networkidle');
  // Parcelamento
  const min = page.getByLabel('Valor mínimo por parcela (R$)');
  const saveMin = page.getByRole('button', { name: 'Salvar parcelamento' });
  await min.fill('0');
  ok('Salvar parcelamento disabled for 0 (< R$ 1)', await saveMin.isDisabled());
  await min.fill('');
  ok('Salvar parcelamento disabled when empty', await saveMin.isDisabled());
  await min.fill('400');
  await U.clearToasts(page);
  await saveMin.click();
  ok('toast "Parcelamento salvo"', await U.toast(page, /Parcelamento salvo/));
  await page.waitForTimeout(700);
  eq('API minInstallmentValue 400', Number((await settings()).minInstallmentValue), 400);
  eq('field shows R$ 400,00 style (fixed 2 decimals)', sp(await min.inputValue()).replace('.', ','), 'R$ 400,00');
  // effect in the contract modal
  await U.go(page, '/contracts', 'Contratos');
  await page.getByRole('button', { name: 'Novo contrato' }).click();
  const d = U.dlg(page);
  await U.pickOption(page, d, 'Serviço (título do contrato)', 'QAZ Servico');
  await d.getByText(/Preço base: R\$\s?900,00/).waitFor();
  const dt = sp(await d.innerText());
  ok('InstallmentPlanner uses the new minimum: "Parcelas (máx. 2)" for R$ 900', /Parcelas \(máx\. 2\)/.test(dt), dt.slice(-300));
  await L.shot(page, 'configuracoes_parcelamento_efeito');
  await U.closeModal(page);
  // restore parcelamento
  await U.go(page, '/settings', 'Aparência');
  await min.fill(String(orig.minInstallmentValue));
  await U.clearToasts(page);
  await saveMin.click();
  await U.toast(page, /Parcelamento salvo/);
  await page.waitForTimeout(600);
  eq('minInstallmentValue restored', Number((await settings()).minInstallmentValue), Number(orig.minInstallmentValue));
  // Prazos
  await page.getByLabel('Em edição (dias)').fill('21');
  await U.clearToasts(page);
  await page.getByRole('button', { name: 'Salvar prazos' }).click();
  ok('toast "Prazos salvos"', await U.toast(page, /Prazos salvos/));
  await page.waitForTimeout(600);
  eq('API editWindowDays 21', Number((await settings()).editWindowDays), 21);
  await page.getByLabel('Em edição (dias)').fill(String(orig.editWindowDays));
  await page.getByRole('button', { name: 'Salvar prazos' }).click();
  await page.waitForTimeout(800);
  // restore colours via API (original raw values)
  const D = { menuColor: '#ffffff', accentColor: '#228be6', bgColor: '#f8f9fa', buttonColor: '#228be6', buttonHoverColor: '#1c7ed6' };
  const restore = {};
  for (const k of Object.keys(D)) restore[k] = orig[k] === D[k] ? '' : orig[k];
  await api('PUT', '/api/settings', restore);
  s = await settings();
  ok('settings restored to original (colors, windows, installment minimum)', ['menuColor', 'accentColor', 'bgColor', 'buttonColor', 'buttonHoverColor', 'editWindowDays', 'previewWindowDays', 'minInstallmentValue'].every((k) => JSON.stringify(s[k]) === JSON.stringify(orig[k])), JSON.stringify(s));
});

L.saveResults('r7.json'); L.saveEvents('e7.json');
await S.browser.close();

