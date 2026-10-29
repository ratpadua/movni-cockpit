// Runs the whole UI suite in order (s0 baseline/login -> s1 seed -> flows -> s9 cleanup) and prints a summary.
// Usage: node qa/ui/run-all.mjs [--desktop-only]    (the server must be running on :5178, built client)
// Each spec writes qa/results/r*.json; failures do not stop the run (cleanup always runs last).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RES = path.resolve(HERE, '..', 'results');
fs.mkdirSync(RES, { recursive: true });
const isResult = (f) => /^r\d[0-9a-z_]*\.json$/.test(f);
for (const f of fs.readdirSync(RES)) if (isResult(f)) fs.unlinkSync(path.join(RES, f));

const steps = ['s0_login', 's1_seed', 's2_payments', 's3_contracts', 's4_recurring', 's4b_invoice_edit', 's5_customers', 's6_templates_bank', 's6b_reupload', 's7_reports_settings', 's10_fixes'];
if (!process.argv.includes('--desktop-only')) steps.push('s8_responsive');
steps.push('s9_cleanup');
const code = {};
for (const s of steps) {
  console.log(`\n########## ${s}`);
  const r = spawnSync(process.execPath, [path.join(HERE, s + '.mjs')], { stdio: 'inherit', cwd: path.resolve(HERE, '..') });
  code[s] = r.status;
}
let pass = 0, fail = 0, knownN = 0; const failed = [], knownList = [];
for (const f of fs.readdirSync(RES).filter(isResult)) {
  for (const x of JSON.parse(fs.readFileSync(path.join(RES, f), 'utf8'))) { if (x.known) { knownN++; knownList.push(`[${f}] ${x.flow}: ${x.name} -> ${x.extra}`); } if (x.pass) pass++; else { fail++; failed.push(`[${f}] ${x.flow}: ${x.name} -> ${x.extra}`); } }
}
console.log(`\n========== UI SUMMARY: ${pass} passed (of which ${knownN} KNOWN issues, not counted as failures), ${fail} failed`);
for (const k of knownList) console.log('KNOWN ' + k);
for (const f of failed) console.log('FAIL ' + f);
const crashed = Object.entries(code).filter(([, c]) => c !== 0 && c !== null);
if (crashed.length) console.log('Specs with non-zero exit code: ' + crashed.map(([s, c]) => `${s}(${c})`).join(', '));
fs.writeFileSync(path.join(RES, 'ui-summary.json'), JSON.stringify({ pass, fail, known: knownList, failed, code }, null, 1));
process.exit(fail || crashed.length ? 1 : 0);
