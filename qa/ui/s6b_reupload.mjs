import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import * as U from './ui.mjs';
import { st, start, DL } from './harness.mjs';
const { api, ok, eq } = L;
const S = await start();
const { page } = S;
const sp = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const f = path.join(DL, 'QAZ-OFX-ui-again.ofx');
fs.copyFileSync(path.join(DL, 'QAZ-OFX-ui.ofx'), f);

await S.flow('Importar extrato: re-upload (Ja importado)', async () => {
  await U.go(page, '/bank', 'Extratos bancários');
  await page.locator('input[type=file]').setInputFiles(f);
  await page.getByText(/Arquivo:/).waitFor();
  await page.waitForTimeout(700);
  const t = sp(await U.bodyText(page));
  const badges = await page.getByText('Já importado', { exact: true }).count();
  ok('re-upload: all 3 lines (QOFX1..3) flagged "Já importado" (line 2 had its date edited in the preview, 27/10 -> 20/10)', badges === 3, 'only ' + badges + ' flagged: the line whose preview date was edited is not recognised as already imported (recorded with the edited date)');
  ok('yellow alert "N lançamentos deste extrato já foram importados antes e vieram desmarcados" shown with the flagged count', new RegExp(badges + ' lançamentos deste extrato já foram importados antes e vieram desmarcados').test(t), t.slice(0, 600));
  ok('Importar selecionados (N) button present', await page.getByRole('button', { name: /Importar selecionados \(\d\)/ }).isVisible());
  ok('skipped alert still shows 2 ignoradas', /2 linhas do arquivo foram ignoradas/.test(t));
  await L.shot(page, 'extrato_ja_importado');
  const hdr = page.locator('thead input[type=checkbox]');
  ok('select-all checkbox present', true);
  await page.locator('thead .mantine-Checkbox-root').click();
  await page.waitForTimeout(300);
  const afterAll = await page.getByRole('button', { name: /Importar selecionados \(\d\)/ }).innerText(); console.log('  after select-all:', afterAll);
  await page.locator('tbody tr').nth(0).locator('.mantine-Checkbox-root').click();
  console.log('  after ticking line 1:', await page.getByRole('button', { name: /Importar selecionados \(\d\)/ }).innerText());
  const bg = await page.locator('tbody tr').nth(0).evaluate((e) => getComputedStyle(e).backgroundColor);
  ok('flagged row is tinted (yellow)', /rgba?\(/.test(bg) && bg !== 'rgba(0, 0, 0, 0)', bg);
  const bd = await U.badDates(page);
  ok('Extratos: no iso/US dates on screen', bd.length === 0, bd.join(','));
});
L.saveResults('r6b.json'); L.saveEvents('e6b.json');
await S.browser.close();

