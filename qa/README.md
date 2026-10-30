# QA scripts

Automated checks used by the `qa-specialist` agent (see `CLAUDE.md`, rule 7). This folder is **not part of the
app**: it has its own `package.json`, is never copied into the portable bundle (`scripts/package-win.ps1`
copies only the server/client output), and must not be added to the app's dependencies.

```
qa/
├─ api/smoke.mjs        API smoke tests (login, validation, documents, bank import, payment validation, cleanup)
├─ ui/                  Playwright UI specs (Chromium, headless) + shared helpers
│  ├─ run-all.mjs       runs every spec in order and prints a summary
│  ├─ lib.mjs, ui.mjs, harness.mjs   helpers (paths are relative to the project root, no absolute paths)
│  ├─ s0_login.mjs      baseline row counts + login screen (starts logged out, then logs in through the API)
│  ├─ s1_seed.mjs       creates the QAZ test data through the API
│  ├─ s2 … s7           Fluxo de Caixa, contratos, recorrentes/faturas, clientes, modelos + extrato, relatórios/configurações
│  ├─ s10_fixes.mjs     the UI-bug-fix batch: typed dd/MM/yyyy dates in every screen, pt-BR money inputs,
│  │                    "Editar fatura" with a fully used credit, "Pagamento extra" Situação, bank-import
│  │                    fingerprint on original values, inline payment validation
│  ├─ s8_responsive.mjs mobile (375x812) / tablet (768x1024) screenshot sweep (skipped by --desktop-only)
│  └─ s9_cleanup.mjs    removes everything QAZ, compares row counts with the s0 baseline, restores settings
└─ results/, screens/   output (gitignored): r*.json per spec, ui-summary.json, screenshots
```

## Setup (once per machine)

```bash
npm --prefix qa install
npm --prefix qa run install:browser     # downloads Chromium (cached outside the repo)
```

## Running

Start the server first (`npm --prefix server run start`, port 5178, built client). Then:

```bash
npm --prefix qa run api           # API smoke suite
npm --prefix qa run ui            # whole UI suite (s0 … s10, s8 responsive sweep, s9 cleanup)
npm --prefix qa run ui:desktop    # same without the mobile/tablet sweep
npm --prefix qa run all           # api + ui
```

The UI specs share state through `qa/results/*.json`, so they must run in the order `run-all.mjs` uses
(`s0_login` → `s1_seed` → … → `s9_cleanup`). A single spec can be re-run after `s0_login` + `s1_seed`.
`s9_cleanup` always runs last (also when a spec failed) and fails if any table row count differs from the
baseline taken by `s0_login`.

## Rules

- Tests run against a **non-production** database only. Never point them at production.
- **Default: the local Docker MySQL** (no network latency, no Hostinger rate limits). One-time setup:
  `docker run -d --name movni-mysql-test -p 127.0.0.1:3307:3306 -e MYSQL_RANDOM_ROOT_PASSWORD=yes -e MYSQL_DATABASE=movni_test -e MYSQL_USER=movni_test -e MYSQL_PASSWORD=<pick one> -v movni-mysql-test-data:/var/lib/mysql mysql:8.4 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci`,
  then create the gitignored `.env.test` at the project root with `DB_HOST=127.0.0.1`, `DB_PORT=3307`,
  `DB_NAME=movni_test`, `DB_USER=movni_test`, `DB_PASS=<same password>`. Everything (server, drizzle, QA scripts)
  uses it when `DB_TARGET=local` is set; apply the schema once with `DB_TARGET=local npm --prefix server run db:migrate`
  (and again after every new migration). Start the server for QA with `DB_TARGET=local` too.
  Start the container with `docker start movni-mysql-test` if Docker was restarted. The Hostinger dev DB
  (`.env` + `.env.local`) is used only when `DB_TARGET` is not set.
- Credentials are read **inside the scripts** from `.env.local` and are never printed, logged or typed into a
  browser form: log in through `POST /api/login`; the server's DB session is global, so the UI then skips its
  login screen.
- Typed dates are typed for real as `dd/MM/yyyy` (key by key); money is typed in pt-BR (`1234,56`, `1.234,56`).
- Tests create only temporary data (prefix `QAZ`) and delete everything they created. If a run aborts, run
  `node qa/ui/s9_cleanup.mjs` (it sweeps every `QAZ*` row, but compares with the baseline from the last
  `s0_login`); no bank-import records, customers, contracts or payments may stay behind.
- Never put real credentials, DB names or IPs in these files - the repository is public.

## Notes on the current suites

- `api/smoke.mjs` section **P** covers the business rules: customer delete block (409 with counts), contract delete
  (blocked when anything was received, credit reinstated exactly, files removed), contract edit (409 after a receipt,
  re-split on the net total, 400 below the applied credit, extra payments kept), unique-number indexes, concurrent
  creations, rollback and invoice edit/delete concurrency.
- `ui/s8_responsive.mjs` asserts the layout at 375, 768, 991 and 992 px: no horizontal page scroll, burger/drawer below
  992 px, side menu from 992 px.
- With `DB_TARGET=local` every script uses the gitignored `.env.test` (local Docker MySQL) instead of the dev database.

## Pre-release check (before EVERY production release)

Run it against the **dev** database (normal `.env` + `.env.local`, no `DB_TARGET`). It exercises the production schema path and a
small, gentle smoke test of the app against the real remote DB (Hostinger throttles many requests: do not run the full suites there).

1. Stop any running server and confirm `.env` points to **dev**.
2. `npm --prefix server run db:add-columns`, then run it **a second time**: the second run must report 0 changes (an `ATENÇÃO`
   warning / exit code 1 means duplicate numbers block a unique index: fix the data first). Never run `db:migrate`, `db:seed` or `db:reset` here.
3. Start the server (`npm --prefix server run start`) and run `npm --prefix qa run release-smoke` (~40 sequential requests). It checks
   health, login, the main lists, the schema in `information_schema` (tables, `orig_date`/`orig_amount`, the two unique indexes),
   then creates QAZ-REL data: customer, one-time contract with installments, 3 concurrent contracts (distinct numbers), received
   installment blocks the delete (409), re-open + delete, customer delete, payment create/edit/delete. Everything QAZ-REL is removed and
   the row counts must equal the baseline (exit code 1 otherwise).
4. Stop the server and free port 5178.
