import fs from 'node:fs';
import path from 'node:path';
import * as L from './lib.mjs';
const { ok, eq, setFlow } = L;

// start logged out so the login screen can be checked (the DB session is server-wide)
await L.api('POST', '/api/logout');
const sql = await L.sqlConnect();
// refuse to start on top of leftovers of an aborted run (they would pollute the baseline)
const [left] = await sql.query("select (select count(*) from customers where name like 'QAZ%') c, (select count(*) from services where name like 'QAZ%') s, (select count(*) from templates where name like 'QAZ%') t, (select count(*) from payments where description like 'QAZ%') p, (select count(*) from bank_imports where file_name like 'QAZ%') b");
if (Object.values(left[0]).some((n) => Number(n) > 0)) { console.log('ABORT: QAZ leftovers found ' + JSON.stringify(left[0]) + ' - run `node qa/ui/s9_cleanup.mjs` first'); process.exit(2); }
const base = await L.counts(sql);
fs.writeFileSync(path.join(L.QA, 'baseline.json'), JSON.stringify(base, null, 1));
console.log('baseline', JSON.stringify(base));
// ids of every payment that exists before the run (anything else is removed by s9_cleanup)
const [pids] = await sql.query('select id from payments');
fs.writeFileSync(path.join(L.QA, 'baseline_payment_ids.json'), JSON.stringify(pids.map((r) => r.id)));
// settings snapshot (for restore)
const [st] = await sql.query('select * from settings');
fs.writeFileSync(path.join(L.QA, 'settings_before.json'), JSON.stringify(st));
await sql.end();

setFlow('Login screen (not connected)');
const s = await L.api('GET', '/api/session');
ok('server not connected at start', s.body?.connected === false, JSON.stringify(s.body));
const S = await L.newSession();
const { page, ev } = S;
await page.goto(L.BASE + '/');
await page.waitForLoadState('networkidle');
const body = await page.locator('body').innerText();
ok('login screen renders (Usuário / Senha / Entrar visible)', /usu[aá]rio/i.test(body) && /senha/i.test(body) && /entrar|conectar/i.test(body), body.slice(0, 200));
await L.shot(page, 'login_screen');
const e = L.drain(ev, 'login');
ok('no console errors on login screen', e.console.filter((x) => !/401|503/.test(x)).length === 0 && e.pageerrors.length === 0, JSON.stringify(e));
await S.browser.close();

const lg = await L.login();
ok('API login ok (server now connected)', lg);
const s2 = await L.api('GET', '/api/session');
ok('session connected', s2.body?.connected === true);
L.saveResults('r0.json');
