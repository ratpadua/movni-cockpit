import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
import * as U from './ui.mjs';

export const st = JSON.parse(fs.readFileSync(path.join(L.QA, 'state.json'), 'utf8'));
export const DL = path.join(L.QA, 'dl');
fs.mkdirSync(DL, { recursive: true });

export async function start(viewport) {
  await L.login();
  const S = await L.newSession(viewport);
  S.expectBad = [];
  S.flow = async (name, fn) => {
    L.setFlow(name);
    try { await fn(); } catch (e) {
      L.ok(`${name}: no exception`, false, (e.stack || e.message).split('\n').slice(0, 4).join(' | '));
      await L.shot(S.page, 'FAIL_' + name);
    }
    const e = L.drain(S.ev, name);
    const consoleErrs = S.expectBad.length ? e.console.filter((x) => !/Failed to load resource/.test(x)) : e.console;
    L.ok(`${name}: no console errors / pageerrors`, consoleErrs.length === 0 && e.pageerrors.length === 0, JSON.stringify([...consoleErrs, ...e.pageerrors]));
    const unexpected = e.bad.filter((x) => !S.expectBad.some((re) => re.test(x)));
    L.ok(`${name}: no unexpected 4xx/5xx`, unexpected.length === 0, unexpected.join(' ; '));
    S.expectBad = [];
  };
  return S;
}

export async function saveDownload(dl, name) {
  const f = path.join(DL, name);
  await dl.saveAs(f);
  return f;
}
export function docxText(file) {
  const z = new L.PizZip(fs.readFileSync(file));
  const x = z.file('word/document.xml')?.asText() ?? '';
  return x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}
export const contractsDirFiles = () => fs.readdirSync(path.join(L.ROOT, 'storage', 'contracts')).filter((f) => f !== '.gitkeep');
