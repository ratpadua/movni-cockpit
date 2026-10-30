import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start } from './harness.mjs';
const { api, ok, eq } = L;

const pages = [
  ['painel', '/', 'Painel'],
  ['fluxo', '/payments', 'Fluxo de Caixa'],
  ['contratos', '/contracts', 'Contratos'],
  ['contrato_unico', `/contracts/${st.C1.id}`, null],
  ['contrato_recorrente', `/contracts/${st.R1.id}`, null],
  ['clientes', '/customers', 'Clientes'],
  ['cliente_detalhe', `/customers/${st.cu.id}`, null],
  ['servicos', '/services', 'Serviços'],
  ['categorias', '/categories', 'Categorias'],
  ['modelos', '/templates', 'Modelos de documentos'],
  ['extratos', '/bank', 'Extratos bancários'],
  ['relatorios', '/reports', 'Relatórios'],
  ['config', '/settings', 'Aparência'],
];

for (const [vname, vp] of [['mobile', { width: 375, height: 812 }], ['tablet', { width: 768, height: 1024 }], ['edge991', { width: 991, height: 800 }], ['desktop992', { width: 992, height: 800 }]]) {
  const S = await start(vp);
  const { page } = S;
  await S.flow(`Responsivo ${vname} ${vp.width}x${vp.height}`, async () => {
    const overflow = [];
    for (const [name, url, heading] of pages) {
      await U.go(page, url, heading || undefined);
      await page.waitForTimeout(700);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth, txt: document.body.innerText.length }));
      const bad = m.sw > m.cw + 1;
      if (bad) overflow.push(`${name}: scrollWidth ${m.sw} > ${m.cw}`);
      ok(`${vname}: ${name} renders (not blank) `, m.txt > 100, `text length ${m.txt}`);
      await L.shot(page, `resp_${vname}_${name}`);
    }
    ok(`${vname}: no page-level horizontal scroll on any screen`, overflow.length === 0, overflow.join(' ; '));
    // navigation: burger + drawer below 992px, fixed side menu from 992px
    const burgerOn = vp.width < 992;
    // a closed drawer is translated off-screen (still 'visible' for the DOM), so test the bounding box against the viewport
    const inView = async (name) => page.getByRole('link', { name, exact: true }).evaluate((e) => { const r = e.getBoundingClientRect(); return r.right > 0 && r.left < window.innerWidth && r.width > 0; });
    await U.go(page, '/payments', 'Fluxo de Caixa');
    const burger = page.getByRole('button', { name: 'Abrir menu' });
    if (burgerOn) {
      ok(`${vname}: burger "Abrir menu" is visible below 992px`, await burger.isVisible());
      const covered = await page.evaluate(() => { const m = document.querySelector('main'); const r = m.getBoundingClientRect(); const el = document.elementFromPoint(r.left + 20, r.top + 60); return !!el && !!el.closest('nav'); });
      ok(`${vname}: menu closed by default and does not cover the content`, !covered && !(await inView('Contratos')));
      await burger.click();
      await page.waitForFunction(() => { const a = [...document.querySelectorAll('a')].find((x) => x.textContent.trim() === 'Contratos'); if (!a) return false; const r = a.getBoundingClientRect(); return r.right > 0 && r.left < window.innerWidth; }, null, { timeout: 5000 });
      ok(`${vname}: burger opens the drawer (nav links visible)`, await inView('Contratos'));
      await page.waitForTimeout(500); // let the slide-in finish
      await L.shot(page, `resp_${vname}_menu_aberto`);
      await page.getByRole('link', { name: 'Contratos', exact: true }).click();
      await page.waitForURL(/\/contracts$/);
      await page.getByRole('button', { name: 'Abrir menu' }).waitFor({ timeout: 5000 });
      await page.waitForTimeout(400);
      ok(`${vname}: drawer closes after navigating`, !(await page.getByRole('link', { name: 'Clientes', exact: true }).evaluate((e) => { const r = e.getBoundingClientRect(); return r.right > 0 && r.left < window.innerWidth; })) && (await page.getByRole('heading', { name: 'Contratos' }).first().isVisible()));
    } else {
      eq(`${vname}: no burger from 992px up`, await burger.count(), 0);
      ok(`${vname}: side menu visible from 992px up`, await page.getByRole('link', { name: 'Clientes', exact: true }).isVisible());
    }
    const nav = await page.getByRole('button', { name: /menu|navega|burger/i }).count();
    console.log(`  ${vname}: burger-like buttons:`, nav);
    // modals
    await U.go(page, '/payments', 'Fluxo de Caixa');
    await page.getByRole('button', { name: 'Novo pagamento' }).click(); // a normal click: the menu no longer overlays the content
    let d = U.dlg(page);
    await d.getByLabel('Descrição').waitFor();
    const bb = await d.boundingBox();
    ok(`${vname}: Novo pagamento modal fits viewport width`, bb && bb.x >= -1 && bb.x + bb.width <= vp.width + 1, JSON.stringify(bb));
    await L.shot(page, `resp_${vname}_modal_pagamento`);
    await d.getByText('Pagamento recorrente', { exact: true }).click();
    await U.typeDate(d, 'Repetir até', '28/02/2027');
    await L.shot(page, `resp_${vname}_modal_pagamento_recorrente`);
    await U.closeModal(page);
    await U.go(page, '/contracts', 'Contratos');
    await page.getByRole('button', { name: 'Novo contrato' }).click();
    d = U.dlg(page);
    await d.getByText('Novo contrato', { exact: true }).first().waitFor();
    const bb2 = await d.boundingBox();
    ok(`${vname}: Novo contrato modal fits viewport width`, bb2 && bb2.x >= -1 && bb2.x + bb2.width <= vp.width + 1, JSON.stringify(bb2));
    await U.pickOption(page, d, 'Serviço (título do contrato)', 'QAZ Servico');
    await d.getByText(/Preço base/).waitFor();
    await L.shot(page, `resp_${vname}_modal_contrato`);
    await U.closeModal(page);
  });
  L.saveResults(`r8_${vname}.json`); L.saveEvents(`e8_${vname}.json`);
  L.results.splice(0);
  await S.browser.close();
}
