import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start } from './harness.mjs';
const { api, ok } = L;

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

for (const [vname, vp] of [['mobile', { width: 375, height: 812 }], ['tablet', { width: 768, height: 1024 }]]) {
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
    L.known(`${vname}: no page-level horizontal scroll on any screen [KNOWN follow-up: App.tsx layout]`, overflow.length === 0, overflow.join(' ; '));
    // navigation reachable
    const nav = await page.getByRole('button', { name: /menu|navega|burger/i }).count();
    console.log(`  ${vname}: burger-like buttons:`, nav);
    // modals
    await U.go(page, '/payments', 'Fluxo de Caixa');
    await page.getByRole('button', { name: 'Novo pagamento' }).dispatchEvent('click'); // the side menu overlays the content at small widths
    let d = U.dlg(page);
    await d.getByLabel('Descrição').waitFor();
    const bb = await d.boundingBox();
    L.known(`${vname}: Novo pagamento modal fits viewport width`, bb && bb.x >= -1 && bb.x + bb.width <= vp.width + 1, JSON.stringify(bb));
    await L.shot(page, `resp_${vname}_modal_pagamento`);
    await d.getByText('Pagamento recorrente', { exact: true }).click();
    await U.typeDate(d, 'Repetir até', '28/02/2027');
    await L.shot(page, `resp_${vname}_modal_pagamento_recorrente`);
    await U.closeModal(page);
    await U.go(page, '/contracts', 'Contratos');
    await page.getByRole('button', { name: 'Novo contrato' }).dispatchEvent('click');
    d = U.dlg(page);
    await d.getByText('Novo contrato', { exact: true }).first().waitFor();
    const bb2 = await d.boundingBox();
    L.known(`${vname}: Novo contrato modal fits viewport width`, bb2 && bb2.x >= -1 && bb2.x + bb2.width <= vp.width + 1, JSON.stringify(bb2));
    await U.pickOption(page, d, 'Serviço (título do contrato)', 'QAZ Servico');
    await d.getByText(/Preço base/).waitFor();
    await L.shot(page, `resp_${vname}_modal_contrato`);
    await U.closeModal(page);
  });
  L.saveResults(`r8_${vname}.json`); L.saveEvents(`e8_${vname}.json`);
  L.results.splice(0);
  await S.browser.close();
}
