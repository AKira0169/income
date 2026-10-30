# Web App Platform (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-file offline Income Tracker into a deployed multi-user web app: Ory Kratos auth, a Hono REST API on Postgres that reuses `src/domain/*` for every write, every tab rewired to the API, and a Docker Compose stack behind Caddy. The current look stays as it is.

**Architecture:** There is one origin, `https://$APP_DOMAIN`. Caddy serves the static web build at `/*` and proxies `/auth/*` (prefix stripped) to Kratos public `:4433` and `/api/*` to the api on `:3000`. A mutating API request opens a transaction, sets `app.user_id`, takes a per-user advisory lock and loads the user's full `AppState`. It then calls the existing pure domain function, diffs old against new by id, writes the diff, bumps `users.state_version` and returns `{ version, changes, settings?, result }`. The web keeps its `app` signal and applies those changes immutably. Isolation comes from `server/repo.ts` adding `user_id` to every statement, with Postgres RLS as a backstop. The api's runtime role is a non-owner.

**Tech Stack:** Node 26 (native TS type-stripping) · Hono 4.13.14 + @hono/node-server 2.1.5 · postgres (porsager) 3.4.9 · zod 4.6.7 · Postgres 17 · Ory Kratos v1.3.1 · Caddy 2.11 · Preact 10 + @preact/signals · esbuild · puppeteer-core.

**Spec:** docs/superpowers/specs/2026-10-30-webapp-platform-design.md

## Global Constraints

- Branch `feat/webapp-platform`. The offline build is recoverable from tag `v1-offline`. Do not touch that tag.
- Node v26 runs `.ts` directly, so imports always carry the `.ts` extension. `erasableSyntaxOnly` is on, which rules out enums, namespaces and parameter properties.
- `src/domain/*` stays unchanged except for the `CURRENCY_EXPONENT` map added to `money.ts`: default 2, `JPY` 0, `KWD`/`BHD`/`OMR` 3.
- npm pins (exact): `hono@4.13.14`, `@hono/node-server@2.1.5`, `postgres@3.4.9`, `zod@4.6.7`. Do not use `postgres@4.0.0`: it was published 2026-10-29, the day before this plan, and is untested here. Do not use hono 5 release candidates.
- Image pins: `postgres:17.11-alpine`, `oryd/kratos:v1.3.1`, `node:26.13.0-alpine`, `caddy:2.11.7-alpine`, `axllent/mailpit:v1.32.0`.
- pnpm is `pnpm@11.9.0`, from `packageManager`. Node 26 images ship without corepack, so Dockerfiles run `npm install -g pnpm@11.9.0`.
- Money is integer minor units, stored as `BIGINT`. postgres.js gets a custom `bigint` type that parses to `Number`. Every domain date field is `TEXT`, because `''` is a legal value.
- Every per-user table has `user_id UUID NOT NULL`, `PRIMARY KEY (user_id, id)` and RLS policy `user_id = nullif(current_setting('app.user_id', true), '')::uuid` (USING + WITH CHECK). The api connects as role `app`, which is not the owner. Migrations connect as the `postgres` superuser.
- Kratos session: lifespan `720h` (30 days), `SameSite=Lax`, `Secure` (Kratos is not run with `--dev`). Verification is wired but not required for login.
- The cipher secret is exactly 32 characters (`openssl rand -hex 16`). The cookie secret comes from `openssl rand -hex 32`.
- The Kratos admin API (`:4434`) is never routed by Caddy.
- CSRF: every non-GET `/api/*` request must carry `Origin: https://$APP_DOMAIN`.
- Errors are `{ "error": { "code", "message" } }` with status 400/401/403/404/409/429/500. A domain throw becomes 400 carrying the domain's message.
- Docker: the CLI is installed, but the daemon was **not running** when this plan was written (`docker version` could not reach `dockerDesktopLinuxEngine`). No infra step below has been executed yet. Start Docker Desktop before Task 4.
- The DB test suites (`pnpm test:db`) need `pnpm db:test:up` first. They use a disposable Postgres on `127.0.0.1:54329`.
- Commit messages end with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

## File Structure

**Moved (Task 1)**
- `src/ui/**` → `src/web/ui/**`: unchanged components and tabs. Import depth +1 for `domain/` and `workbook/`.
- `src/state/{app,actions,route}.ts` → `src/web/state/`: the signal, actions and routing.
- `src/main.tsx` → `src/web/main.tsx`: bundle entry.
- `src/data/gold-price.ts` → `src/web/state/gold-price.ts`: interim home. Deleted in Task 11, after Task 10 moves the fetch server-side.
- `src/app.css` → `src/web/app.css` and `src/shell.html` → `src/web/index.html` (Task 2): the stylesheet, and the HTML template with link/script placeholders.

**Deleted**
- `src/data/sqlite.ts`, `src/web/ui/tabs/SqlConsole.tsx`, `vendor/sql-wasm.js`, `vendor/sql-wasm.wasm`, `vendor/sql.js-LICENSE` (Task 1).
- `src/web/state/gold-price.ts` (Task 11).

**Shared**
- `src/wire.ts`: types-only API contract (`UserCollection`, `Changes`, `MutationResponse`…), `USER_COLLECTIONS`, and the pure `applyChanges()`. Imported by web and server.
- `src/domain/money.ts` (modify): adds `CURRENCY_EXPONENT` and `currencyExponent()`.

**Server (`server/`)**
- `server/db.ts`: postgres.js connection with the bigint parser, `withUser()` transaction (set_config + optional advisory lock).
- `server/migrate.ts`: applies `server/migrations/*.sql` in order and records them in `schema_migrations`.
- `server/migrations/001_init.sql`: the full app schema, RLS and grants.
- `server/schema.ts`: `TABLES` (moved from sqlite.ts), table names, column kinds, `snake()`, `coerce()`, `normalizeRecord()`, `normalizeState()`.
- `server/diff.ts`: `diffState(before, after)` gives per-collection upserts/deletes plus settings.
- `server/repo.ts`: all SQL. userId is the first argument of every per-user function.
- `server/errors.ts`: `HttpError` and `toErrorResponse()`.
- `server/kratos.ts`: `Identity`, `kratosWhoami()` (server→Kratos).
- `server/session.ts`: `sessionToken()`, `cachedWhoami()` (30 s LRU).
- `server/ratelimit.ts`: `tokenBucket()`.
- `server/mutate.ts`: `mutate()`, the one write path (lock → load → domain → diff → write → bump).
- `server/validate.ts`: zod schemas and `parseCollection()`.
- `server/app.ts`: `createApp(deps)`, middleware chain, `/healthz`, `/api/me`, `/api/state`.
- `server/routes/records.ts`: generic collection CRUD and `PATCH /api/settings`.
- `server/routes/composite.ts`: recurring, goals, debts, reconcile, backup/import/erase.
- `server/gold-price.ts`: spot and FX fetch (ported from the web).
- `server/jobs.ts`: `syncGoldPrice()` and `startJobs()`.
- `server/main.ts`: process entry (env, migrate, serve, jobs).
- `server/Dockerfile`: the api image.

**Web (`src/web/`)**
- `src/web/state/api.ts`: fetch client, serialized mutation queue, version tracking, `inFlight`/`reachable` signals.
- `src/web/state/boot.ts`: `boot()` (GET state then catch-up), `resetApp()`.
- `src/web/state/app.ts` (rewrite): the `app` signal, `hydrate`, boot signals, `reachable`.
- `src/web/state/actions.ts` (rewrite): the same names, now async and API-backed.
- `src/web/state/route.ts` (rewrite): path routes plus auth routes, `parsePath()`.
- `src/web/auth/kratos.ts`: browser-flow fetch wrapper and flow types.
- `src/web/auth/session.ts`: `session` signal, `checkSession()`, `signOut()`.
- `src/web/auth/FlowForm.tsx`: the generic `ui.nodes` renderer and submit handling.
- `src/web/auth/screens.tsx`: `Login`, `Registration`, `Recovery`, `Verification`, `SecuritySettings`, `AuthError`, `AuthShell`.
- `src/web/ui/App.tsx`, `Topbar.tsx`, `feedback.ts`, `components/{Form,Dialog,Sheet,RecurringSection}.tsx`, `tabs/*.tsx` (modify): async call sites, session gate, email + log out.

**Build**
- `build.mjs` (rewrite): emits `dist/web/index.html` plus `dist/web/assets/*-[hash].{js,css}`.
- `dev.mjs` (rewrite): esbuild watch into `dist/web`. Caddy in the dev stack serves it.
- `package.json`, `pnpm-lock.yaml`, `tsconfig.server.json` (new), `tsconfig.test.json`, `.gitignore`, `.gitattributes` (new), `.dockerignore` (new).

**Deploy (`deploy/`)**
- `deploy/compose.yaml`: postgres, kratos-migrate, kratos, api, caddy, mailpit (profile `dev`).
- `deploy/compose.dev.yaml`: `APP_DOMAIN=localhost`, `tls internal` Caddyfile, mailpit, `node --watch`, `dist/web` mounted.
- `deploy/compose.test.yaml`: disposable Postgres for `pnpm test:db`.
- `deploy/postgres/init.sh`: creates the `app` and `kratos` roles and databases.
- `deploy/kratos/kratos.yml` and `deploy/kratos/identity.schema.json`.
- `deploy/caddy/Caddyfile`, `deploy/caddy/Caddyfile.dev`, `deploy/caddy/routes.caddy`, `deploy/caddy/Dockerfile`.
- `deploy/.env.example` (prod template), `deploy/dev.env` (throwaway dev values, committed).
- `deploy/README.md`: VPS runbook.

**Tests**
- `test/support/check.ts`: the shared `check`/`finish` used by new suites.
- `test/support/store.ts`: the offline build's synchronous in-memory store, kept so `test/export.ts` and `test/domain.ts` keep exercising the domain unchanged.
- `test/support/db.ts`: `freshDatabase()` against the test Postgres.
- `test/support/ids.ts`: deterministic `crypto.randomUUID`, so domain-vs-API comparisons line up.
- `test/support/fixture.ts`: a realistic `AppState` and its backup JSON.
- `test/support/http.ts`: an `as(userId)` request helper over `app.request()`.
- New: `test/build.ts`, `test/currency.ts`, `test/migrate.ts`, `test/diff.ts`, `test/repo.ts`, `test/api-core.ts`, `test/api-records.ts`, `test/api-composite.ts`, `test/gold.ts`, `test/web-state.ts`, `test/await-actions.ts`, `test/route.ts`, `test/kratos.ts`.
- Modified: `test/domain.ts`, `test/export.ts` (import lines plus removal of the persistence-batching block) and `test/browser.mjs` (dev stack).

---

### Task 1: Move the web app under `src/web/` and retire sql.js

**Files:**
- Move: `src/ui/` → `src/web/ui/`, `src/state/` → `src/web/state/`, `src/main.tsx` → `src/web/main.tsx`, `src/data/gold-price.ts` → `src/web/state/gold-price.ts`
- Delete: `src/data/sqlite.ts`, `src/web/ui/tabs/SqlConsole.tsx`, `vendor/sql-wasm.js`, `vendor/sql-wasm.wasm`, `vendor/sql.js-LICENSE`
- Create: `test/support/store.ts`
- Modify: `src/web/state/app.ts`, `src/web/main.tsx`, `src/web/ui/tabs/Settings.tsx`, `src/web/ui/tabs/Gold.tsx`, `src/web/state/gold-price.ts`, `build.mjs`, `test/domain.ts`, `test/export.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces `test/support/store.ts`. It exports `app` (`Signal<AppState>`) and `snapshot(): AppState`, plus synchronous `upsert`, `remove`, `updateSettings`, `replaceState`, `clearAll`, `importJSON`, `exportJSON`, `generateBills`, `generateIncome`, `catchUp`, `linkGeneratedTo`, `recordGoldPrice`, `saveGoal`, `moveGoal`, `borrow`, `repay` and `reconcile`, with the same signatures as today's `src/state/actions.ts`.
- Produces an interim `boot(): Promise<BootOutcome | null>` in `src/web/state/app.ts`, which takes no argument and keeps state in memory only.

Note: `test/browser.mjs` drives the sql.js build. It is expected to fail from this task until Task 15 rewrites it against the dev stack. `pnpm test` (not `test:browser`) is the gate.

- [ ] **Step 1: Point the Node suites at the new harness (failing test)**

In `test/domain.ts`, delete these two import lines:

```ts
import { attachPersistence, app } from '../src/state/app.ts';
import { upsert as commitUpsert } from '../src/state/actions.ts';
```

Then delete the whole block from `/* ---------------- one write per turn, not one per call ---------------- */` through `check('a later turn saves again', saves, 2);`. That covers the 20 lines that use `attachPersistence`, `commitUpsert` and `saves`. Coalescing saves into a microtask is a property of the sql.js persistence layer, which this task deletes. A write is now one HTTP request (Task 11).

In `test/export.ts`, replace

```ts
import { app, snapshot } from '../src/state/app.ts';
import {
  catchUp, generateBills, generateIncome, importJSON, recordGoldPrice, remove,
  replaceState, updateSettings, upsert
} from '../src/state/actions.ts';
```

with

```ts
import {
  app, snapshot, catchUp, generateBills, generateIncome, importJSON, recordGoldPrice, remove,
  replaceState, updateSettings, upsert
} from './support/store.ts';
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node test/export.ts`
Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/test/support/store.ts'`.

- [ ] **Step 3: Implement**

3a. Create `test/support/store.ts`:

```ts
/* test/support/store.ts — the offline build's in-memory store, kept for the
   Node suites.

   The web app's actions became API calls in phase 1, but export.ts and
   domain.ts were written against "call an action, read the signal" and are
   still the best coverage the domain and the workbook have. This is that
   contract, unchanged and synchronous, over plain memory: each action calls the
   pure domain function, replaces the state, and returns what the old action
   returned. Nothing here persists anything — there is nothing to persist to. */

import { signal } from '@preact/signals';
import * as Backup from '../../src/domain/backup.ts';
import * as Debt from '../../src/domain/debt.ts';
import * as Forecast from '../../src/domain/forecast.ts';
import * as Gold from '../../src/domain/gold.ts';
import * as Records from '../../src/domain/records.ts';
import * as Reconcile from '../../src/domain/reconcile.ts';
import * as Recurring from '../../src/domain/recurring.ts';
import type {
  AppState, CatchUpResult, Cents, CollectionKey, GoldPrice, Id, IsoDate, Period, RecordOf, Settings
} from '../../src/domain/types.ts';

export const app = signal<AppState>(Records.blankState());
export const snapshot = (): AppState => app.peek();

const commit = (next: AppState): void => { app.value = next; };

export function upsert<K extends CollectionKey>(collection: K, record: Records.Draft<K>): RecordOf<K> {
  const result = Records.upsert(app.peek(), collection, record);
  commit(result.state);
  return result.record;
}

export function remove(collection: CollectionKey, id: Id): void {
  commit(Records.remove(app.peek(), collection, id));
}

export function updateSettings(patch: Partial<Settings>): void {
  commit(Records.updateSettings(app.peek(), patch));
}

export function replaceState(next: unknown): void { commit(Records.migrate(next)); }

export function clearAll(): void { commit(Records.blankState()); }

export function importJSON(text: string): Record<CollectionKey, number> {
  const result = Backup.importJSON(text);
  commit(result.state);
  return result.counts;
}

export const exportJSON = (): string => Backup.exportJSON(snapshot());

export function generateBills(period: Period): number {
  const result = Recurring.generateBills(app.peek(), period);
  if (result.created) commit(result.state);
  return result.created;
}

export function generateIncome(period: Period): number {
  const result = Recurring.generateIncome(app.peek(), period);
  if (result.created) commit(result.state);
  return result.created;
}

export function catchUp(): CatchUpResult {
  const result = Recurring.catchUp(app.peek());
  if (result.state !== app.peek()) commit(result.state);
  return result.result;
}

export function linkGeneratedTo(
  collection: 'incomeTemplates' | 'billTemplates',
  template: { id?: Id; accountId?: Id | '' } | null | undefined
): number {
  const result = Recurring.linkGeneratedTo(app.peek(), collection, template);
  if (result.linked) commit(result.state);
  return result.linked;
}

export function recordGoldPrice(reading: Gold.GoldPriceReading): GoldPrice {
  const result = Gold.recordGoldPrice(app.peek(), reading);
  commit(result.state);
  return result.record;
}

export function saveGoal(draft: Records.Draft<'goals'>, paid: Forecast.GoalPayment = {}): void {
  commit(Forecast.saveGoal(app.peek(), draft, paid));
}

export function moveGoal(id: Id, delta: number): void {
  const next = Forecast.moveGoal(app.peek(), id, delta);
  if (next !== app.peek()) commit(next);
}

export function borrow(taken: Debt.Borrowing): void {
  commit(Debt.borrow(app.peek(), taken));
}

export function repay(debtId: Id, paid: Debt.Repayment): void {
  const next = Debt.repay(app.peek(), debtId, paid);
  if (next !== app.peek()) commit(next);
}

export function reconcile(accountId: Id, actual: Cents, date: IsoDate): Cents {
  const state = app.peek();
  const { difference } = Reconcile.reconciliation(state, accountId, actual);
  if (difference) commit(Reconcile.reconcile(state, accountId, actual, date));
  return difference;
}
```

3b. Move the files and fix import depth. Run in Git Bash from the repo root:

```bash
mkdir -p src/web
git mv src/ui src/web/ui
git mv src/state src/web/state
git mv src/main.tsx src/web/main.tsx
git mv src/data/gold-price.ts src/web/state/gold-price.ts
git rm -q src/data/sqlite.ts src/web/ui/tabs/SqlConsole.tsx vendor/sql-wasm.js vendor/sql-wasm.wasm vendor/sql.js-LICENSE
# Every import that leaves the moved tree (domain/, workbook/) is now one level deeper.
find src/web \( -name '*.ts' -o -name '*.tsx' \) -print0 \
  | xargs -0 sed -i -E "s#from '((\.\./)*)(domain|workbook)/#from '../\1\3/#g"
# gold-price.ts now sits beside the state it reads.
sed -i "s#from '../state/app.ts'#from './app.ts'#; s#from '../state/actions.ts'#from './actions.ts'#" src/web/state/gold-price.ts
sed -i "s#from '../../data/gold-price.ts'#from '../../state/gold-price.ts'#" src/web/ui/tabs/Gold.tsx
```

3c. In `src/web/state/app.ts`, replace the import line `import { init as initSqlite, save as saveSqlite } from '../data/sqlite.ts';` (after the sed it reads `'../data/sqlite.ts'`) by deleting it. Then replace the whole `/* ---- boot ---- */` section, from `export interface BootOutcome` to the end of the file, with:

```ts
export interface BootOutcome {
  /** The state came from the old localStorage format and has just been moved. */
  migrated: boolean;
  added: CatchUpResult;
}

/* Interim, until the API lands (Task 11): the state lives in memory only. The
   storage notice says so, which is the truth for this build. */
export async function boot(): Promise<BootOutcome | null> {
  try {
    hydrate(blankState(), false);
    const swept = catchUp(app.peek());
    if (swept.state !== app.peek()) commit(swept.state);
    booting.value = false;
    return { migrated: false, added: swept.result };
  } catch (err) {
    booting.value = false;
    bootError.value = err instanceof Error ? err.message : String(err);
    return null;
  }
}
```

3d. Replace `src/web/main.tsx` entirely:

```tsx
/* main.tsx — the bundle entry point. */

import { render } from 'preact';
import { accountBalance } from '../domain/selectors.ts';
import { isDue, refresh as refreshGoldPrice } from './state/gold-price.ts';
import { app, boot, snapshot } from './state/app.ts';
import { clearAll, upsert } from './state/actions.ts';
import { goPeriod, goTab, startRouting } from './state/route.ts';
import type { TabId } from './state/route.ts';
import { App } from './ui/App.tsx';
import { build as buildWorkbook, filename as workbookFilename } from '../workbook/build.ts';
import type { Scope } from '../workbook/build.ts';

/* A handle on the running app, under `__app` in the console. The browser suite
   drives the app through it. Nothing here goes further than the screen does. */
Object.assign(globalThis, {
  __app: {
    /** The live state object. Replaced on every write, so read it each time. */
    state: snapshot,
    accountBalance: (id: string) => accountBalance(snapshot(), id),
    upsert,
    clearAll,
    buildWorkbook: (scope: Scope) => buildWorkbook(snapshot(), scope),
    workbookFilename,
    goTab: (tab: TabId) => goTab(tab),
    goPeriod: (period: string) => goPeriod(period),
    /** Kept for the console: a write already redraws on its own. */
    render: () => { app.value = { ...app.peek() }; }
  }
});

function start(): void {
  startRouting();
  const host = document.getElementById('app');
  if (!host) return;
  const outcome = boot();
  void outcome.then((result) => { if (result && isDue()) void refreshGoldPrice(); });
  render(<App outcome={outcome} />, host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
```

3e. In `src/web/ui/tabs/Settings.tsx`:
- Delete `import { exportBytes, getBackend } from '../../data/sqlite.ts';` (the sed leaves `data/` imports alone), `import { SqlConsole } from './SqlConsole.tsx';`, and the line `const [sqlOpen, setSqlOpen] = useState(false);`.
- Change `import { useRef, useState } from 'preact/hooks';` to `import { useRef } from 'preact/hooks';`.
- Replace `{`${plural(recordCount, 'record')} · stored in SQLite via ${getBackend()}`}` with `{plural(recordCount, 'record')}`.
- Delete the whole `<button class="primary" onClick={…download(exportBytes()…}>Download database (.db)</button>` element. Change the next button's `onClick` element so it reads `<button class="primary" onClick=…>Download backup (.json)</button>`.
- Delete the whole `<Sheet>` whose head is `<h2>Query your data</h2>`.

3f. In `build.mjs`, change the entry to `entryPoints: [join(here, 'src', 'web', 'main.tsx')],`. In `page()`, delete the four array lines that inline sql.js and the wasm, i.e. the two comment strings plus `guard(readFileSync(vendor('sql-wasm.js'), 'utf8')),` and `` `globalThis.__SQL_WASM_B64__ = "${wasmB64()}";`, ``. Then delete `const vendor = …`, `wasmB64Cache`, `wasmB64` and the `sqlite wasm` console line. Task 2 replaces this file wholesale; this step only keeps it building.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test`
Expected: typecheck clean. `test/domain.ts`, `test/roundtrip.ts` and `test/export.ts` each end with `all checks passed`.
Also run `pnpm build`. Expected: `built …income-tracker.html`.

- [ ] **Step 5: Commit**

```bash
git add -A src test build.mjs vendor
git commit -m "refactor: move web app to src/web and retire sql.js

The SQL console, .db download and IndexedDB persistence go with sql.js.
Node suites keep their synchronous store in test/support/store.ts.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Build to `dist/web/` with hashed assets

**Files:**
- Move: `src/app.css` → `src/web/app.css`, `src/shell.html` → `src/web/index.html`
- Modify: `build.mjs` (rewrite), `dev.mjs` (rewrite), `package.json` (scripts), `.gitignore`
- Test: `test/build.ts`

**Interfaces:**
- Produces `build.mjs` exports: `here: string`, `outDir: string` (`<repo>/dist/web`), `buildStamp(): string`, `bundleOptions(stamp: string, minify?: boolean): BuildOptions & { metafile: true; write: true }`, `writeIndex(metafile: Metafile): { js: string; css: string }` (the URL paths it wrote into index.html), and `buildWeb(options?: { stamp?: string; minify?: boolean }): Promise<{ js: string; css: string }>`.

- [ ] **Step 1: Write the failing test**

`test/build.ts`:

```ts
/* Build test: `pnpm build` must leave a servable dist/web — an index.html
   whose script and stylesheet point at hashed files that really exist, and no
   trace of the retired single-file assembly.

   Run:  node test/build.ts */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWeb, outDir } from '../build.mjs';
import { check, finish } from './support/check.ts';

console.log('dist/web:');
const written = await buildWeb({ stamp: 'test' });
const html = readFileSync(join(outDir, 'index.html'), 'utf8');

check('the script is a hashed asset', /^\/assets\/app-[A-Z0-9]+\.js$/i.test(written.js), true);
check('the stylesheet is a hashed asset', /^\/assets\/style-[A-Z0-9]+\.css$/i.test(written.css), true);
check('index.html loads the script as a module', html.includes(`<script type="module" src="${written.js}"></script>`), true);
check('index.html links the stylesheet', html.includes(`<link rel="stylesheet" href="${written.css}">`), true);
check('the script exists', existsSync(join(outDir, written.js)), true);
check('the stylesheet exists', existsSync(join(outDir, written.css)), true);
check('there is a mount point', html.includes('<div id="app"></div>'), true);
check('no inline script is left (CSP-friendly)', /<script>(?!<\/script>)/.test(html), false);
check('sql.js is gone', readFileSync(join(outDir, written.js), 'utf8').includes('__SQL_WASM_B64__'), false);

finish();
```

`test/support/check.ts`:

```ts
/* test/support/check.ts — the one assertion every suite uses: compare as JSON,
   print ok/FAIL, count failures, exit non-zero at the end. Same contract as the
   check() written inline in the older suites. */

let failures = 0;

export function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  } else console.log(`  ok   ${label}`);
}

export const title = (text: string): void => console.log(`\n${text}:`);

export function finish(): never {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node test/build.ts`
Expected: `SyntaxError: The requested module '../build.mjs' does not provide an export named 'buildWeb'`.

- [ ] **Step 3: Implement**

```bash
git mv src/app.css src/web/app.css
git mv src/shell.html src/web/index.html
```

`src/web/index.html` (full contents):

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Income Tracker</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%232563eb'/><path d='M28 68V44M50 68V30M72 68V54' stroke='white' stroke-width='11' stroke-linecap='round'/></svg>">
<!--{{CSS}}-->
</head>
<body>
<div id="app"></div>
<noscript>
  <div style="max-width:640px;margin:60px auto;padding:20px;font-family:system-ui">
    <h1>JavaScript is required</h1>
    <p>Income Tracker runs in your browser and needs JavaScript enabled.</p>
  </div>
</noscript>
<!--{{JS}}-->
</body>
</html>
```

`build.mjs` (full contents):

```js
/* build.mjs — bundles src/web into dist/web: index.html plus hashed JS and
   CSS under dist/web/assets.  Run: node build.mjs

   The page is served by Caddy from one origin with the api and Kratos, so it no
   longer has to be one self-contained file. Hashed names let Caddy cache the
   assets forever while index.html is always revalidated — a new build is picked
   up on the next load, never half of one.

   dev.mjs imports bundleOptions() and writeIndex() rather than shelling out, so
   the watched build and the shipped build are assembled by the same code. */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const here = dirname(fileURLToPath(import.meta.url));
export const outDir = join(here, 'dist', 'web');
const OUT_PREFIX = 'dist/web/';

/* Stamped into the bundle and shown beside the title, so a stale tab is
   obvious at a glance. */
export const buildStamp = () => new Date().toLocaleString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
}).replace(',', ' ·');

/** Shared by `node build.mjs` and dev's watch context.

    The annotation is load-bearing: pinning `metafile` to the literal `true` is
    what makes `result.metafile` non-optional for the caller.

    @param {string} stamp
    @param {boolean} [minify]
    @returns {import('esbuild').BuildOptions & { metafile: true; write: true }} */
export function bundleOptions(stamp, minify = true) {
  return {
    absWorkingDir: here,
    entryPoints: {
      app: join(here, 'src', 'web', 'main.tsx'),
      style: join(here, 'src', 'web', 'app.css')
    },
    outdir: outDir,
    entryNames: 'assets/[name]-[hash]',
    bundle: true,
    format: 'esm',
    // esbuild does not read tsconfig's `target`; the app is Chrome/Edge only.
    target: ['chrome110'],
    platform: 'browser',
    minify,
    sourcemap: minify ? false : 'linked',
    // Without this esbuild escapes every non-ASCII character to \uXXXX.
    charset: 'utf8',
    legalComments: 'none',
    metafile: true,
    write: true,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: {
      'process.env.NODE_ENV': '"production"',
      __BUILD__: JSON.stringify(stamp)
    }
  };
}

/** Writes dist/web/index.html pointing at whatever the last build emitted.
    @param {import('esbuild').Metafile} metafile
    @returns {{ js: string; css: string }} */
export function writeIndex(metafile) {
  /** @param {string} entry */
  const urlOf = (entry) => {
    const hit = Object.entries(metafile.outputs)
      .find(([file, out]) => out.entryPoint === entry && !file.endsWith('.map'));
    if (!hit) throw new Error(`build produced nothing for ${entry}`);
    return '/' + hit[0].replaceAll('\\', '/').slice(OUT_PREFIX.length);
  };
  const js = urlOf('src/web/main.tsx');
  const css = urlOf('src/web/app.css');
  const html = readFileSync(join(here, 'src', 'web', 'index.html'), 'utf8')
    .replace('<!--{{CSS}}-->', `<link rel="stylesheet" href="${css}">`)
    .replace('<!--{{JS}}-->', `<script type="module" src="${js}"></script>`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html, 'utf8');
  return { js, css };
}

/** @param {{ stamp?: string; minify?: boolean }} [options] */
export async function buildWeb({ stamp = buildStamp(), minify = true } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  const result = await build(bundleOptions(stamp, minify));
  return writeIndex(result.metafile);
}

/* Only when run directly — dev.mjs and the tests import the helpers above. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stamp = buildStamp();
  const { js, css } = await buildWeb({ stamp });
  console.log(`built ${outDir}`);
  console.log(`  ${js}\n  ${css}`);
  console.log(`  stamped: ${stamp}`);
}
```

`dev.mjs` (full contents):

```js
/* dev.mjs — rebuild dist/web on every change.  Run: pnpm dev

   There is no dev server here any more: the dev compose stack (pnpm stack:dev)
   mounts dist/web into Caddy, so the page is served from https://localhost with
   the real /api and /auth beside it — the same origin rules as production.
   Reload the tab after a rebuild. */
import { context } from 'esbuild';
import { bundleOptions, buildStamp, writeIndex } from './build.mjs';

const ctx = await context({
  ...bundleOptions(`${buildStamp()} · dev`, false),
  plugins: [{
    name: 'write-index',
    setup(b) {
      b.onEnd((result) => {
        if (result.errors.length || !result.metafile) {
          console.log(`  ${result.errors.length} error(s) — dist/web left at the last good build`);
          return;
        }
        writeIndex(result.metafile);
        console.log(`  rebuilt — ${new Date().toLocaleTimeString('en-GB')}`);
      });
    }
  }]
});

await ctx.watch();
console.log('watching src/ → dist/web (served by the dev stack at https://localhost)');
```

In `package.json` scripts, set `"test"` to `"pnpm typecheck && node test/domain.ts && node test/roundtrip.ts && node test/export.ts && node test/build.ts"`.

In `.gitignore`, replace the `income-tracker.html` block (its comment and the line) with:

```
# The web build output: rebuild it with `pnpm build`.
dist/
```

- [ ] **Step 4: Run, expect PASS**

Run: `node test/build.ts`, then `pnpm test`
Expected: `all checks passed` in both runs. `ls dist/web/assets` shows one `app-*.js` and one `style-*.css`.

- [ ] **Step 5: Commit**

```bash
git add -A build.mjs dev.mjs src/web test/build.ts test/support/check.ts package.json .gitignore
git commit -m "build: emit dist/web with hashed assets instead of one html file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Currency exponents in `money.ts`

**Files:**
- Modify: `src/domain/money.ts`, `package.json` (test script)
- Test: `test/currency.ts`

**Interfaces:**
- Produces: `CURRENCY_EXPONENT: Readonly<Record<string, number>>` and `currencyExponent(code: string | null | undefined): number`.

- [ ] **Step 1: Write the failing test**

`test/currency.ts`:

```ts
/* Currency exponents: how many minor units a currency's major unit holds.
   Phase 3 stores amounts per currency; the map has to exist now so the schema
   and the import path agree on what "minor units" means.

   Run:  node test/currency.ts */

import { CURRENCY_EXPONENT, currencyExponent } from '../src/domain/money.ts';
import { check, finish, title } from './support/check.ts';

title('currency exponents');
check('the default is two decimals', currencyExponent('EGP'), 2);
check('an unknown code is two decimals', currencyExponent('XYZ'), 2);
check('an empty code is two decimals', currencyExponent(''), 2);
check('yen has none', currencyExponent('JPY'), 0);
check('the dinars and the rial have three',
  ['KWD', 'BHD', 'OMR'].map(currencyExponent), [3, 3, 3]);
check('lower case is read the same', currencyExponent('jpy'), 0);
check('the map lists only the exceptions', Object.keys(CURRENCY_EXPONENT).sort(), ['BHD', 'JPY', 'KWD', 'OMR']);

finish();
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node test/currency.ts`
Expected: `SyntaxError: The requested module '../src/domain/money.ts' does not provide an export named 'CURRENCY_EXPONENT'`.

- [ ] **Step 3: Implement**

Append to `src/domain/money.ts`:

```ts
/* How many minor units make one major unit, per ISO 4217 code. Every amount in
   the app is already an integer number of minor units; this is what says how
   many of them a currency has, so a yen amount is not divided by a hundred and
   a Kuwaiti dinar is not short a digit. Only the exceptions are listed — two
   decimals is the rule. Phase 1 stores it; the multi-currency UI reads it. */
export const CURRENCY_EXPONENT: Readonly<Record<string, number>> = {
  JPY: 0,
  KWD: 3,
  BHD: 3,
  OMR: 3
};

export function currencyExponent(code: string | null | undefined): number {
  return CURRENCY_EXPONENT[String(code ?? '').toUpperCase()] ?? 2;
}
```

Append ` && node test/currency.ts` to the `"test"` script.

- [ ] **Step 4: Run, expect PASS**

Run: `node test/currency.ts && pnpm test`
Expected: `all checks passed` in both runs.

- [ ] **Step 5: Commit**

```bash
git add src/domain/money.ts test/currency.ts package.json
git commit -m "feat(domain): add CURRENCY_EXPONENT map for per-currency minor units

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Test Postgres, the app schema and the migration runner

**Files:**
- Create: `deploy/compose.test.yaml`, `deploy/postgres/init.sh`, `.gitattributes`, `tsconfig.server.json`, `server/db.ts`, `server/migrate.ts`, `server/schema.ts`, `server/migrations/001_init.sql`, `test/support/db.ts`
- Modify: `package.json` (deps + scripts), `pnpm-lock.yaml`
- Test: `test/migrate.ts`

**Interfaces:**
- Produces `server/db.ts`:
  - `type Types = { bigint: number }`, `type Sql = postgres.Sql<Types>`, `type Tx = postgres.TransactionSql<Types>`, `type Db = postgres.ISql<Types>` (accepts either)
  - `connect(url: string, options?: { max?: number }): Sql`
  - `withUser<T>(sql: Sql, userId: string, work: (tx: Tx) => Promise<T>, options?: { lock?: boolean }): Promise<T>`
- Produces `server/migrate.ts`: `MIGRATIONS_DIR: string`, `migrate(sql: Sql, dir?: string): Promise<string[]>` (returns the names newly applied).
- Produces `server/schema.ts`:
  - `TABLES` (same shape as the old `sqlite.ts` export) and `TABLE_NAME: Readonly<Record<CollectionKey, string>>`
  - `type ColumnKind = 'text' | 'bigint' | 'int' | 'real' | 'bool'`, `kindOf(column: string): ColumnKind`, `PG_TYPE: Readonly<Record<ColumnKind, string>>` and `snake(column: string): string`
  - `coerce(kind: ColumnKind, value: unknown): string | number | boolean | null`
  - `normalizeRecord<K extends CollectionKey>(collection: K, record: unknown): RecordOf<K>` and `normalizeState(state: AppState): AppState`
- Produces `test/support/db.ts`: `ADMIN_URL`, `APP_URL`, `interface TestDb { admin: Sql; sql: Sql; applied: string[]; close(): Promise<void> }`, `freshDatabase(): Promise<TestDb>`.

- [ ] **Step 1: Write the failing test**

`test/migrate.ts`:

```ts
/* Migration test: the schema the api runs against is the schema the domain
   describes, RLS is on everywhere a user's rows live, and the runtime role can
   neither own nor bypass any of it.

   Needs the test database:  pnpm db:test:up
   Run:  node test/migrate.ts */

import { COLLECTION_KEYS } from '../src/domain/catalog.ts';
import { migrate } from '../server/migrate.ts';
import { kindOf, PG_TYPE, snake, TABLE_NAME, TABLES } from '../server/schema.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';

const db = await freshDatabase();

title('the runner');
check('a fresh database gets the initial migration', db.applied, ['001_init.sql']);
check('running again applies nothing', await migrate(db.admin), []);

title('every domain field has a column of the right type');
const columns = await db.admin<{ table_name: string; column_name: string; data_type: string }[]>`
  select table_name, column_name, data_type from information_schema.columns
  where table_schema = 'public'`;
for (const key of COLLECTION_KEYS) {
  const table = TABLE_NAME[key];
  const types = new Map(columns.filter((c) => c.table_name === table).map((c) => [c.column_name, c.data_type]));
  for (const field of TABLES[key]) {
    // gold_prices is keyed by date; the domain's `gpr_<date>` id is derived on read.
    if (key === 'goldPrices' && field === 'id') continue;
    check(`${table}.${snake(field)}`, types.get(snake(field)), PG_TYPE[kindOf(field)]);
  }
}
check('income stores its period for the uniqueness rule',
  columns.some((c) => c.table_name === 'income' && c.column_name === 'period'), true);
check('accounts carry a currency',
  columns.find((c) => c.table_name === 'accounts' && c.column_name === 'currency')?.data_type, 'character');
check('fx_rates exists for phase 3',
  columns.filter((c) => c.table_name === 'fx_rates').map((c) => c.column_name).sort(),
  ['currency', 'date', 'rate_to_base', 'user_id']);

title('isolation backstop');
const perUser = ['users', 'settings', 'income', 'income_templates', 'bill_templates', 'bills',
  'purchases', 'accounts', 'goals', 'savings_tx', 'gold', 'fx_rates'];
const rls = await db.admin<{ relname: string; relrowsecurity: boolean }[]>`
  select relname, relrowsecurity from pg_class where relname in ${db.admin(perUser)} and relkind = 'r'`;
check('RLS is enabled on every per-user table',
  rls.filter((r) => r.relrowsecurity).map((r) => r.relname).sort(), [...perUser].sort());
const [role] = await db.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
  select rolsuper, rolbypassrls from pg_roles where rolname = 'app'`;
check('the api role is neither superuser nor RLS-exempt', [role?.rolsuper, role?.rolbypassrls], [false, false]);
const owners = await db.admin<{ tableowner: string }[]>`
  select distinct tableowner from pg_tables where schemaname = 'public'`;
check('and owns no table', owners.map((o) => o.tableowner), ['postgres']);

title('generated rows cannot be duplicated');
const u = '00000000-0000-4000-8000-000000000001';
const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try { await work(); return 'accepted'; } catch (err) { return (err as { code?: string }).code ?? 'error'; }
};
await db.admin`insert into users (id) values (${u}::uuid)`;
await db.admin`insert into bills (user_id, id, template_id, period) values (${u}::uuid, 'b1', 't1', '2026-07')`;
check('a second bill for the same template and month is refused',
  await codeOf(() => db.admin`insert into bills (user_id, id, template_id, period) values (${u}::uuid, 'b2', 't1', '2026-07')`),
  '23505');
await db.admin`insert into income (user_id, id, template_id, date) values (${u}::uuid, 'i1', 't9', '2026-07-01')`;
check('so is a second income entry, keyed on the month of its date',
  await codeOf(() => db.admin`insert into income (user_id, id, template_id, date) values (${u}::uuid, 'i2', 't9', '2026-07-28')`),
  '23505');
check('entries typed by hand (no template) are never caught by it',
  await codeOf(() => db.admin`insert into income (user_id, id, template_id, date)
    values (${u}::uuid, 'i3', null, '2026-07-28'), (${u}::uuid, 'i4', null, '2026-07-28')`),
  'accepted');

await db.close();
finish();
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node test/migrate.ts`
Expected: `ERR_MODULE_NOT_FOUND` for `../server/migrate.ts`.

- [ ] **Step 3: Implement**

3a. Dependencies and scripts:

```bash
pnpm add --save-exact hono@4.13.14 @hono/node-server@2.1.5 postgres@3.4.9 zod@4.6.7
```

Add these to the `package.json` scripts:

```json
"db:test:up": "docker compose -f deploy/compose.test.yaml up -d --wait",
"db:test:down": "docker compose -f deploy/compose.test.yaml down -v",
"test:db": "node test/migrate.ts",
```

Change `"typecheck"` to `"tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.test.json && tsc --noEmit -p tsconfig.server.json"`.

3b. `.gitattributes`. Shell scripts and container config must keep LF when checked out on Windows, or the containers cannot read them.

```
*.sh text eol=lf
deploy/** text eol=lf
server/migrations/*.sql text eol=lf
```

3c. `tsconfig.server.json`:

```json
/* The api runs in Node and imports the domain directly, so it gets Node's
   globals; the web half is still checked by tsconfig.json without them. */
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "types": ["node"]
  },
  "include": ["server/**/*.ts", "src/domain/**/*.ts", "src/wire.ts"]
}
```

3d. `deploy/postgres/init.sh`:

```sh
#!/bin/sh
# Runs once, when the data directory is empty (docker-entrypoint-initdb.d).
# Two databases, two login roles. `app` is the api's runtime role: it owns
# nothing, so row-level security applies to every query it makes. The app
# tables are created by migrations running as the superuser.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_password="$APP_DB_PASSWORD" -v kratos_password="$KRATOS_DB_PASSWORD" <<'SQL'
CREATE ROLE app LOGIN PASSWORD :'app_password';
CREATE DATABASE app;
REVOKE ALL ON DATABASE app FROM PUBLIC;
GRANT CONNECT ON DATABASE app TO app;
CREATE ROLE kratos LOGIN PASSWORD :'kratos_password';
CREATE DATABASE kratos OWNER kratos;
SQL
```

3e. `deploy/compose.test.yaml`:

```yaml
# A throwaway Postgres for `pnpm test:db`. Data lives in tmpfs and is gone on
# `pnpm db:test:down`. The init script is the production one.
name: income-test
services:
  postgres:
    image: postgres:17.11-alpine
    environment:
      POSTGRES_PASSWORD: test-admin
      APP_DB_PASSWORD: test-app
      KRATOS_DB_PASSWORD: test-kratos
    ports:
      - "127.0.0.1:54329:5432"
    tmpfs:
      - /var/lib/postgresql/data
    volumes:
      - ./postgres/init.sh:/docker-entrypoint-initdb.d/10-init.sh:ro
    healthcheck:
      # Over TCP and against `app`: the init-time server listens on the socket
      # only, so this stays red until init has finished and the real one is up.
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres -d app"]
      interval: 2s
      timeout: 3s
      retries: 30
```

3f. `server/db.ts`:

```ts
/* server/db.ts — the one way into Postgres.

   BIGINT holds money in minor units. postgres.js returns it as a string by
   default (it can exceed 2^53); our amounts never do, and every domain function
   expects a number, so it is parsed to one here, once.

   withUser() is the request transaction. Before any query runs it tells the
   RLS policies whose rows these are (set_config, scoped to the transaction)
   and — for writes — takes the per-user advisory lock, so two writes by the
   same person queue rather than both reading the same state and the second
   overwriting the first. */

import postgres from 'postgres';

export type Types = { bigint: number };
export type Sql = postgres.Sql<Types>;
export type Tx = postgres.TransactionSql<Types>;
/** A connection or a transaction — for functions that work in either. */
export type Db = postgres.ISql<Types>;

const BIGINT = {
  to: 20,
  from: [20],
  serialize: (value: number): string => String(value),
  parse: (raw: string): number => Number(raw)
};

export function connect(url: string, options: { max?: number } = {}): Sql {
  return postgres(url, {
    types: { bigint: BIGINT },
    max: options.max ?? 10,
    onnotice: () => {}
  });
}

export async function withUser<T>(
  sql: Sql, userId: string, work: (tx: Tx) => Promise<T>, options: { lock?: boolean } = {}
): Promise<T> {
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    if (options.lock) await tx`select pg_advisory_xact_lock(hashtext(${userId}::text))`;
    return work(tx);
  });
  return result as T;
}
```

3g. `server/migrate.ts`:

```ts
/* server/migrate.ts — plain .sql files, applied in name order, each once.

   All pending files run in one transaction behind an advisory lock, so two api
   processes starting together cannot both apply 002, and a file that fails
   leaves the database exactly as it was. */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './db.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/** An arbitrary constant: the lock id every migrator agrees on. */
const MIGRATION_LOCK = 7_272_026;

export async function migrate(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
    await tx`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      await tx.unsafe(readFileSync(join(dir, file), 'utf8')).simple();
      await tx`insert into schema_migrations (name) values (${file})`;
      applied.push(file);
    }
  });
  return applied;
}
```

3h. `server/schema.ts`:

```ts
/* server/schema.ts — how a domain record becomes a row and back.

   TABLES is the column list the sqlite store used, moved here unchanged: one
   list per collection, typed against its record so a misspelt field does not
   compile. Column names are the snake_case of the field names, and the kind of
   each column decides how a value is coerced on its way in.

   normalizeRecord() is the single definition of "what this record looks like
   once stored": exactly the declared fields, missing ones as null, numbers as
   numbers. The write path, the read path and the diff all go through it, so the
   changes a write returns are byte-for-byte what the next read will return. */

import { COLLECTION_KEYS } from '../src/domain/catalog.ts';
import type { AppState, CollectionKey, RecordOf } from '../src/domain/types.ts';

type ColumnsOf<K extends CollectionKey> = ReadonlyArray<Extract<keyof RecordOf<K>, string>>;
type TableMap = { readonly [K in CollectionKey]: ColumnsOf<K> };

export const TABLES: TableMap = {
  income: ['id', 'templateId', 'date', 'source', 'category', 'amount', 'accountId', 'method', 'notes'],
  incomeTemplates: ['id', 'source', 'category', 'frequency', 'payDay', 'expected', 'accountId', 'method', 'active', 'anchor', 'generatedThrough', 'notes'],
  billTemplates: ['id', 'name', 'category', 'provider', 'frequency', 'dueDay', 'expected', 'accountId', 'method', 'active', 'anchor', 'generatedThrough', 'notes'],
  bills: ['id', 'templateId', 'name', 'category', 'provider', 'period', 'dueDate', 'amount', 'accountId', 'units', 'unitRate', 'status', 'paidDate', 'method', 'notes'],
  purchases: ['id', 'goalId', 'date', 'item', 'category', 'amount', 'accountId', 'method', 'notes'],
  accounts: ['id', 'name', 'type', 'target', 'opening', 'notes'],
  goals: ['id', 'name', 'price', 'priority', 'boughtDate', 'notes'],
  savingsTx: ['id', 'date', 'accountId', 'fromAccountId', 'direction', 'amount', 'notes'],
  gold: ['id', 'date', 'direction', 'karat', 'grams', 'pricePerGram', 'amount', 'accountId', 'dealer', 'notes'],
  goldPrices: ['id', 'date', 'usdPerOz', 'egpPerUsd', 'egpPerGram24', 'source', 'fetchedAt']
};

export const TABLE_NAME: Readonly<Record<CollectionKey, string>> = {
  income: 'income', incomeTemplates: 'income_templates', billTemplates: 'bill_templates',
  bills: 'bills', purchases: 'purchases', accounts: 'accounts', goals: 'goals',
  savingsTx: 'savings_tx', gold: 'gold', goldPrices: 'gold_prices'
};

export type ColumnKind = 'text' | 'bigint' | 'int' | 'real' | 'bool';

/** Anything not named here is text — including every date, because '' is a
    legal date in the domain ("not paid yet") and a DATE column cannot hold it. */
const KINDS: Readonly<Record<string, ColumnKind>> = {
  amount: 'bigint', expected: 'bigint', target: 'bigint', opening: 'bigint',
  price: 'bigint', pricePerGram: 'bigint', egpPerGram24: 'bigint',
  priority: 'int', dueDay: 'int', payDay: 'int', karat: 'int',
  units: 'real', unitRate: 'real', grams: 'real', usdPerOz: 'real', egpPerUsd: 'real',
  active: 'bool'
};

export const kindOf = (column: string): ColumnKind => KINDS[column] ?? 'text';

/** As information_schema.columns.data_type spells them. */
export const PG_TYPE: Readonly<Record<ColumnKind, string>> = {
  text: 'text', bigint: 'bigint', int: 'integer', real: 'double precision', bool: 'boolean'
};

export const snake = (column: string): string =>
  column.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/* Forgiving in the same way the sqlite store was: a record written by an older
   build, or a backup edited by hand, may hold "21" where 21 belongs. It is
   stored as the number it obviously means; something that is no number at all
   is stored as null rather than refusing the whole import. `active` reads back
   as a boolean even when it was never set — readAll() did exactly that. */
export function coerce(kind: ColumnKind, value: unknown): string | number | boolean | null {
  if (kind === 'bool') return Boolean(value);
  if (value === undefined || value === null) return null;
  if (kind === 'text') return String(value);
  if (value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return kind === 'real' ? n : Math.round(n);
}

export function normalizeRecord<K extends CollectionKey>(collection: K, record: unknown): RecordOf<K> {
  const source = (record ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const column of TABLES[collection]) out[column] = coerce(kindOf(column), source[column]);
  return out as unknown as RecordOf<K>;
}

/** Every record in every collection as it would come back out of the database.
    Tests compare states through this, because a direct domain call and a round
    trip through Postgres differ only in undefined-versus-null. */
export function normalizeState(state: AppState): AppState {
  const out = { ...state } as Record<string, unknown>;
  for (const key of COLLECTION_KEYS) {
    out[key] = (state[key] as unknown[]).map((r) => normalizeRecord(key, r));
  }
  return out as unknown as AppState;
}
```

3i. `server/migrations/001_init.sql`:

```sql
-- 001_init.sql — the app schema.
--
-- Every per-user table is keyed (user_id, id): ids are TEXT and may be made in
-- the browser (uid()), and the composite key is what stops two users' ids from
-- ever colliding. `seq` keeps rows in the order they were first written, which
-- the domain relies on (lastAccountFor reads the newest entry) and which the
-- sqlite store kept for free. Columns mirror server/schema.ts; test/migrate.ts
-- checks that they agree.

create table users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  state_version bigint not null default 0
);

create table settings (
  user_id uuid primary key references users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb
);

create table income (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  template_id text,
  date text,
  period text generated always as (substr(date, 1, 7)) stored,
  source text,
  category text,
  amount bigint,
  account_id text,
  method text,
  notes text,
  primary key (user_id, id),
  unique (user_id, template_id, period)
);

create table income_templates (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  source text,
  category text,
  frequency text,
  pay_day integer,
  expected bigint,
  account_id text,
  method text,
  active boolean,
  anchor text,
  generated_through text,
  notes text,
  primary key (user_id, id)
);

create table bill_templates (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  name text,
  category text,
  provider text,
  frequency text,
  due_day integer,
  expected bigint,
  account_id text,
  method text,
  active boolean,
  anchor text,
  generated_through text,
  notes text,
  primary key (user_id, id)
);

create table bills (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  template_id text,
  name text,
  category text,
  provider text,
  period text,
  due_date text,
  amount bigint,
  account_id text,
  units double precision,
  unit_rate double precision,
  status text,
  paid_date text,
  method text,
  notes text,
  primary key (user_id, id),
  unique (user_id, template_id, period)
);

create table purchases (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  goal_id text,
  date text,
  item text,
  category text,
  amount bigint,
  account_id text,
  method text,
  notes text,
  primary key (user_id, id)
);

create table accounts (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  name text,
  type text,
  target bigint,
  opening bigint,
  notes text,
  -- Phase 3. The repository writes the user's base currency on insert; the
  -- default only covers a row written some other way.
  currency char(3) not null default 'EGP',
  primary key (user_id, id)
);

create table goals (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  name text,
  price bigint,
  priority integer,
  bought_date text,
  notes text,
  primary key (user_id, id)
);

create table savings_tx (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  date text,
  account_id text,
  from_account_id text,
  direction text,
  amount bigint,
  notes text,
  primary key (user_id, id)
);

create table gold (
  user_id uuid not null references users (id) on delete cascade,
  seq bigint generated always as identity,
  id text not null,
  date text,
  direction text,
  karat integer,
  grams double precision,
  price_per_gram bigint,
  amount bigint,
  account_id text,
  dealer text,
  notes text,
  primary key (user_id, id)
);

-- Phase 3, schema only.
create table fx_rates (
  user_id uuid not null references users (id) on delete cascade,
  date date not null,
  currency char(3) not null,
  rate_to_base numeric not null,
  primary key (user_id, date, currency)
);

-- Shared by everyone: the world price is the same for all users. Written by
-- the daily job, read into every state.
create table gold_prices (
  date text primary key,
  usd_per_oz double precision,
  egp_per_usd double precision,
  egp_per_gram24 bigint,
  source text,
  fetched_at text
);

create index income_by_date on income (user_id, date);
create index purchases_by_date on purchases (user_id, date);
create index bills_by_period on bills (user_id, period);
create index savings_tx_by_date on savings_tx (user_id, date);
create index gold_by_date on gold (user_id, date);

-- Row-level security: the backstop behind server/repo.ts, which already names
-- user_id in every statement. current_setting(..., true) is null when nothing
-- was set, and null matches no row, so a query outside withUser() sees nothing.
do $$
declare t text;
begin
  foreach t in array array['settings', 'income', 'income_templates', 'bill_templates', 'bills',
                           'purchases', 'accounts', 'goals', 'savings_tx', 'gold', 'fx_rates'] loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy own_rows on %I '
      'using (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) '
      'with check (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', t);
  end loop;
end $$;

alter table users enable row level security;
create policy own_row on users
  using (id = nullif(current_setting('app.user_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.user_id', true), '')::uuid);

grant usage on schema public to app;
grant select, insert, update, delete on
  users, settings, income, income_templates, bill_templates, bills, purchases,
  accounts, goals, savings_tx, gold, fx_rates, gold_prices
to app;
```

3j. `test/support/db.ts`:

```ts
/* test/support/db.ts — a clean schema per suite, on the disposable Postgres
   from deploy/compose.test.yaml (`pnpm db:test:up`).

   Two connections, as in production: `admin` is the superuser that migrates
   (and that tests use to look underneath the api), `sql` is the `app` role the
   api runs as — the one RLS applies to. */

import { connect } from '../../server/db.ts';
import type { Sql } from '../../server/db.ts';
import { migrate } from '../../server/migrate.ts';

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:test-admin@127.0.0.1:54329/app';
export const APP_URL = process.env.TEST_APP_URL ?? 'postgres://app:test-app@127.0.0.1:54329/app';

export interface TestDb {
  admin: Sql;
  sql: Sql;
  applied: string[];
  close(): Promise<void>;
}

export async function freshDatabase(): Promise<TestDb> {
  const admin = connect(ADMIN_URL, { max: 1 });
  await admin.unsafe('drop schema if exists public cascade; create schema public;').simple();
  const applied = await migrate(admin);
  const sql = connect(APP_URL, { max: 4 });
  return { admin, sql, applied, close: async () => { await sql.end(); await admin.end(); } };
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm db:test:up
node test/migrate.ts
pnpm typecheck
```

Expected: `all checks passed`, and typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add -A .gitattributes tsconfig.server.json package.json pnpm-lock.yaml deploy/compose.test.yaml deploy/postgres server test/migrate.ts test/support/db.ts
git commit -m "feat(server): postgres schema with RLS, migration runner, test database

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The wire contract and `diffState()`

**Files:**
- Create: `src/wire.ts`, `server/diff.ts`
- Modify: `package.json` (test script)
- Test: `test/diff.ts`

**Interfaces:**
- Consumes: `normalizeRecord` and `normalizeState` from `server/schema.ts` (Task 4).
- Produces `src/wire.ts`:
  - `type UserCollection = Exclude<CollectionKey, 'goldPrices'>`, `USER_COLLECTIONS: readonly UserCollection[]`, `isUserCollection(name: string): name is UserCollection`
  - `type WireRecord = { id: Id } & Record<string, unknown>`, `interface CollectionChange { upserts: WireRecord[]; deletes: Id[] }`, `type Changes = Partial<Record<UserCollection, CollectionChange>>`
  - `interface StateDiff { changes: Changes; settings: Settings | null }`
  - `interface MutationResponse<R = unknown> { version: number; changes: Changes; settings?: Settings; result: R }`
  - `interface StateResponse { version: number; state: AppState }`, `interface MeResponse { email: string; verified: boolean; version: number }`, `interface ErrorBody { error: { code: string; message: string } }`
  - `applyChanges(state: AppState, update: { changes: Changes; settings?: Settings | null }): AppState`
- Produces `server/diff.ts`: `diffState(before: AppState, after: AppState): StateDiff`, `isEmptyDiff(diff: StateDiff): boolean`, and `sameJson(a: unknown, b: unknown): boolean` (key-order-insensitive).

- [ ] **Step 1: Write the failing test**

`test/diff.ts`:

```ts
/* Diff test: a write reaches the database and the screen as a diff, so the
   diff has to be exactly the change — nothing missing, nothing spurious — and
   applying it to the old state has to give the new one.

   Run:  node test/diff.ts */

import { borrow } from '../src/domain/debt.ts';
import { currentPeriod, shiftPeriod } from '../src/domain/period.ts';
import { blankState, remove, updateSettings, upsert } from '../src/domain/records.ts';
import { catchUp } from '../src/domain/recurring.ts';
import type { AppState } from '../src/domain/types.ts';
import { applyChanges } from '../src/wire.ts';
import { diffState, isEmptyDiff, sameJson } from '../server/diff.ts';
import { normalizeState } from '../server/schema.ts';
import { check, finish, title } from './support/check.ts';

/** The round trip every write makes: diff on the server, apply on the client. */
const replay = (before: AppState, after: AppState): AppState => applyChanges(before, diffState(before, after));
const same = (a: AppState, b: AppState): boolean => sameJson(normalizeState(a), normalizeState(b));

let s: AppState = blankState();
s = upsert(s, 'accounts', { id: 'a1', name: 'Card', type: 'Current Account', opening: 1000, target: 0, notes: '' }).state;
s = upsert(s, 'accounts', { id: 'a2', name: 'Pot', type: 'Savings', opening: 0, target: 0, notes: '' }).state;
s = upsert(s, 'savingsTx', { id: 't1', date: '2026-07-01', accountId: 'a2', fromAccountId: 'a1', direction: 'transfer', amount: 100, notes: '' }).state;

title('nothing changed');
check('the same state diffs to nothing', isEmptyDiff(diffState(s, s)), true);
const rewritten = upsert(s, 'accounts', { id: 'a1', name: 'Card' }).state;
check('rewriting a record with its own values is no change', isEmptyDiff(diffState(s, rewritten)), true);

title('one insert');
const added = upsert(s, 'purchases', { id: 'p1', date: '2026-07-02', item: 'Tea', amount: 250, accountId: 'a1' }).state;
const d1 = diffState(s, added);
check('only purchases changed', Object.keys(d1.changes), ['purchases']);
check('one upsert, no deletes', [d1.changes.purchases?.upserts.length, d1.changes.purchases?.deletes], [1, []]);
check('missing fields travel as null', d1.changes.purchases?.upserts[0]?.['notes'], null);
check('replaying gives the new state', same(replay(s, added), added), true);

title('a cascade');
const gone = remove(s, 'accounts', 'a2');
const d2 = diffState(s, gone);
check('the account and its movement are both deleted',
  [d2.changes.accounts?.deletes, d2.changes.savingsTx?.deletes], [['a2'], ['t1']]);
check('replaying gives the new state', same(replay(s, gone), gone), true);

title('composite writes');
const borrowed = borrow(s, { name: 'Bank', amount: 5000, date: '2026-07-03', intoAccountId: 'a1' });
const d3 = diffState(s, borrowed);
check('borrowing writes an account and a movement',
  [d3.changes.accounts?.upserts.length, d3.changes.savingsTx?.upserts.length], [1, 1]);
check('replaying gives the new state', same(replay(s, borrowed), borrowed), true);

const anchor = shiftPeriod(currentPeriod(), -2);
const withTemplate = upsert(s, 'billTemplates', {
  id: 'bt1', name: 'Rent', category: 'Rent', provider: '', frequency: 'Monthly', dueDay: 5,
  expected: 900, accountId: 'a1', method: '', active: true, anchor, generatedThrough: '', notes: ''
}).state;
const swept = catchUp(withTemplate).state;
const d4 = diffState(withTemplate, swept);
check('catch-up writes three bills and moves the template mark',
  [d4.changes.bills?.upserts.length, d4.changes.billTemplates?.upserts.length], [3, 1]);
check('replaying gives the new state', same(replay(withTemplate, swept), swept), true);

title('settings');
const patched = updateSettings(s, { savingsGoalRate: 30 });
const d5 = diffState(s, patched);
check('a settings change is carried whole', d5.settings?.savingsGoalRate, 30);
check('and no collection changed', Object.keys(d5.changes), []);
const reordered = { ...s, settings: Object.fromEntries(Object.entries(s.settings).reverse()) } as AppState;
check('key order alone is not a change', diffState(s, reordered).settings, null);

title('gold prices are not a user collection');
const priced: AppState = { ...s, goldPrices: [{ id: 'gpr_2026-07-01', date: '2026-07-01', usdPerOz: 1, egpPerUsd: 1, egpPerGram24: 1, source: '', fetchedAt: '' }] };
check('they never appear in a diff', isEmptyDiff(diffState(s, priced)), true);

title('a malformed import with a repeated id');
const twice = { ...s, purchases: [
  { id: 'p9', goalId: null, date: '2026-07-01', item: 'A', category: '', amount: 1, accountId: '', method: '', notes: '' },
  { id: 'p9', goalId: null, date: '2026-07-01', item: 'B', category: '', amount: 2, accountId: '', method: '', notes: '' }
] } as AppState;
check('is written once, last copy wins',
  diffState(s, twice).changes.purchases?.upserts.map((r) => r['item']), ['B']);

finish();
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node test/diff.ts`
Expected: `ERR_MODULE_NOT_FOUND` for `../src/wire.ts`.

- [ ] **Step 3: Implement**

`src/wire.ts`:

```ts
/* wire.ts — what travels between the browser and the api, shared by both.

   A write answers with a diff rather than the whole state: the collections it
   touched, as records to put in place and ids to take out, plus the settings
   object if that changed. applyChanges() is the client's half of that, and is
   pure for the same reason the domain is — a signal only redraws when it is
   handed a new object. */

import type { AppState, CollectionKey, Id, Settings } from './domain/types.ts';

/** Every collection a user owns. Gold prices are shared and read-only. */
export type UserCollection = Exclude<CollectionKey, 'goldPrices'>;

export const USER_COLLECTIONS: readonly UserCollection[] = [
  'income', 'incomeTemplates', 'billTemplates', 'bills', 'purchases',
  'accounts', 'goals', 'savingsTx', 'gold'
];

export const isUserCollection = (name: string): name is UserCollection =>
  (USER_COLLECTIONS as readonly string[]).includes(name);

export type WireRecord = { id: Id } & Record<string, unknown>;

export interface CollectionChange {
  upserts: WireRecord[];
  deletes: Id[];
}

export type Changes = Partial<Record<UserCollection, CollectionChange>>;

export interface StateDiff {
  changes: Changes;
  settings: Settings | null;
}

export interface MutationResponse<R = unknown> {
  /** users.state_version after this write; unchanged when nothing was written. */
  version: number;
  changes: Changes;
  settings?: Settings;
  /** Whatever the action returns: the saved record, a count, a difference. */
  result: R;
}

export interface StateResponse { version: number; state: AppState }

export interface MeResponse { email: string; verified: boolean; version: number }

export interface ErrorBody { error: { code: string; message: string } }

export function applyChanges(
  state: AppState, update: { changes: Changes; settings?: Settings | null }
): AppState {
  let next = state;
  for (const key of USER_COLLECTIONS) {
    const change = update.changes[key];
    if (!change) continue;
    const gone = new Set(change.deletes);
    const incoming = new Map(change.upserts.map((r) => [r.id, r]));
    const list: { id: Id }[] = (state[key] as ReadonlyArray<{ id: Id }>)
      .filter((r) => !gone.has(r.id))
      .map((r) => incoming.get(r.id) ?? r);
    const present = new Set(list.map((r) => r.id));
    for (const r of change.upserts) if (!present.has(r.id)) list.push(r);
    next = { ...next, [key]: list } as AppState;
  }
  if (update.settings) next = { ...next, settings: update.settings };
  return next;
}
```

`server/diff.ts`:

```ts
/* server/diff.ts — what a domain call changed, by id.

   Domain functions return a new state and leave every untouched record (and
   every untouched collection) as the very same object, so most of the work is
   reference checks. A record that is a new object is compared in its stored
   form, so re-saving something with its own values writes nothing. */

import type { AppState, Id, Settings } from '../src/domain/types.ts';
import { USER_COLLECTIONS } from '../src/wire.ts';
import type { Changes, StateDiff, WireRecord } from '../src/wire.ts';
import { normalizeRecord } from './schema.ts';

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
  }
  return value;
};

/** Equal as JSON, whatever order the keys are in (jsonb reorders them). */
export const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

export function diffState(before: AppState, after: AppState): StateDiff {
  const changes: Changes = {};
  for (const key of USER_COLLECTIONS) {
    if (before[key] === after[key]) continue;
    const previous = new Map((before[key] as ReadonlyArray<{ id: Id }>).map((r) => [r.id, r]));
    /* Last copy wins for a repeated id: one INSERT … ON CONFLICT cannot touch
       the same row twice, and a hand-edited backup can repeat one. */
    const latest = new Map<Id, { id: Id }>();
    for (const r of after[key] as ReadonlyArray<{ id: Id }>) latest.set(r.id, r);

    const upserts: WireRecord[] = [];
    for (const [id, record] of latest) {
      const old = previous.get(id);
      if (old === record) continue;
      const stored = normalizeRecord(key, record) as unknown as WireRecord;
      if (old && sameJson(stored, normalizeRecord(key, old))) continue;
      upserts.push(stored);
    }
    const deletes = [...previous.keys()].filter((id) => !latest.has(id));
    if (upserts.length || deletes.length) changes[key] = { upserts, deletes };
  }

  const settings: Settings | null =
    before.settings === after.settings || sameJson(before.settings, after.settings) ? null : after.settings;
  return { changes, settings };
}

export const isEmptyDiff = (diff: StateDiff): boolean =>
  !diff.settings && Object.keys(diff.changes).length === 0;
```

Append ` && node test/diff.ts` to the `"test"` script.

- [ ] **Step 4: Run, expect PASS**

Run: `node test/diff.ts && pnpm typecheck`
Expected: `all checks passed`, and typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add src/wire.ts server/diff.ts test/diff.ts package.json
git commit -m "feat: wire contract and per-collection state diff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The repository (`server/repo.ts`) and RLS isolation

**Files:**
- Create: `server/repo.ts`, `test/support/fixture.ts`
- Modify: `package.json` (`test:db` script)
- Test: `test/repo.ts`

**Interfaces:**
- Consumes: `Sql`, `Tx`, `Db` and `withUser` (Task 4); `TABLES`, `TABLE_NAME`, `kindOf`, `PG_TYPE`, `snake`, `coerce` and `normalizeRecord` (Task 4); `diffState`, `isEmptyDiff` and `sameJson` (Task 5); `USER_COLLECTIONS`, `StateDiff`, `WireRecord` and `UserCollection` (Task 5).
- Produces `server/repo.ts`:
  - `interface Loaded { state: AppState; version: number }`
  - `ensureUser(userId: string, tx: Tx): Promise<void>` and `readVersion(userId: string, tx: Tx): Promise<number>`
  - `listRecords<K extends UserCollection>(userId: string, tx: Tx, collection: K): Promise<RecordOf<K>[]>`
  - `getRecord<K extends UserCollection>(userId: string, tx: Tx, collection: K, id: string): Promise<RecordOf<K> | null>`
  - `loadState(userId: string, tx: Tx): Promise<Loaded>`
  - `writeDiff(userId: string, tx: Tx, diff: StateDiff, baseCurrency: string): Promise<number>` returns the new version, unchanged when the diff is empty.
  - `saveState(userId: string, tx: Tx, state: AppState): Promise<number>`
  - `baseCurrencyOf(settings: Settings): string`
  - `loadGoldPrices(db: Db): Promise<GoldPrice[]>`, `upsertGoldPrice(db: Db, price: GoldPrice): Promise<void>` and `pruneGoldPrices(db: Db, keep?: number): Promise<void>`
- Produces `test/support/fixture.ts`: `fixtureState(): AppState`, `fixtureBackup(): string`.

- [ ] **Step 1: Write the failing test**

`test/support/fixture.ts`:

```ts
/* test/support/fixture.ts — one realistic person, built through the domain so
   every derived field (bill periods and statuses, template marks) is exactly
   what the app itself would have written. Used by the repo and api suites, and
   exported as a backup file for the browser suite's import check. */

import { exportJSON } from '../../src/domain/backup.ts';
import { borrow } from '../../src/domain/debt.ts';
import { saveGoal } from '../../src/domain/forecast.ts';
import { blankState, upsert } from '../../src/domain/records.ts';
import type { Draft } from '../../src/domain/records.ts';
import type { AppState, CollectionKey } from '../../src/domain/types.ts';

export function fixtureState(): AppState {
  let s = blankState();
  const put = <K extends CollectionKey>(collection: K, record: Draft<K>): void => {
    s = upsert(s, collection, record).state;
  };
  put('accounts', { id: 'acc_card', name: 'Salary card', type: 'Current Account', opening: 1500000, target: 0, notes: '' });
  put('accounts', { id: 'acc_pot', name: 'Emergency fund', type: 'Emergency Fund', opening: 500000, target: 5000000, notes: 'six months' });
  put('incomeTemplates', { id: 'itp_sal', source: 'Employer', category: 'Salary', frequency: 'Monthly', payDay: 25, expected: 4000000, accountId: 'acc_card', method: 'Bank Transfer', active: true, anchor: '2026-05', generatedThrough: '2026-07', notes: '' });
  put('billTemplates', { id: 'tpl_rent', name: 'Rent', category: 'Rent', provider: 'Landlord', frequency: 'Monthly', dueDay: 1, expected: 1200000, accountId: 'acc_card', method: 'Bank Transfer', active: true, anchor: '2026-05', generatedThrough: '2026-07', notes: '' });
  for (const p of ['2026-05', '2026-06', '2026-07']) {
    put('income', { id: `inc_${p}`, templateId: 'itp_sal', date: `${p}-25`, source: 'Employer', category: 'Salary', amount: 4000000, accountId: 'acc_card', method: 'Bank Transfer', notes: '' });
    put('bills', { id: `bil_${p}`, templateId: 'tpl_rent', name: 'Rent', category: 'Rent', provider: 'Landlord', dueDate: `${p}-01`, amount: 1200000, accountId: 'acc_card', units: null, unitRate: null, paidDate: p === '2026-07' ? '' : `${p}-01`, method: 'Bank Transfer', notes: '' });
  }
  put('bills', { id: 'bil_elec', templateId: null, name: 'Electricity', category: 'Electricity', provider: 'Grid', dueDate: '2026-07-20', amount: 85075, accountId: 'acc_card', units: 412.5, unitRate: 2.06, paidDate: '2026-07-19', method: 'Card', notes: 'Ünïcode ✓' });
  put('purchases', { id: 'pur_food', goalId: null, date: '2026-07-03', item: 'Groceries', category: 'Groceries', amount: 245050, accountId: 'acc_card', method: 'Card', notes: '' });
  put('savingsTx', { id: 'sav_1', date: '2026-07-26', accountId: 'acc_pot', fromAccountId: 'acc_card', direction: 'transfer', amount: 800000, notes: '' });
  put('gold', { id: 'gld_1', date: '2026-06-10', direction: 'buy', karat: 21, grams: 8.25, pricePerGram: 590000, amount: 4867500, accountId: 'acc_card', dealer: 'Souq', notes: '' });
  put('goals', { id: 'gol_gpu', name: 'Graphics card', price: 4500000, priority: 1, boughtDate: '', notes: '' });
  put('goals', { id: 'gol_desk', name: 'Desk', price: 900000, priority: 2, boughtDate: '', notes: '' });
  s = saveGoal(s, { id: 'gol_desk', boughtDate: '2026-07-12' }, { accountId: 'acc_card', method: 'Card' });
  s = borrow(s, { name: 'Brother', amount: 1000000, date: '2026-07-05', intoAccountId: 'acc_card' });
  return { ...s, settings: { ...s.settings, savingsGoalRate: 25 } };
}

export const fixtureBackup = (): string => exportJSON(fixtureState());
```

`test/repo.ts`:

```ts
/* Repository test: a state written to Postgres reads back as the same state,
   writes are exactly the diff, and one user's rows are invisible to another —
   through the repository, and through RLS with the repository bypassed.

   Needs the test database:  pnpm db:test:up
   Run:  node test/repo.ts */

import { blankState, remove, upsert } from '../src/domain/records.ts';
import type { AppState } from '../src/domain/types.ts';
import { withUser } from '../server/db.ts';
import type { Tx } from '../server/db.ts';
import { diffState, sameJson } from '../server/diff.ts';
import {
  ensureUser, getRecord, listRecords, loadGoldPrices, loadState, readVersion, saveState,
  upsertGoldPrice, writeDiff
} from '../server/repo.ts';
import { normalizeState } from '../server/schema.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';
import { fixtureState } from './support/fixture.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const db = await freshDatabase();
const as = <T>(user: string, work: (tx: Tx) => Promise<T>): Promise<T> => withUser(db.sql, user, work);

await as(A, (tx) => ensureUser(A, tx));
await as(B, (tx) => ensureUser(B, tx));

title('round trip');
const fixture = fixtureState();
const v1 = await as(A, (tx) => saveState(A, tx, fixture));
const loaded = await as(A, (tx) => loadState(A, tx));
check('the version moved once', [v1, loaded.version], [1, 1]);
const comparable = (s: AppState) => ({ ...normalizeState(s), settings: { ...s.settings, baseCurrency: 'EGP' } });
check('every collection and setting reads back exactly', sameJson(comparable(loaded.state), comparable(fixture)), true);
check('money is a number, not a string', typeof loaded.state.income[0]?.amount, 'number');
check('a fractional meter reading survives', loaded.state.bills.find((b) => b.id === 'bil_elec')?.units, 412.5);
check('an empty date stays empty', loaded.state.bills.find((b) => b.id === 'bil_2026-07')?.paidDate, '');
check('rows come back in the order they were written',
  loaded.state.accounts.map((a) => a.id), fixture.accounts.map((a) => a.id));
check('settings gain a base currency from the currency code',
  (loaded.state.settings as unknown as { baseCurrency?: string }).baseCurrency, 'EGP');
const [currency] = await db.admin<{ currency: string }[]>`select currency from accounts where user_id = ${A}::uuid limit 1`;
check('accounts are written in the base currency', currency?.currency, 'EGP');

title('writes are the diff');
check('saving an unchanged state writes nothing', await as(A, (tx) => saveState(A, tx, loaded.state)), 1);
const next = remove(upsert(loaded.state, 'purchases', { id: 'pur_food', amount: 1 }).state, 'goals', 'gol_gpu');
const v3 = await as(A, (tx) => writeDiff(A, tx, diffState(loaded.state, next), 'EGP'));
const after = await as(A, (tx) => loadState(A, tx));
check('one write, one version', v3, 2);
check('the update landed', after.state.purchases.find((p) => p.id === 'pur_food')?.amount, 1);
check('the delete landed', after.state.goals.some((g) => g.id === 'gol_gpu'), false);

title('isolation through the repository');
check('B sees none of A\'s rows', (await as(B, (tx) => loadState(B, tx))).state.income.length, 0);
check('B cannot fetch A\'s record by id', await as(B, (tx) => getRecord(B, tx, 'purchases', 'pur_food')), null);
await as(B, (tx) => saveState(B, tx, upsert(blankState(), 'purchases', { id: 'pur_food', item: 'B\'s own', amount: 7 }).state));
check('B may use the same id for its own record',
  (await as(B, (tx) => listRecords(B, tx, 'purchases'))).map((p) => p.item), ['B\'s own']);
check('and A\'s record is untouched', (await as(A, (tx) => getRecord(A, tx, 'purchases', 'pur_food')))?.amount, 1);
check('versions are per user',
  [await as(A, (tx) => readVersion(A, tx)), await as(B, (tx) => readVersion(B, tx))], [2, 1]);

title('isolation by RLS alone (repository bypassed)');
const raw = await as(B, async (tx) => ({
  read: (await tx`select id from income where user_id = ${A}::uuid`).length,
  updated: (await tx`update purchases set amount = 0 where user_id = ${A}::uuid`).count,
  deleted: (await tx`delete from accounts where user_id = ${A}::uuid`).count,
  users: (await tx`select id from users`).length
}));
check('B reads none of A\'s rows even when it asks for them by user_id', raw.read, 0);
check('B updates none of them', raw.updated, 0);
check('B deletes none of them', raw.deleted, 0);
check('B sees only its own users row', raw.users, 1);
let refused = '';
try {
  await as(B, async (tx) => { await tx`insert into purchases (user_id, id) values (${A}::uuid, 'planted')`; });
} catch (err) { refused = (err as { code?: string }).code ?? ''; }
check('B cannot write a row into A\'s data', refused, '42501');
const outside = await db.sql<{ n: number }[]>`select count(*)::int as n from income`;
check('with no user set, nothing is visible at all', outside[0]?.n, 0);
check('A\'s data is all still there',
  (await as(A, (tx) => listRecords(A, tx, 'accounts'))).length, fixture.accounts.length);

title('shared gold prices');
await upsertGoldPrice(db.sql, { id: 'gpr_2026-07-29', date: '2026-07-29', usdPerOz: 3110.34768, egpPerUsd: 10, egpPerGram24: 100000, source: 'test', fetchedAt: '2026-07-29T08:00:00.000Z' });
await upsertGoldPrice(db.sql, { id: 'gpr_2026-07-29', date: '2026-07-29', usdPerOz: 3200, egpPerUsd: 10, egpPerGram24: 102890, source: 'test', fetchedAt: '2026-07-29T09:00:00.000Z' });
check('a same-day reading replaces the earlier one',
  (await loadGoldPrices(db.sql)).map((p) => [p.id, p.egpPerGram24]), [['gpr_2026-07-29', 102890]]);
check('every user\'s state carries them', (await as(B, (tx) => loadState(B, tx))).state.goldPrices.length, 1);

await db.close();
finish();
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node test/repo.ts`
Expected: `ERR_MODULE_NOT_FOUND` for `../server/repo.ts`.

- [ ] **Step 3: Implement**

`server/repo.ts`:

```ts
/* server/repo.ts — every SQL statement the api runs against user data.

   The user id is the first argument of every per-user function, and every
   statement names it: that is the isolation rule. RLS (001_init.sql) is the
   backstop if a statement here ever forgets — the transaction from withUser()
   has already told Postgres whose rows these are.

   Reads come back through normalizeRecord(), so a record looks exactly as the
   diff (server/diff.ts) describes it and exactly as the browser will hold it.
   Every parameter is cast to its column type in the SQL, so nothing depends on
   how the driver guesses a JavaScript value's type. */

import type postgres from 'postgres';
import { migrate as migrateState } from '../src/domain/records.ts';
import type { AppState, GoldPrice, RecordOf, Settings } from '../src/domain/types.ts';
import { USER_COLLECTIONS } from '../src/wire.ts';
import type { StateDiff, UserCollection, WireRecord } from '../src/wire.ts';
import type { Db, Tx } from './db.ts';
import { diffState, isEmptyDiff } from './diff.ts';
import { coerce, kindOf, normalizeRecord, PG_TYPE, snake, TABLE_NAME, TABLES } from './schema.ts';

export interface Loaded {
  state: AppState;
  version: number;
}

/** Rows per INSERT. 500 rows of the widest table stays far below Postgres's
    65 535-parameter limit. */
const BATCH = 500;

const quoted = (name: string): string => `"${name}"`;
const selectList = (collection: UserCollection): string =>
  TABLES[collection].map((c) => quoted(snake(c))).join(', ');

function fromRow<K extends UserCollection>(collection: K, row: Record<string, unknown>): RecordOf<K> {
  const record: Record<string, unknown> = {};
  for (const column of TABLES[collection]) record[column] = row[snake(column)];
  return normalizeRecord(collection, record);
}

export async function ensureUser(userId: string, tx: Tx): Promise<void> {
  await tx`insert into users (id) values (${userId}::uuid) on conflict (id) do nothing`;
}

export async function readVersion(userId: string, tx: Tx): Promise<number> {
  const [row] = await tx<{ state_version: number }[]>`
    select state_version from users where id = ${userId}::uuid`;
  return Number(row?.state_version ?? 0);
}

export async function listRecords<K extends UserCollection>(
  userId: string, tx: Tx, collection: K
): Promise<RecordOf<K>[]> {
  const rows = await tx.unsafe<Record<string, unknown>[]>(
    `select ${selectList(collection)} from ${quoted(TABLE_NAME[collection])} where user_id = $1::uuid order by seq`,
    [userId]
  );
  return rows.map((row) => fromRow(collection, row));
}

export async function getRecord<K extends UserCollection>(
  userId: string, tx: Tx, collection: K, id: string
): Promise<RecordOf<K> | null> {
  const rows = await tx.unsafe<Record<string, unknown>[]>(
    `select ${selectList(collection)} from ${quoted(TABLE_NAME[collection])} where user_id = $1::uuid and id = $2::text`,
    [userId, id]
  );
  return rows[0] ? fromRow(collection, rows[0]) : null;
}

export async function loadState(userId: string, tx: Tx): Promise<Loaded> {
  const version = await readVersion(userId, tx);
  const [settingsRow] = await tx<{ data: Record<string, unknown> }[]>`
    select data from settings where user_id = ${userId}::uuid`;
  const loaded: Record<string, unknown> = { settings: settingsRow?.data ?? {} };
  for (const key of USER_COLLECTIONS) loaded[key] = await listRecords(userId, tx, key);
  loaded['goldPrices'] = await loadGoldPrices(tx);
  // The same forgiving migrate() a backup goes through: it fills in any setting
  // the stored copy predates.
  return { state: migrateState(loaded), version };
}

/* The base currency is phase-3 data with no screen yet. Until there is one it
   is whatever currency code the user had when it was first stored. */
export function baseCurrencyOf(settings: Settings): string {
  const stored = (settings as Settings & { baseCurrency?: unknown }).baseCurrency;
  const code = String(stored || settings.currencyCode || 'EGP').toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'EGP';
}

async function upsertRows(
  userId: string, tx: Tx, collection: UserCollection, rows: readonly WireRecord[], baseCurrency: string
): Promise<void> {
  const fields = TABLES[collection];
  /* currency is written on insert only: changing the base currency later must
     not silently relabel accounts that already exist. */
  const extra = collection === 'accounts' ? [{ name: 'currency', type: 'char(3)' }] : [];
  const names = ['user_id', ...fields.map(snake), ...extra.map((e) => e.name)];
  const types = ['uuid', ...fields.map((f) => PG_TYPE[kindOf(f)]), ...extra.map((e) => e.type)];
  const updates = fields.filter((f) => f !== 'id')
    .map((f) => `${quoted(snake(f))} = excluded.${quoted(snake(f))}`).join(', ');

  for (let start = 0; start < rows.length; start += BATCH) {
    const params: (string | number | boolean | null)[] = [];
    const tuples = rows.slice(start, start + BATCH).map((record) => {
      const values = [userId, ...fields.map((f) => coerce(kindOf(f), record[f])), ...extra.map(() => baseCurrency)];
      const marks = values.map((value, i) => { params.push(value); return `$${params.length}::${types[i]}`; });
      return `(${marks.join(', ')})`;
    });
    await tx.unsafe(
      `insert into ${quoted(TABLE_NAME[collection])} (${names.map(quoted).join(', ')}) values ${tuples.join(', ')} ` +
      `on conflict (user_id, id) do update set ${updates}`,
      params
    );
  }
}

/* Deletes first, across every collection, then upserts: a regenerated bill
   reuses its template and month, and the unique key on (template, period) would
   refuse the new row while the old one still existed. */
export async function writeDiff(userId: string, tx: Tx, diff: StateDiff, baseCurrency: string): Promise<number> {
  if (isEmptyDiff(diff)) return readVersion(userId, tx);
  for (const key of USER_COLLECTIONS) {
    const ids = diff.changes[key]?.deletes;
    if (ids?.length) {
      await tx`delete from ${tx(TABLE_NAME[key])} where user_id = ${userId}::uuid and id = any(${ids}::text[])`;
    }
  }
  for (const key of USER_COLLECTIONS) {
    const rows = diff.changes[key]?.upserts;
    if (rows?.length) await upsertRows(userId, tx, key, rows, baseCurrency);
  }
  if (diff.settings) {
    const data = { ...diff.settings, baseCurrency: baseCurrencyOf(diff.settings) };
    await tx`insert into settings (user_id, data) values (${userId}::uuid, ${tx.json(data as unknown as postgres.JSONValue)})
      on conflict (user_id) do update set data = excluded.data`;
  }
  const [row] = await tx<{ state_version: number }[]>`
    update users set state_version = state_version + 1 where id = ${userId}::uuid returning state_version`;
  return Number(row?.state_version ?? 0);
}

/** Makes the stored state equal `state`, writing only what differs. */
export async function saveState(userId: string, tx: Tx, state: AppState): Promise<number> {
  const current = await loadState(userId, tx);
  return writeDiff(userId, tx, diffState(current.state, state), baseCurrencyOf(state.settings));
}

/* --------------------------------------------------------- gold prices */

export async function loadGoldPrices(db: Db): Promise<GoldPrice[]> {
  const rows = await db<Record<string, unknown>[]>`
    select date, usd_per_oz, egp_per_usd, egp_per_gram24, source, fetched_at from gold_prices order by date`;
  return rows.map((row) => normalizeRecord('goldPrices', {
    id: `gpr_${String(row['date'])}`,
    date: row['date'],
    usdPerOz: row['usd_per_oz'],
    egpPerUsd: row['egp_per_usd'],
    egpPerGram24: row['egp_per_gram24'],
    source: row['source'],
    fetchedAt: row['fetched_at']
  }));
}

export async function upsertGoldPrice(db: Db, price: GoldPrice): Promise<void> {
  await db`insert into gold_prices (date, usd_per_oz, egp_per_usd, egp_per_gram24, source, fetched_at)
    values (${price.date}::text, ${price.usdPerOz}::double precision, ${price.egpPerUsd}::double precision,
            ${price.egpPerGram24}::bigint, ${price.source}::text, ${price.fetchedAt}::text)
    on conflict (date) do update set usd_per_oz = excluded.usd_per_oz, egp_per_usd = excluded.egp_per_usd,
      egp_per_gram24 = excluded.egp_per_gram24, source = excluded.source, fetched_at = excluded.fetched_at`;
}

/** Two years of daily readings is plenty to chart against (the domain's
    MAX_GOLD_PRICES said the same); older rows only grow the table. */
export async function pruneGoldPrices(db: Db, keep = 800): Promise<void> {
  await db`delete from gold_prices where date not in (select date from gold_prices order by date desc limit ${keep})`;
}
```

Change `"test:db"` to `"node test/migrate.ts && node test/repo.ts"`.

- [ ] **Step 4: Run, expect PASS**

Run: `node test/repo.ts && pnpm typecheck`
Expected: `all checks passed`. `42501` (`insufficient_privilege`) is what Postgres raises when a row fails an RLS `WITH CHECK`.

- [ ] **Step 5: Commit**

```bash
git add server/repo.ts test/repo.ts test/support/fixture.ts package.json
git commit -m "feat(server): repository with diff writes, ordered reads and RLS isolation tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: API skeleton: session, CSRF, rate limit, errors, `/api/me`, `/api/state`

**Files:**
- Create: `server/errors.ts`, `server/kratos.ts`, `server/session.ts`, `server/ratelimit.ts`, `server/mutate.ts`, `server/app.ts`, `test/support/http.ts`
- Modify: `package.json` (`test:db`)
- Test: `test/api-core.ts`

**Interfaces:**
- Consumes: `withUser`, `Sql` (Task 4); `ensureUser`, `readVersion`, `loadState`, `writeDiff`, `baseCurrencyOf` (Task 6); `diffState` (Task 5); `MutationResponse`, `MeResponse`, `StateResponse`, `ErrorBody` (Task 5).
- Produces `server/errors.ts`: `type ApiStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500`, `class HttpError extends Error { status: ApiStatus; code: string }` (constructor `(status, code, message)`), `toErrorResponse(err: unknown): { status: ApiStatus; body: ErrorBody }`.
- Produces `server/kratos.ts`: `interface Identity { id: string; email: string; verified: boolean }`, `kratosWhoami(publicUrl: string, fetchImpl?: typeof fetch): (cookieHeader: string) => Promise<Identity | null>`.
- Produces `server/session.ts`: `SESSION_COOKIE = 'ory_kratos_session'`, `sessionToken(cookieHeader: string | undefined): string | null`, and `cachedWhoami(lookup, options?: { ttlMs?: number; max?: number; now?: () => number }): (cookieHeader: string | undefined) => Promise<Identity | null>`.
- Produces `server/ratelimit.ts`: `tokenBucket(options: { capacity: number; perSecond: number; now?: () => number; maxKeys?: number }): (key: string) => boolean`.
- Produces `server/mutate.ts`: `interface Mutation<R> { state: AppState; result: R }`, `mutate<R>(sql: Sql, userId: string, run: (state: AppState) => Mutation<R>): Promise<MutationResponse<R>>`.
- Produces `server/app.ts`:
  - `interface AppDeps { sql: Sql; whoami: (cookieHeader: string | undefined) => Promise<Identity | null>; appOrigin: string; rateLimit?: { capacity: number; perSecond: number }; log?: (entry: Record<string, unknown>) => void }`
  - `type AppEnv = { Variables: { requestId: string; identity: Identity; userId: string } }`
  - `createApp(deps: AppDeps): Hono<AppEnv>`
- Produces `test/support/http.ts`: `ORIGIN`, `USER_A`, `USER_B`, `USER_C`, `stubWhoami()`, `interface Reply<T> { status: number; body: T; headers: Headers }`, and `as(app, userId: string | null, origin?: string | null)` returning `{ get, post, put, patch, del, raw }`.

- [ ] **Step 1: Write the failing test**

`test/support/http.ts`:

```ts
/* test/support/http.ts — drive the api in-process through Hono's
   app.request(): no port, no Kratos. The whoami stub treats the session cookie
   as the identity id, which is all the api ever learns from Kratos anyway. */

import type { Hono } from 'hono';
import type { AppEnv } from '../../server/app.ts';
import type { Identity } from '../../server/kratos.ts';
import { sessionToken } from '../../server/session.ts';

export const ORIGIN = 'https://app.test';
export const USER_A = '00000000-0000-4000-8000-0000000000a1';
export const USER_B = '00000000-0000-4000-8000-0000000000b2';
export const USER_C = '00000000-0000-4000-8000-0000000000c3';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const stubWhoami = () => async (cookieHeader: string | undefined): Promise<Identity | null> => {
  const token = sessionToken(cookieHeader);
  return token && UUID.test(token) ? { id: token, email: `${token.slice(-2)}@example.test`, verified: false } : null;
};

export interface Reply<T> { status: number; body: T; headers: Headers }

export function as(app: Hono<AppEnv>, userId: string | null, origin: string | null = ORIGIN) {
  const call = async <T>(method: string, path: string, body?: unknown, raw?: string): Promise<Reply<T>> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (userId) headers['cookie'] = `ory_kratos_session=${userId}`;
    if (origin) headers['origin'] = origin;
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, { method, headers, body: payload });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* plain text, e.g. /healthz */ }
    return { status: res.status, body: parsed as T, headers: res.headers };
  };
  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
    put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
    patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
    del: <T>(path: string) => call<T>('DELETE', path),
    raw: <T>(method: string, path: string, text: string) => call<T>(method, path, undefined, text)
  };
}
```

`test/api-core.ts`:

```ts
/* API core test: who may call the api, from where, how often, and what an
   error looks like. Everything a route relies on before it runs.

   Needs the test database:  pnpm db:test:up
   Run:  node test/api-core.ts */

import { z } from 'zod';
import type { ErrorBody, MeResponse, StateResponse } from '../src/wire.ts';
import { createApp } from '../server/app.ts';
import { HttpError, toErrorResponse } from '../server/errors.ts';
import { kratosWhoami } from '../server/kratos.ts';
import { tokenBucket } from '../server/ratelimit.ts';
import { cachedWhoami, sessionToken } from '../server/session.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';
import { as, ORIGIN, stubWhoami, USER_A } from './support/http.ts';

const db = await freshDatabase();
const logs: Record<string, unknown>[] = [];
const app = createApp({ sql: db.sql, whoami: stubWhoami(), appOrigin: ORIGIN, log: (e) => logs.push(e) });
const a = as(app, USER_A);

title('health');
const health = await as(app, null).get<string>('/healthz');
check('/healthz needs no session', [health.status, health.body], [200, 'ok']);

title('authentication');
const anon = await as(app, null).get<ErrorBody>('/api/me');
check('no session is 401', [anon.status, anon.body.error.code], [401, 'unauthenticated']);
const forged = await as(app, 'not-a-session').get<ErrorBody>('/api/state');
check('a session Kratos does not know is 401', forged.status, 401);
const me = await a.get<MeResponse>('/api/me');
check('/api/me answers with the identity', [me.status, me.body.email, me.body.verified, me.body.version],
  [200, 'a1@example.test', false, 0]);
const [row] = await db.admin<{ n: number }[]>`select count(*)::int as n from users where id = ${USER_A}::uuid`;
check('the users row is created on first sight', row?.n, 1);
const state = await a.get<StateResponse>('/api/state');
check('a new user starts from a blank state at version 0',
  [state.status, state.body.version, state.body.state.income, state.body.state.settings.currencyCode],
  [200, 0, [], 'EGP']);

title('CSRF');
const foreign = await as(app, USER_A, 'https://evil.test').post<ErrorBody>('/api/recurring/catch-up');
check('a write from another origin is 403', [foreign.status, foreign.body.error.code], [403, 'bad_origin']);
const noOrigin = await as(app, USER_A, null).post<ErrorBody>('/api/recurring/catch-up');
check('a write with no Origin at all is 403', noOrigin.status, 403);
check('a read from another origin is allowed', (await as(app, USER_A, 'https://evil.test').get('/api/me')).status, 200);
const nowhere = await a.post<ErrorBody>('/api/no/such/endpoint/here');
check('an unknown endpoint is a JSON 404', [nowhere.status, nowhere.body.error.code], [404, 'not_found']);

title('request ids');
const id = me.headers.get('x-request-id') ?? '';
check('every response carries a request id', /^[0-9a-f]{16}$/.test(id), true);
check('and the log line names it', logs.some((l) => l['requestId'] === id && l['status'] === 200), true);

title('rate limit');
const tight = createApp({ sql: db.sql, whoami: stubWhoami(), appOrigin: ORIGIN, rateLimit: { capacity: 2, perSecond: 0 }, log: () => {} });
const t = as(tight, USER_A);
const statuses = [(await t.get('/api/me')).status, (await t.get('/api/me')).status];
const limited = await t.get<ErrorBody>('/api/me');
check('within the bucket', statuses, [200, 200]);
check('past it, 429', [limited.status, limited.body.error.code], [429, 'rate_limited']);
let clock = 0;
const bucket = tokenBucket({ capacity: 1, perSecond: 2, now: () => clock });
check('a bucket refills with time', [bucket('k'), bucket('k'), (clock = 500, bucket('k'))], [true, false, true]);

title('error mapping');
const zod = z.object({ amount: z.number() }).safeParse({ amount: 'x' }).error;
check('a validation failure is 400 invalid_body', [toErrorResponse(zod).status, toErrorResponse(zod).body.error.code], [400, 'invalid_body']);
check('an HttpError keeps its status and code', toErrorResponse(new HttpError(404, 'not_found', 'No such record.')),
  { status: 404, body: { error: { code: 'not_found', message: 'No such record.' } } });
check('a duplicate generated row is 409', toErrorResponse(Object.assign(new Error('dup'), { code: '23505' })).status, 409);
check('bad JSON is 400', toErrorResponse(new SyntaxError('Unexpected token')).body.error.code, 'invalid_json');
const internal = toErrorResponse(new Error('connection string with a password in it'));
check('anything else is a 500 that says nothing about internals',
  [internal.status, internal.body.error.message], [500, 'Something went wrong on the server.']);

title('session cache');
check('the token is read from the cookie header', sessionToken('a=1; ory_kratos_session=tok=en; b=2'), 'tok=en');
check('no session cookie, no token', sessionToken('a=1'), null);
let lookups = 0;
let now = 0;
const cached = cachedWhoami(async () => { lookups++; return { id: 'x', email: 'x@x', verified: true }; },
  { ttlMs: 30_000, now: () => now });
await cached('ory_kratos_session=s1');
await cached('ory_kratos_session=s1');
check('a second call inside 30 s does not reach Kratos', lookups, 1);
now = 30_001;
await cached('ory_kratos_session=s1');
check('after 30 s it asks again', lookups, 2);
await cached('other=1');
check('a request without the cookie never reaches Kratos', lookups, 2);

title('server-to-Kratos whoami');
const kratos = kratosWhoami('http://kratos:4433', async (input, init) => {
  const cookie = new Headers(init?.headers).get('cookie');
  check('the browser cookie is forwarded', [String(input), cookie], ['http://kratos:4433/sessions/whoami', 'ory_kratos_session=ok']);
  return new Response(JSON.stringify({ active: true, identity: { id: USER_A, traits: { email: 'me@x.test' },
    verifiable_addresses: [{ value: 'me@x.test', verified: true }] } }), { status: 200 });
});
check('an active session is an identity', await kratos('ory_kratos_session=ok'), { id: USER_A, email: 'me@x.test', verified: true });
const refused = kratosWhoami('http://kratos:4433', async () => new Response('{}', { status: 401 }));
check('anything but 200 is no identity', await refused('ory_kratos_session=old'), null);
const aal2 = kratosWhoami('http://kratos:4433', async () => new Response('{}', { status: 403 }));
check('a session still owing its second factor is no identity', await aal2('ory_kratos_session=half'), null);

await db.close();
finish();
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node test/api-core.ts`
Expected: `ERR_MODULE_NOT_FOUND` for `../server/app.ts`.

- [ ] **Step 3: Implement**

`server/errors.ts`:

```ts
/* server/errors.ts — every failure leaves the api as { error: { code, message } }.

   Messages are written for the person using the app; the toast shows them as
   they are. A 500 says nothing about why — the request id in the log does. */

import { ZodError } from 'zod';
import type { ErrorBody } from '../src/wire.ts';

export type ApiStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

export class HttpError extends Error {
  readonly status: ApiStatus;
  readonly code: string;
  constructor(status: ApiStatus, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const reply = (status: ApiStatus, code: string, message: string) =>
  ({ status, body: { error: { code, message } } satisfies ErrorBody });

export function toErrorResponse(err: unknown): { status: ApiStatus; body: ErrorBody } {
  if (err instanceof HttpError) return reply(err.status, err.code, err.message);
  if (err instanceof ZodError) {
    const detail = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return reply(400, 'invalid_body', `The request was not understood (${detail}).`);
  }
  if (err instanceof SyntaxError) return reply(400, 'invalid_json', 'The request body is not valid JSON.');
  if ((err as { code?: unknown } | null)?.code === '23505') {
    return reply(409, 'conflict',
      'That would make a second entry for the same recurring item in the same month.');
  }
  return reply(500, 'internal', 'Something went wrong on the server.');
}
```

`server/kratos.ts`:

```ts
/* server/kratos.ts — the one question the api asks Kratos: whose session is
   this? The browser's cookie is forwarded as-is to the public port inside the
   compose network; Kratos answers 200 with the session, or 401 (none) or 403
   (a second factor is still owed). Only a 200 with an active session counts. */

export interface Identity {
  id: string;
  email: string;
  verified: boolean;
}

interface WhoamiBody {
  active?: boolean;
  identity?: {
    id: string;
    traits?: { email?: string };
    verifiable_addresses?: { value: string; verified: boolean }[];
  };
}

export function kratosWhoami(publicUrl: string, fetchImpl: typeof fetch = fetch) {
  const url = new URL('/sessions/whoami', publicUrl).toString();
  return async (cookieHeader: string): Promise<Identity | null> => {
    const res = await fetchImpl(url, { headers: { cookie: cookieHeader, accept: 'application/json' } });
    if (res.status !== 200) return null;
    const body = await res.json() as WhoamiBody;
    if (!body.active || !body.identity) return null;
    const email = body.identity.traits?.email ?? '';
    const verified = (body.identity.verifiable_addresses ?? []).some((a) => a.value === email && a.verified);
    return { id: body.identity.id, email, verified };
  };
}
```

`server/session.ts`:

```ts
/* server/session.ts — whoami, remembered for 30 seconds per session token.

   Every api request needs the user id, and asking Kratos each time would put a
   network hop in front of every keystroke-sized write. Only positive answers
   are kept: a request that was refused a moment ago should succeed as soon as
   the person has logged in. The cost is that a logged-out session can keep
   working for up to 30 s — the spec accepts that, and the in-memory cache is
   also why the api runs as a single instance. */

import type { Identity } from './kratos.ts';

export const SESSION_COOKIE = 'ory_kratos_session';

export function sessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

export interface SessionCacheOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
}

export function cachedWhoami(
  lookup: (cookieHeader: string) => Promise<Identity | null>, options: SessionCacheOptions = {}
) {
  const ttl = options.ttlMs ?? 30_000;
  const max = options.max ?? 1000;
  const now = options.now ?? Date.now;
  /* A Map iterates in insertion order, so re-inserting on every hit makes the
     first key the least recently used one. */
  const cache = new Map<string, { identity: Identity; until: number }>();

  return async (cookieHeader: string | undefined): Promise<Identity | null> => {
    const token = sessionToken(cookieHeader);
    if (!token || !cookieHeader) return null;
    const hit = cache.get(token);
    cache.delete(token);
    if (hit && hit.until > now()) {
      cache.set(token, hit);
      return hit.identity;
    }
    const identity = await lookup(cookieHeader);
    if (identity) {
      cache.set(token, { identity, until: now() + ttl });
      while (cache.size > max) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    return identity;
  };
}
```

`server/ratelimit.ts`:

```ts
/* server/ratelimit.ts — a token bucket per key, in memory.

   Generous on purpose: a person clicking through the app, plus the burst a
   form save makes (upsert, link, catch-up), never comes near it. It is there
   for a script hammering the api. One instance, one map — see session.ts. */

export interface BucketOptions {
  capacity: number;
  perSecond: number;
  now?: () => number;
  maxKeys?: number;
}

export function tokenBucket(options: BucketOptions): (key: string) => boolean {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const buckets = new Map<string, { tokens: number; at: number }>();

  return (key: string): boolean => {
    const t = now();
    const bucket = buckets.get(key) ?? { tokens: options.capacity, at: t };
    bucket.tokens = Math.min(options.capacity, bucket.tokens + ((t - bucket.at) / 1000) * options.perSecond);
    bucket.at = t;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    buckets.delete(key);
    buckets.set(key, bucket);
    if (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    return allowed;
  };
}
```

`server/mutate.ts`:

```ts
/* server/mutate.ts — the one path every write takes.

   Lock, load the whole state, hand it to the very domain function the offline
   app called, diff what came back, write the diff, bump the version — all in
   one transaction. The api owns no rules of its own: whatever the domain
   decides is what happens, which is why the browser and the server cannot
   disagree about what a write means.

   A domain function that throws has a message written for a person ("This
   file is not an Income Tracker backup…"), so it goes back as a 400 with that
   message. An HttpError thrown inside `run` (a 404 for a missing record) is
   already shaped and passes through untouched. */

import type { AppState, Settings } from '../src/domain/types.ts';
import type { MutationResponse } from '../src/wire.ts';
import { withUser } from './db.ts';
import type { Sql } from './db.ts';
import { diffState } from './diff.ts';
import { HttpError } from './errors.ts';
import { baseCurrencyOf, loadState, writeDiff } from './repo.ts';

export interface Mutation<R> {
  state: AppState;
  result: R;
}

export function mutate<R>(
  sql: Sql, userId: string, run: (state: AppState) => Mutation<R>
): Promise<MutationResponse<R>> {
  return withUser(sql, userId, async (tx) => {
    const { state: before } = await loadState(userId, tx);
    let out: Mutation<R>;
    try {
      out = run(before);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'domain', err instanceof Error ? err.message : String(err));
    }
    const diff = diffState(before, out.state);
    const version = await writeDiff(userId, tx, diff, baseCurrencyOf(out.state.settings));
    const response: MutationResponse<R> = { version, changes: diff.changes, result: out.result };
    // Sent as stored, base currency included, so the client matches the next read.
    if (diff.settings) {
      response.settings = { ...diff.settings, baseCurrency: baseCurrencyOf(diff.settings) } as Settings;
    }
    return response;
  }, { lock: true });
}
```

`server/app.ts`:

```ts
/* server/app.ts — the Hono app: middleware, then routes.

   Middleware order is the spec's: request id + log on everything; then, for
   /api/*, the session (401 without one), the Origin check on anything that is
   not a read (403), and the rate limit (429). The per-user lock is not
   middleware — it is taken inside each write's own transaction (mutate.ts),
   which is the only place it means anything. */

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { MeResponse, StateResponse } from '../src/wire.ts';
import { withUser } from './db.ts';
import type { Sql } from './db.ts';
import { HttpError, toErrorResponse } from './errors.ts';
import type { Identity } from './kratos.ts';
import { tokenBucket } from './ratelimit.ts';
import { ensureUser, loadState, readVersion } from './repo.ts';

export interface AppDeps {
  sql: Sql;
  whoami: (cookieHeader: string | undefined) => Promise<Identity | null>;
  /** `https://$APP_DOMAIN` — the only origin allowed to write. */
  appOrigin: string;
  rateLimit?: { capacity: number; perSecond: number };
  log?: (entry: Record<string, unknown>) => void;
}

export type AppEnv = { Variables: { requestId: string; identity: Identity; userId: string } };

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const allow = tokenBucket(deps.rateLimit ?? { capacity: 120, perSecond: 20 });
  /** Users whose row is known to exist, so first sight costs one insert. */
  const known = new Set<string>();

  app.use('*', async (c, next) => {
    // Not crypto.randomUUID: the api suites make that deterministic for the domain's ids.
    const requestId = randomBytes(8).toString('hex');
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const started = performance.now();
    await next();
    log({
      requestId, method: c.req.method, path: c.req.path, status: c.res.status,
      ms: Math.round(performance.now() - started), user: c.get('userId') ?? null
    });
  });

  app.get('/healthz', (c) => c.text('ok'));

  app.use('/api/*', async (c, next) => {
    const identity = await deps.whoami(c.req.header('cookie'));
    if (!identity) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
    if (!known.has(identity.id)) {
      await withUser(deps.sql, identity.id, (tx) => ensureUser(identity.id, tx));
      known.add(identity.id);
    }
    c.set('identity', identity);
    c.set('userId', identity.id);
    await next();
  });

  app.use('/api/*', async (c, next) => {
    if (!READS.has(c.req.method) && c.req.header('origin') !== deps.appOrigin) {
      throw new HttpError(403, 'bad_origin', 'This request did not come from the app.');
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    if (!allow(c.get('userId'))) {
      throw new HttpError(429, 'rate_limited', 'Too many requests — wait a moment and try again.');
    }
    await next();
  });

  app.get('/api/me', async (c) => {
    const identity = c.get('identity');
    const version = await withUser(deps.sql, identity.id, (tx) => readVersion(identity.id, tx));
    const body: MeResponse = { email: identity.email, verified: identity.verified, version };
    return c.json(body);
  });

  app.get('/api/state', async (c) => {
    const userId = c.get('userId');
    const loaded = await withUser(deps.sql, userId, (tx) => loadState(userId, tx));
    const body: StateResponse = { version: loaded.version, state: loaded.state };
    return c.json(body);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    if (status === 500) log({ requestId: c.get('requestId'), error: err instanceof Error ? err.stack : String(err) });
    return c.json(body, status);
  });

  return app;
}
```

Change `"test:db"` to `"node test/migrate.ts && node test/repo.ts && node test/api-core.ts"`.

- [ ] **Step 4: Run, expect PASS**

Run: `node test/api-core.ts && pnpm typecheck`
Expected: `all checks passed`, and typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add server/errors.ts server/kratos.ts server/session.ts server/ratelimit.ts server/mutate.ts server/app.ts test/api-core.ts test/support/http.ts package.json
git commit -m "feat(server): hono app with session, origin check, rate limit and error mapping

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Collection CRUD and settings routes, with API-level isolation

**Files:**
- Create: `server/validate.ts`, `server/routes/records.ts`
- Modify: `server/app.ts` (register routes), `package.json` (`test:db`)
- Test: `test/api-records.ts`

**Interfaces:**
- Consumes: `mutate` (Task 7), `HttpError` (Task 7), `listRecords` and `getRecord` (Task 6), `normalizeRecord`, `TABLES` and `kindOf` (Task 4), and `isUserCollection` and `UserCollection` (Task 5).
- Produces `server/validate.ts`:
  - `parseCollection(name: string): UserCollection` (throws `HttpError(404, 'unknown_collection')`)
  - `draftSchema(collection: UserCollection): z.ZodType<Record<string, unknown>>`
  - `parseDraft<K extends UserCollection>(collection: K, body: unknown): Draft<K>`
  - `settingsPatch` (zod), plus the composite schemas `generateBody`, `linkBody`, `goalBody`, `moveBody`, `borrowBody`, `repayBody` and `reconcileBody`, which Task 9 uses.
- Produces `server/routes/records.ts`: `recordRoutes(app: Hono<AppEnv>, deps: AppDeps): void`.
- Routes: `GET /api/:collection`, `GET /api/:collection/:id`, `POST /api/:collection` (upsert; result = saved record), `PUT /api/:collection/:id` (404 unless it exists), `DELETE /api/:collection/:id` (404 unless it exists) and `PATCH /api/settings`.

- [ ] **Step 1: Write the failing test**

`test/api-records.ts`:

```ts
/* API records test: the generic collection endpoints, and the isolation rule
   seen from outside — user B gets 404 for anything of user A's, and never sees
   a single row of it.

   Needs the test database:  pnpm db:test:up
   Run:  node test/api-records.ts */

import type { Bill, Purchase } from '../src/domain/types.ts';
import type { ErrorBody, MutationResponse, StateResponse } from '../src/wire.ts';
import { createApp } from '../server/app.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';
import { as, ORIGIN, stubWhoami, USER_A, USER_B } from './support/http.ts';

const db = await freshDatabase();
const app = createApp({ sql: db.sql, whoami: stubWhoami(), appOrigin: ORIGIN, log: () => {} });
const a = as(app, USER_A);
const b = as(app, USER_B);
const tea = { id: 'pur_1', goalId: null, date: '2026-07-02', item: 'Tea', category: 'Groceries', amount: 250, accountId: '', method: 'Cash', notes: '' };

title('create, read, update, delete');
const created = await a.post<MutationResponse<Purchase>>('/api/purchases', tea);
check('POST answers with the saved record', [created.status, created.body.result.item, created.body.result.amount], [200, 'Tea', 250]);
check('and the first version', created.body.version, 1);
check('and the change to apply', created.body.changes.purchases?.upserts.map((r) => r.id), ['pur_1']);
const fresh = await a.post<MutationResponse<Purchase>>('/api/purchases', { item: 'Bread', amount: 100 });
check('a record without an id gets one with its collection\'s prefix', fresh.body.result.id.startsWith('pur_'), true);
check('GET lists the collection', (await a.get<Purchase[]>('/api/purchases')).body.length, 2);
check('GET by id returns one', (await a.get<Purchase>('/api/purchases/pur_1')).body.amount, 250);
const edited = await a.put<MutationResponse<Purchase>>('/api/purchases/pur_1', { amount: 300 });
check('PUT merges into the record, as upsert always has',
  [edited.body.result.amount, edited.body.result.item], [300, 'Tea']);
check('PUT of a record that does not exist is 404',
  (await a.put<ErrorBody>('/api/purchases/pur_missing', { amount: 1 })).status, 404);
const unchanged = await a.post<MutationResponse<Purchase>>('/api/purchases', { ...tea, amount: 300 });
check('a write that changes nothing leaves the version alone', unchanged.body.version, edited.body.version);
const removed = await a.del<MutationResponse<null>>('/api/purchases/pur_1');
check('DELETE answers with the delete to apply', removed.body.changes.purchases?.deletes, ['pur_1']);
check('deleting it again is 404', (await a.del<ErrorBody>('/api/purchases/pur_1')).status, 404);

title('domain rules still apply');
const bill = await a.post<MutationResponse<Bill>>('/api/bills', { id: 'bil_1', name: 'Water', dueDate: '2026-08-09', amount: 1, paidDate: '' });
check('a bill\'s period and status are derived from its dates', [bill.body.result.period, bill.body.result.status], ['2026-08', 'unpaid']);
await a.post('/api/accounts', { id: 'acc_x', name: 'X', type: 'Savings', opening: 0, target: 0, notes: '' });
await a.post('/api/savingsTx', { id: 'sav_x', date: '2026-07-01', accountId: 'acc_x', fromAccountId: '', direction: 'in', amount: 5, notes: '' });
const cascade = await a.del<MutationResponse<null>>('/api/accounts/acc_x');
check('deleting an account takes its movements with it', cascade.body.changes.savingsTx?.deletes, ['sav_x']);

title('validation');
const bad = await a.post<ErrorBody>('/api/purchases', { amount: { nested: true } });
check('a field of the wrong shape is 400 invalid_body', [bad.status, bad.body.error.code], [400, 'invalid_body']);
check('gold prices cannot be written', (await a.post<ErrorBody>('/api/goldPrices', { id: 'gpr_x' })).body.error.code, 'unknown_collection');
check('nor can a collection that does not exist be read', (await a.get<ErrorBody>('/api/nonsense')).status, 404);
check('a body that is not JSON is 400 invalid_json',
  (await a.raw<ErrorBody>('POST', '/api/purchases', '{')).body.error.code, 'invalid_json');

title('settings');
const patched = await a.patch<MutationResponse<null>>('/api/settings', { savingsGoalRate: 30 });
check('PATCH answers with the settings it stored', patched.body.settings?.savingsGoalRate, 30);
check('and the state agrees', (await a.get<StateResponse>('/api/state')).body.state.settings.savingsGoalRate, 30);
check('an unknown setting is refused', (await a.patch<ErrorBody>('/api/settings', { savingsGoalRates: 1 })).status, 400);

title('isolation');
await a.post('/api/purchases', { ...tea, id: 'pur_secret', item: 'A\'s secret' });
check('B cannot GET A\'s record by id', (await b.get<ErrorBody>('/api/purchases/pur_secret')).status, 404);
check('B cannot PUT it', (await b.put<ErrorBody>('/api/purchases/pur_secret', { amount: 0 })).status, 404);
check('B cannot DELETE it', (await b.del<ErrorBody>('/api/purchases/pur_secret')).status, 404);
check('B\'s list is empty', (await b.get<Purchase[]>('/api/purchases')).body, []);
const bState = (await b.get<StateResponse>('/api/state')).body.state;
check('B\'s state holds none of A\'s rows',
  [bState.purchases.length, bState.bills.length, bState.settings.savingsGoalRate], [0, 0, 20]);
const own = await b.post<MutationResponse<Purchase>>('/api/purchases', { ...tea, id: 'pur_secret', item: 'B\'s own' });
check('B writing the same id makes B\'s own record', own.body.result.item, 'B\'s own');
check('and A\'s is untouched', (await a.get<Purchase>('/api/purchases/pur_secret')).body.item, 'A\'s secret');

await db.close();
finish();
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node test/api-records.ts`
Expected: FAIL. The first check reports `expected [200,"Tea",250] actual [404,…]` because no route exists yet. The run then throws on the undefined `result`.

- [ ] **Step 3: Implement**

`server/validate.ts`:

```ts
/* server/validate.ts — the shape of every request body, in zod.

   Record drafts are built from the same column list the repository writes, so
   a field the database does not have cannot be sent, and one it does have
   cannot be refused. Field types are lenient in exactly the way the stored
   form is: "21" for a number is accepted and coerced on write (schema.ts), an
   object or array never is. Keys that are left out stay out — upsert() merges
   a draft over the record, and an absent key must not become a null. */

import { z } from 'zod';
import type { Draft } from '../src/domain/records.ts';
import { isUserCollection } from '../src/wire.ts';
import type { UserCollection } from '../src/wire.ts';
import { HttpError } from './errors.ts';
import { kindOf, TABLES } from './schema.ts';
import type { ColumnKind } from './schema.ts';

export function parseCollection(name: string): UserCollection {
  if (!isUserCollection(name)) {
    throw new HttpError(404, 'unknown_collection', `There is no collection called "${name}".`);
  }
  return name;
}

const scalar = (kind: ColumnKind) => {
  if (kind === 'text') return z.union([z.string(), z.number()]).nullable().optional();
  if (kind === 'bool') return z.union([z.boolean(), z.number()]).nullable().optional();
  return z.union([z.number(), z.string()]).nullable().optional();
};

const id = z.string().min(1).max(120);

const drafts = new Map<UserCollection, z.ZodType<Record<string, unknown>>>();

export function draftSchema(collection: UserCollection): z.ZodType<Record<string, unknown>> {
  let schema = drafts.get(collection);
  if (!schema) {
    const shape: Record<string, z.ZodType> = {};
    for (const column of TABLES[collection]) shape[column] = column === 'id' ? id.optional() : scalar(kindOf(column));
    schema = z.object(shape) as unknown as z.ZodType<Record<string, unknown>>;
    drafts.set(collection, schema);
  }
  return schema;
}

export const parseDraft = <K extends UserCollection>(collection: K, body: unknown): Draft<K> =>
  draftSchema(collection).parse(body) as Draft<K>;

export const settingsPatch = z.strictObject({
  currencySymbol: z.string().max(16),
  currencyCode: z.string().max(16),
  locale: z.string().max(35),
  savingsGoalRate: z.number(),
  autoGenerate: z.boolean(),
  goldSync: z.boolean(),
  goldPremium: z.number(),
  goldManualPrice: z.number().int(),
  forecastSpendingAuto: z.boolean(),
  forecastSpending: z.number().int()
}).partial();

/* ------------------------------------------------ composite endpoints */

const period = z.string().regex(/^\d{4}-\d{2}$/);

export const generateBody = z.object({ collection: z.enum(['bills', 'income']), period });

export const linkBody = z.object({
  collection: z.enum(['incomeTemplates', 'billTemplates']),
  template: z.object({ id: z.string().optional(), accountId: z.string().optional() })
});

export const goalBody = z.object({
  draft: draftSchema('goals'),
  paid: z.object({ accountId: z.string().optional(), method: z.string().optional() }).optional()
});

export const moveBody = z.object({ delta: z.number().int().min(-1).max(1) });

export const borrowBody = z.object({
  name: z.string().max(200),
  amount: z.number().int(),
  date: z.string(),
  intoAccountId: z.string(),
  notes: z.string().max(2000).optional(),
  debtId: z.string().optional()
});

export const repayBody = z.object({
  amount: z.number().int(),
  date: z.string(),
  fromAccountId: z.string(),
  notes: z.string().max(2000).optional()
});

export const reconcileBody = z.object({ actual: z.number().int(), date: z.string() });
```

`server/routes/records.ts`:

```ts
/* server/routes/records.ts — the generic collection endpoints.

   POST is the domain's upsert: an id means update, no id (or an unknown one)
   means insert — exactly what the screens have always called. PUT and DELETE
   address one existing record and are 404 for anything this user does not
   have, which is how "someone else's record" looks from outside. */

import type { Hono } from 'hono';
import * as Records from '../../src/domain/records.ts';
import type { AppDeps, AppEnv } from '../app.ts';
import { withUser } from '../db.ts';
import { HttpError } from '../errors.ts';
import { mutate } from '../mutate.ts';
import { getRecord, listRecords } from '../repo.ts';
import { normalizeRecord } from '../schema.ts';
import { parseCollection, parseDraft, settingsPatch } from '../validate.ts';

const missing = (): HttpError => new HttpError(404, 'not_found', 'No such record.');

export function recordRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.patch('/api/settings', async (c) => {
    const patch = settingsPatch.parse(await c.req.json());
    return c.json(await mutate(deps.sql, c.get('userId'), (state) => ({
      state: Records.updateSettings(state, patch), result: null
    })));
  });

  app.get('/api/:collection', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const userId = c.get('userId');
    return c.json(await withUser(deps.sql, userId, (tx) => listRecords(userId, tx, collection)));
  });

  app.get('/api/:collection/:id', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const userId = c.get('userId');
    const record = await withUser(deps.sql, userId, (tx) => getRecord(userId, tx, collection, c.req.param('id')));
    if (!record) throw missing();
    return c.json(record);
  });

  app.post('/api/:collection', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const draft = parseDraft(collection, await c.req.json());
    return c.json(await mutate(deps.sql, c.get('userId'), (state) => {
      const saved = Records.upsert(state, collection, draft);
      return { state: saved.state, result: normalizeRecord(collection, saved.record) };
    }));
  });

  app.put('/api/:collection/:id', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const id = c.req.param('id');
    const draft = { ...parseDraft(collection, await c.req.json()), id };
    return c.json(await mutate(deps.sql, c.get('userId'), (state) => {
      if (!Records.byId(state, collection, id)) throw missing();
      const saved = Records.upsert(state, collection, draft);
      return { state: saved.state, result: normalizeRecord(collection, saved.record) };
    }));
  });

  app.delete('/api/:collection/:id', async (c) => {
    const collection = parseCollection(c.req.param('collection'));
    const id = c.req.param('id');
    return c.json(await mutate(deps.sql, c.get('userId'), (state) => {
      if (!Records.byId(state, collection, id)) throw missing();
      return { state: Records.remove(state, collection, id), result: null };
    }));
  });
}
```

In `server/app.ts`, add `import { recordRoutes } from './routes/records.ts';` and insert this line directly after the `app.get('/api/state', …)` block, before `app.notFound`:

```ts
  // Specific routes before generic ones: Hono matches in registration order.
  recordRoutes(app, deps);
```

Append ` && node test/api-records.ts` to `"test:db"`.

- [ ] **Step 4: Run, expect PASS**

Run: `node test/api-records.ts && node test/api-core.ts && pnpm typecheck`
Expected: `all checks passed` for both suites, and typecheck is clean.

- [ ] **Step 5: Commit**

```bash
git add server/validate.ts server/routes/records.ts server/app.ts test/api-records.ts package.json
git commit -m "feat(server): collection CRUD and settings endpoints with isolation tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Composite endpoints (recurring, goals, debts, reconcile, backup, erase) and concurrency

**Files:**
- Create: `server/routes/composite.ts`, `test/support/ids.ts`
- Modify: `server/app.ts`, `package.json` (`test:db`)
- Test: `test/api-composite.ts`

**Interfaces:**
- Consumes: `mutate`, `Mutation` (Task 7); `generateBody`, `linkBody`, `goalBody`, `moveBody`, `borrowBody`, `repayBody`, `reconcileBody` (Task 8); `loadState`, `upsertGoldPrice` (Task 6); `fixtureBackup` (Task 6).
- Produces `server/routes/composite.ts`: `compositeRoutes(app: Hono<AppEnv>, deps: AppDeps): void`. Its routes and their `result` values:

| Route | result |
| --- | --- |
| `POST /api/recurring/catch-up` | `CatchUpResult` |
| `POST /api/recurring/generate` | created count |
| `POST /api/recurring/link` | linked count |
| `PUT /api/goals/:id` | `null` |
| `POST /api/goals/:id/move` | `null` |
| `POST /api/debts` | `null` |
| `POST /api/debts/:id/repay` | `null` |
| `POST /api/accounts/:id/reconcile` | difference (`Cents`) |
| `GET /api/backup` | backup JSON attachment |
| `POST /api/backup/import` | `Record<CollectionKey, number>` |
| `DELETE /api/data` | `null` |

- Produces `test/support/ids.ts`: `deterministicIds(): void`, `resetIds(): void`.

- [ ] **Step 1: Write the failing test**

`test/support/ids.ts`:

```ts
/* test/support/ids.ts — make uid() predictable, so that calling a domain
   function directly and calling it through the api create records with the
   same ids and the two states can be compared whole.

   uid() takes the first 12 characters of crypto.randomUUID(); the counter is
   at the front so those 12 differ. The api runs in this same process
   (app.request), so it sees the same stub. Nothing else in the request path
   calls randomUUID — the request id deliberately uses randomBytes. */

let n = 0;

export function deterministicIds(): void {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: () => `${String(++n).padStart(8, '0')}-0000-4000-8000-000000000000`
  });
}

export const resetIds = (): void => { n = 0; };
```

`test/api-composite.ts`:

```ts
/* API composite test: every endpoint that is more than a single upsert
   produces the same state as calling the domain function directly, and two
   catch-ups at once cannot generate the same bill twice.

   Needs the test database:  pnpm db:test:up
   Run:  node test/api-composite.ts */

import { importJSON } from '../src/domain/backup.ts';
import { borrow, repay } from '../src/domain/debt.ts';
import { moveGoal, saveGoal } from '../src/domain/forecast.ts';
import { currentPeriod, shiftPeriod } from '../src/domain/period.ts';
import { blankState } from '../src/domain/records.ts';
import { reconcile } from '../src/domain/reconcile.ts';
import { catchUp, generateBills, generateIncome, linkGeneratedTo } from '../src/domain/recurring.ts';
import { accountBalance } from '../src/domain/selectors.ts';
import type { AppState, CatchUpResult } from '../src/domain/types.ts';
import type { ErrorBody, MutationResponse, StateResponse } from '../src/wire.ts';
import { createApp } from '../server/app.ts';
import { sameJson } from '../server/diff.ts';
import { upsertGoldPrice } from '../server/repo.ts';
import { normalizeState } from '../server/schema.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';
import { fixtureBackup } from './support/fixture.ts';
import { as, ORIGIN, stubWhoami, USER_A, USER_C } from './support/http.ts';
import { deterministicIds, resetIds } from './support/ids.ts';

deterministicIds();
const db = await freshDatabase();
const app = createApp({ sql: db.sql, whoami: stubWhoami(), appOrigin: ORIGIN, log: () => {} });
const a = as(app, USER_A);
const stateOf = async (): Promise<AppState> => (await a.get<StateResponse>('/api/state')).body.state;

/** Calls the endpoint and the domain function on the same starting state, with
    the same ids, and checks they land in the same place. */
async function same<R>(
  label: string, call: () => Promise<{ status: number; body: MutationResponse<R> }>, direct: (s: AppState) => AppState
): Promise<MutationResponse<R>> {
  const before = await stateOf();
  resetIds();
  const expected = direct(before);
  resetIds();
  const res = await call();
  check(`${label} answers 200`, res.status, 200);
  check(`${label} gives the same state as the domain call`, sameJson(comparable(await stateOf()), comparable(expected)), true);
  return res.body;
}

/** Stored form, minus the base currency the repository adds to settings. */
const comparable = (s: AppState) => ({ ...normalizeState(s), settings: { ...s.settings, baseCurrency: undefined } });

await upsertGoldPrice(db.sql, { id: 'gpr_2026-07-29', date: '2026-07-29', usdPerOz: 3110.34768, egpPerUsd: 10, egpPerGram24: 100000, source: 'test', fetchedAt: '' });

title('import');
const text = fixtureBackup();
const imported = await same<Record<string, number>>('import', () => a.raw('POST', '/api/backup/import', text),
  (s) => ({ ...importJSON(text).state, goldPrices: s.goldPrices }));
check('import says how many arrived', [imported.result['income'], imported.result['bills']], [3, 4]);
check('the shared gold prices are kept, not replaced by the file\'s', (await stateOf()).goldPrices.length, 1);
const junk = await a.raw<ErrorBody>('POST', '/api/backup/import', '{"hello":1}');
check('a file that is not a backup is refused with the domain\'s message',
  [junk.status, junk.body.error.message.startsWith('This file is not an Income Tracker backup')], [400, true]);

title('debts');
const taken = { name: 'Bank', amount: 250000, date: '2026-07-08', intoAccountId: 'acc_card' };
await same('borrow', () => a.post('/api/debts', taken), (s) => borrow(s, taken));
const debtId = (await stateOf()).accounts.find((x) => x.name === 'Brother')?.id ?? '';
const paid = { amount: 100000, date: '2026-07-20', fromAccountId: 'acc_card' };
await same('repay', () => a.post(`/api/debts/${debtId}/repay`, paid), (s) => repay(s, debtId, paid));
check('repaying something that is not a debt is 404',
  (await a.post<ErrorBody>('/api/debts/acc_pot/repay', paid)).status, 404);

title('reconcile');
const actual = accountBalance(await stateOf(), 'acc_card') - 12345;
const corrected = await same<number>('reconcile', () => a.post('/api/accounts/acc_card/reconcile', { actual, date: '2026-07-31' }),
  (s) => reconcile(s, 'acc_card', actual, '2026-07-31'));
check('it answers with the difference it corrected', corrected.result, -12345);
check('reconciling an account that does not exist is 404',
  (await a.post<ErrorBody>('/api/accounts/acc_nope/reconcile', { actual: 0, date: '2026-07-31' })).status, 404);

title('goals');
await a.post('/api/goals', { id: 'gol_x', name: 'Bike', price: 100000, priority: 3, boughtDate: '', notes: '' });
await a.post('/api/goals', { id: 'gol_y', name: 'Lamp', price: 5000, priority: 4, boughtDate: '', notes: '' });
await same('moveGoal', () => a.post('/api/goals/gol_y/move', { delta: -1 }), (s) => moveGoal(s, 'gol_y', -1));
const buy = { draft: { boughtDate: '2026-07-30' }, paid: { accountId: 'acc_card', method: 'Card' } };
await same('saveGoal (buying)', () => a.put('/api/goals/gol_x', buy),
  (s) => saveGoal(s, { ...buy.draft, id: 'gol_x' }, buy.paid));
await same('saveGoal (a new goal)', () => a.put('/api/goals/gol_new', { draft: { name: 'Chair', price: 1, priority: 9, boughtDate: '', notes: '' } }),
  (s) => saveGoal(s, { name: 'Chair', price: 1, priority: 9, boughtDate: '', notes: '', id: 'gol_new' }));

title('recurring');
await same<number>('generate bills', () => a.post('/api/recurring/generate', { collection: 'bills', period: '2026-09' }),
  (s) => generateBills(s, '2026-09').state);
await same<number>('generate income', () => a.post('/api/recurring/generate', { collection: 'income', period: '2026-09' }),
  (s) => generateIncome(s, '2026-09').state);
await a.post('/api/bills', { id: 'bil_orphan', templateId: 'tpl_rent', name: 'Rent', dueDate: '2030-01-01', amount: 5, accountId: '', paidDate: '' });
const link = { collection: 'billTemplates', template: { id: 'tpl_rent', accountId: 'acc_pot' } } as const;
const linked = await same<number>('link', () => a.post('/api/recurring/link', link),
  (s) => linkGeneratedTo(s, link.collection, link.template).state);
check('link answers with how many it linked', linked.result, 1);
const swept = await same<CatchUpResult>('catch-up', () => a.post('/api/recurring/catch-up'), (s) => catchUp(s).state);
check('catch-up answers with its counts', swept.result.total, swept.result.income + swept.result.bills);
check('a second catch-up adds nothing', (await a.post<MutationResponse<CatchUpResult>>('/api/recurring/catch-up')).body.result.total, 0);

title('two catch-ups at once');
const c = as(app, USER_C);
await c.post('/api/billTemplates', {
  id: 'tpl_c', name: 'Gym', category: 'Subscriptions', provider: '', frequency: 'Monthly', dueDay: 3,
  expected: 500, accountId: '', method: '', active: true, anchor: shiftPeriod(currentPeriod(), -2), generatedThrough: '', notes: ''
});
const [one, two] = await Promise.all([
  c.post<MutationResponse<CatchUpResult>>('/api/recurring/catch-up'),
  c.post<MutationResponse<CatchUpResult>>('/api/recurring/catch-up')
]);
check('both succeed', [one.status, two.status], [200, 200]);
check('between them they made three bills, once', [one.body.result.bills, two.body.result.bills].sort(), [0, 3]);
const [counted] = await db.admin<{ n: number }[]>`select count(*)::int as n from bills where user_id = ${USER_C}::uuid`;
check('and the table holds exactly three', counted?.n, 3);

title('backup and erase');
const backup = await app.request('/api/backup', { headers: { cookie: `ory_kratos_session=${USER_A}` } });
const backupText = await backup.text();
check('the backup is a JSON download', [backup.headers.get('content-type')?.startsWith('application/json'),
  /attachment; filename="income-tracker-backup-\d{4}-\d{2}-\d{2}\.json"/.test(backup.headers.get('content-disposition') ?? '')], [true, true]);
check('and is a backup the domain accepts', importJSON(backupText).counts.accounts, (await stateOf()).accounts.length);
await same('erase', () => a.del('/api/data'), (s) => ({ ...blankState(), goldPrices: s.goldPrices }));
check('nothing of A\'s is left', (await stateOf()).income.length, 0);

await db.close();
finish();
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node test/api-composite.ts`
Expected: FAIL. `import answers 200` reports `actual 404`. The first missing route is `/api/backup/import`; the generic `POST /api/:collection` does not match a three-segment path.

- [ ] **Step 3: Implement**

`server/routes/composite.ts`:

```ts
/* server/routes/composite.ts — the writes that are more than one upsert.

   Each is one call to the same domain function the offline app called, run
   through mutate(): borrowing is an account and a movement in one domain call
   and therefore one transaction, catch-up is however many months it is, an
   import is the whole state. Concurrency is the lock's job (and the unique
   keys' as a backstop), not these handlers'. */

import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as Backup from '../../src/domain/backup.ts';
import * as Debt from '../../src/domain/debt.ts';
import * as Forecast from '../../src/domain/forecast.ts';
import { todayISO } from '../../src/domain/period.ts';
import * as Records from '../../src/domain/records.ts';
import * as Reconcile from '../../src/domain/reconcile.ts';
import * as Recurring from '../../src/domain/recurring.ts';
import { isDebtAccount } from '../../src/domain/selectors.ts';
import type { AppState } from '../../src/domain/types.ts';
import type { AppDeps, AppEnv } from '../app.ts';
import { withUser } from '../db.ts';
import { HttpError } from '../errors.ts';
import { mutate } from '../mutate.ts';
import type { Mutation } from '../mutate.ts';
import { loadState } from '../repo.ts';
import {
  borrowBody, generateBody, goalBody, linkBody, moveBody, reconcileBody, repayBody
} from '../validate.ts';

/** A backup of several years is a few hundred KB; this is far beyond that. */
const IMPORT_LIMIT = 10 * 1024 * 1024;

export function compositeRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  const write = <R>(userId: string, run: (state: AppState) => Mutation<R>) => mutate(deps.sql, userId, run);

  app.post('/api/recurring/catch-up', async (c) =>
    c.json(await write(c.get('userId'), (state) => Recurring.catchUp(state))));

  app.post('/api/recurring/generate', async (c) => {
    const { collection, period } = generateBody.parse(await c.req.json());
    return c.json(await write(c.get('userId'), (state) => {
      const made = collection === 'bills' ? Recurring.generateBills(state, period) : Recurring.generateIncome(state, period);
      return { state: made.state, result: made.created };
    }));
  });

  app.post('/api/recurring/link', async (c) => {
    const { collection, template } = linkBody.parse(await c.req.json());
    return c.json(await write(c.get('userId'), (state) => {
      const done = Recurring.linkGeneratedTo(state, collection, template);
      return { state: done.state, result: done.linked };
    }));
  });

  app.put('/api/goals/:id', async (c) => {
    const { draft, paid } = goalBody.parse(await c.req.json());
    const id = c.req.param('id');
    return c.json(await write(c.get('userId'), (state) => ({
      state: Forecast.saveGoal(state, { ...(draft as Records.Draft<'goals'>), id }, paid ?? {}),
      result: null
    })));
  });

  app.post('/api/goals/:id/move', async (c) => {
    const { delta } = moveBody.parse(await c.req.json());
    return c.json(await write(c.get('userId'), (state) => ({
      state: Forecast.moveGoal(state, c.req.param('id'), delta), result: null
    })));
  });

  app.post('/api/debts', async (c) => {
    const taken = borrowBody.parse(await c.req.json());
    return c.json(await write(c.get('userId'), (state) => ({ state: Debt.borrow(state, taken), result: null })));
  });

  app.post('/api/debts/:id/repay', async (c) => {
    const paid = repayBody.parse(await c.req.json());
    const id = c.req.param('id');
    return c.json(await write(c.get('userId'), (state) => {
      if (!isDebtAccount(Records.byId(state, 'accounts', id))) throw new HttpError(404, 'not_found', 'No such debt.');
      return { state: Debt.repay(state, id, paid), result: null };
    }));
  });

  app.post('/api/accounts/:id/reconcile', async (c) => {
    const { actual, date } = reconcileBody.parse(await c.req.json());
    const id = c.req.param('id');
    return c.json(await write(c.get('userId'), (state) => {
      if (!Records.byId(state, 'accounts', id)) throw new HttpError(404, 'not_found', 'No such account.');
      const { difference } = Reconcile.reconciliation(state, id, actual);
      return { state: Reconcile.reconcile(state, id, actual, date), result: difference };
    }));
  });

  app.get('/api/backup', async (c) => {
    const userId = c.get('userId');
    const { state } = await withUser(deps.sql, userId, (tx) => loadState(userId, tx));
    return c.body(Backup.exportJSON(state), 200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="income-tracker-backup-${todayISO()}.json"`
    });
  });

  /* Replaces everything the user has. Gold prices in the file are ignored: they
     are shared, and the server's own are newer. */
  app.post('/api/backup/import',
    bodyLimit({
      maxSize: IMPORT_LIMIT,
      onError: () => { throw new HttpError(400, 'too_large', 'That file is too large to import.'); }
    }),
    async (c) => {
      const text = await c.req.text();
      return c.json(await write(c.get('userId'), (state) => {
        const imported = Backup.importJSON(text);
        return { state: { ...imported.state, goldPrices: state.goldPrices }, result: imported.counts };
      }));
    });

  app.delete('/api/data', async (c) =>
    c.json(await write(c.get('userId'), (state) => ({
      state: { ...Records.blankState(), goldPrices: state.goldPrices }, result: null
    }))));
}
```

In `server/app.ts`, add `import { compositeRoutes } from './routes/composite.ts';` and put `compositeRoutes(app, deps);` on the line directly **before** `recordRoutes(app, deps);`. That way `POST /api/debts`, `PUT /api/goals/:id` and `GET /api/backup` win over the generic `/api/:collection` patterns.

Append ` && node test/api-composite.ts` to `"test:db"`.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test:db && pnpm typecheck`
Expected: each of the five DB suites ends with `all checks passed`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/composite.ts server/app.ts test/api-composite.ts test/support/ids.ts package.json
git commit -m "feat(server): composite endpoints reusing the domain, with equality and concurrency tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Server-side daily gold price and the api entry point

**Files:**
- Create: `server/gold-price.ts`, `server/jobs.ts`, `server/main.ts`
- Modify: `package.json` (`test:db`, `start:api`)
- Test: `test/gold.ts`

**Interfaces:**
- Consumes: `loadGoldPrices`, `upsertGoldPrice`, `pruneGoldPrices` (Task 6); `createApp` (Task 7); `cachedWhoami` (Task 7); `kratosWhoami` (Task 7); `connect`, `migrate` (Task 4); domain `goldGramFromSpot`, `latestGoldPrice`, `todayISO`, `blankState`.
- Produces `server/gold-price.ts`: `type Fetch = typeof fetch`, `interface GoldReading { usdPerOz: number; egpPerUsd: number; source: string; partial: boolean; error: string | null }`, and `fetchGoldReading(previous: GoldPrice | null, fetchImpl?: Fetch): Promise<GoldReading>`, which throws when neither figure is available.
- Produces `server/jobs.ts`: `type SyncOutcome = 'skipped' | 'updated' | 'failed'`, `syncGoldPrice(sql: Sql, options?: { fetchImpl?: Fetch; today?: () => IsoDate; force?: boolean }): Promise<SyncOutcome>`, and `startJobs(sql: Sql, options?: { intervalMs?: number; fetchImpl?: Fetch; log?: (e: Record<string, unknown>) => void }): { stop(): void }`.
- Produces `server/main.ts`: env `APP_DOMAIN`, `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `KRATOS_PUBLIC_URL` (default `http://kratos:4433`) and `PORT` (default `3000`).

- [ ] **Step 1: Write the failing test**

`test/gold.ts`:

```ts
/* Gold price job test: once a day, shared by everyone, and as forgiving of an
   unreachable service as the browser fetcher was — a missing exchange rate
   still records today's gold price at yesterday's rate.

   Needs the test database:  pnpm db:test:up
   Run:  node test/gold.ts */

import { syncGoldPrice } from '../server/jobs.ts';
import { loadGoldPrices, upsertGoldPrice } from '../server/repo.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';

const db = await freshDatabase();

/** A fake network: each URL fragment maps to a body, or to a status code. */
const network = (routes: Record<string, unknown>): typeof fetch => async (input) => {
  const url = String(input);
  const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
  if (!hit || typeof hit[1] === 'number') return new Response('', { status: typeof hit?.[1] === 'number' ? hit[1] : 503 });
  return new Response(JSON.stringify(hit[1]), { status: 200 });
};
const healthy = network({ 'gold-api.com': { price: 3110.34768 }, 'open.er-api.com': { rates: { EGP: 10 } } });

title('nothing reachable, nothing before');
check('fails quietly and records nothing',
  [await syncGoldPrice(db.sql, { fetchImpl: network({}), today: () => '2026-07-28' }), (await loadGoldPrices(db.sql)).length],
  ['failed', 0]);

title('one reading a day');
check('the first sync of the day records one', await syncGoldPrice(db.sql, { fetchImpl: healthy, today: () => '2026-07-29' }), 'updated');
const first = await loadGoldPrices(db.sql);
check('priced per gram of pure gold, in minor units',
  first.map((p) => [p.id, p.egpPerGram24, p.source]), [['gpr_2026-07-29', 100000, 'world spot × USD/EGP']]);
check('a second sync the same day does nothing', await syncGoldPrice(db.sql, { fetchImpl: healthy, today: () => '2026-07-29' }), 'skipped');
check('forcing it replaces the day\'s reading rather than adding one',
  [await syncGoldPrice(db.sql, { fetchImpl: healthy, today: () => '2026-07-29', force: true }), (await loadGoldPrices(db.sql)).length],
  ['updated', 1]);

title('services failing');
const noRates = network({ 'gold-api.com': { price: 3200 }, 'er-api.com': 503, 'exchangerate-api.com': 503 });
check('without a rate it still records, at the previous rate',
  await syncGoldPrice(db.sql, { fetchImpl: noRates, today: () => '2026-07-30' }), 'updated');
const partial = (await loadGoldPrices(db.sql)).find((p) => p.date === '2026-07-30');
check('and says it is partial', [partial?.egpPerUsd, partial?.source], [10, 'partial (gold-api.com)']);
const fallback = network({ 'gold-api.com': { price: 3110.34768 }, 'open.er-api.com': 503, 'exchangerate-api.com': { rates: { EGP: 20 } } });
await syncGoldPrice(db.sql, { fetchImpl: fallback, today: () => '2026-07-31' });
check('the second rate service is tried when the first is down',
  (await loadGoldPrices(db.sql)).find((p) => p.date === '2026-07-31')?.egpPerGram24, 200000);

title('the table stays bounded');
for (let i = 0; i < 805; i++) {
  const date = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
  await upsertGoldPrice(db.sql, { id: `gpr_${date}`, date, usdPerOz: 1, egpPerUsd: 1, egpPerGram24: 1, source: 'old', fetchedAt: '' });
}
await syncGoldPrice(db.sql, { fetchImpl: healthy, today: () => '2026-08-02' });
check('a sync prunes to the newest 800 days', (await loadGoldPrices(db.sql)).length, 800);

await db.close();
finish();
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `node test/gold.ts`
Expected: `ERR_MODULE_NOT_FOUND` for `../server/jobs.ts`.

- [ ] **Step 3: Implement**

`server/gold-price.ts`:

```ts
/* server/gold-price.ts — the world gold price and the pound rate, fetched
   server-side once a day for everyone. Moved from the browser
   (src/data/gold-price.ts in the offline build) with the same two services and
   the same rule: a failure on one side never throws the other away. The shop
   premium and a typed-in price stay per-user settings, applied in the browser
   exactly as before. */

import type { GoldPrice } from '../src/domain/types.ts';

export type Fetch = typeof fetch;

const SPOT_URL = 'https://api.gold-api.com/price/XAU';
/* Tried in order; the second is the same provider's older endpoint, worth
   having when the first is rate-limited. */
const RATE_URLS = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.exchangerate-api.com/v4/latest/USD'
] as const;
const TIMEOUT_MS = 9000;

async function fetchJSON(fetchImpl: Fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

async function fetchSpot(fetchImpl: Fetch): Promise<number> {
  const json = await fetchJSON(fetchImpl, SPOT_URL) as { price?: unknown } | null;
  const price = Number(json?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('The gold price came back unreadable.');
  return price;
}

async function fetchRate(fetchImpl: Fetch): Promise<number> {
  for (const url of RATE_URLS) {
    try {
      const json = await fetchJSON(fetchImpl, url) as { rates?: { EGP?: unknown } } | null;
      const rate = Number(json?.rates?.EGP);
      if (Number.isFinite(rate) && rate > 0) return rate;
    } catch {
      // Try the next service; only the last failure is reported.
    }
  }
  throw new Error('Could not reach a currency service.');
}

export interface GoldReading {
  usdPerOz: number;
  egpPerUsd: number;
  source: string;
  partial: boolean;
  error: string | null;
}

export async function fetchGoldReading(previous: GoldPrice | null, fetchImpl: Fetch = fetch): Promise<GoldReading> {
  const [spot, rate] = await Promise.allSettled([fetchSpot(fetchImpl), fetchRate(fetchImpl)]);
  const usdPerOz = spot.status === 'fulfilled' ? spot.value : (previous?.usdPerOz ?? 0);
  const egpPerUsd = rate.status === 'fulfilled' ? rate.value : (previous?.egpPerUsd ?? 0);
  const failure = [spot, rate].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  const error = failure ? String((failure.reason as Error)?.message ?? failure.reason) : null;
  if (!usdPerOz || !egpPerUsd) throw new Error(error ?? 'Could not reach the price service.');

  const reached: string[] = [];
  if (spot.status === 'fulfilled') reached.push('gold-api.com');
  if (rate.status === 'fulfilled') reached.push('exchangerate-api.com');
  const partial = reached.length < 2;
  return {
    usdPerOz, egpPerUsd, partial, error,
    source: partial ? `partial (${reached.join(', ')})` : 'world spot × USD/EGP'
  };
}
```

`server/jobs.ts`:

```ts
/* server/jobs.ts — work the api does on its own, in-process.

   Only one job: the daily gold price. It checks on start and then hourly, and
   does anything only when today has no reading yet — "once a day" is the whole
   specification, and an hourly check means a restart or a failed morning fetch
   is retried the same day rather than the next. The recurring catch-up is not
   a job: the browser asks for it after loading (POST /api/recurring/catch-up). */

import { goldGramFromSpot, latestGoldPrice } from '../src/domain/gold.ts';
import { todayISO } from '../src/domain/period.ts';
import { blankState } from '../src/domain/records.ts';
import type { IsoDate } from '../src/domain/types.ts';
import type { Sql } from './db.ts';
import { fetchGoldReading } from './gold-price.ts';
import type { Fetch } from './gold-price.ts';
import { loadGoldPrices, pruneGoldPrices, upsertGoldPrice } from './repo.ts';

export type SyncOutcome = 'skipped' | 'updated' | 'failed';

export interface SyncOptions {
  fetchImpl?: Fetch;
  today?: () => IsoDate;
  force?: boolean;
}

export async function syncGoldPrice(sql: Sql, options: SyncOptions = {}): Promise<SyncOutcome> {
  const today = (options.today ?? todayISO)();
  const latest = latestGoldPrice({ ...blankState(), goldPrices: await loadGoldPrices(sql) });
  if (!options.force && latest && latest.date >= today) return 'skipped';
  try {
    const reading = await fetchGoldReading(latest, options.fetchImpl);
    await upsertGoldPrice(sql, {
      id: `gpr_${today}`,
      date: today,
      usdPerOz: reading.usdPerOz,
      egpPerUsd: reading.egpPerUsd,
      egpPerGram24: goldGramFromSpot(reading.usdPerOz, reading.egpPerUsd),
      source: reading.source,
      fetchedAt: new Date().toISOString()
    });
    await pruneGoldPrices(sql);
    return 'updated';
  } catch {
    return 'failed';
  }
}

export interface JobOptions {
  intervalMs?: number;
  fetchImpl?: Fetch;
  log?: (entry: Record<string, unknown>) => void;
}

export function startJobs(sql: Sql, options: JobOptions = {}): { stop(): void } {
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const tick = (): void => {
    syncGoldPrice(sql, { fetchImpl: options.fetchImpl })
      .then((outcome) => { if (outcome !== 'skipped') log({ job: 'gold-price', outcome }); })
      .catch((err: unknown) => log({ job: 'gold-price', outcome: 'error', error: String(err) }));
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? 60 * 60 * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
```

`server/main.ts`:

```ts
/* server/main.ts — the api process: migrate, then serve, then run jobs.

   Migrations connect as the superuser (they create tables); everything after
   connects as `app`, which owns nothing, so RLS applies to every request. */

import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { connect } from './db.ts';
import { startJobs } from './jobs.ts';
import { kratosWhoami } from './kratos.ts';
import { migrate } from './migrate.ts';
import { cachedWhoami } from './session.ts';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

const appDomain = required('APP_DOMAIN');

const admin = connect(required('MIGRATION_DATABASE_URL'), { max: 1 });
const applied = await migrate(admin);
await admin.end();
if (applied.length) console.log(JSON.stringify({ migrated: applied }));

const sql = connect(required('DATABASE_URL'));
const app = createApp({
  sql,
  appOrigin: `https://${appDomain}`,
  whoami: cachedWhoami(kratosWhoami(process.env['KRATOS_PUBLIC_URL'] ?? 'http://kratos:4433'))
});
const jobs = startJobs(sql);

const port = Number(process.env['PORT'] ?? 3000);
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' },
  (info) => console.log(JSON.stringify({ listening: info.port })));

const shutdown = (): void => {
  jobs.stop();
  server.close(() => { void sql.end().then(() => process.exit(0)); });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

Add to `package.json` scripts `"start:api": "node server/main.ts"`, and append ` && node test/gold.ts` to `"test:db"`.

- [ ] **Step 4: Run, expect PASS**

```bash
node test/gold.ts && pnpm typecheck
```

Expected: `all checks passed`.

Smoke-test the entry point against the test database, in Git Bash:

```bash
APP_DOMAIN=localhost PORT=3999 KRATOS_PUBLIC_URL=http://127.0.0.1:9 \
MIGRATION_DATABASE_URL=postgres://postgres:test-admin@127.0.0.1:54329/app \
DATABASE_URL=postgres://app:test-app@127.0.0.1:54329/app \
node server/main.ts & API=$!
until curl -sf http://127.0.0.1:3999/healthz; do sleep 0.5; done; echo
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3999/api/me
kill $API
```

Expected: `ok`, then `401`.

- [ ] **Step 5: Commit**

```bash
git add server/gold-price.ts server/jobs.ts server/main.ts test/gold.ts package.json
git commit -m "feat(server): daily shared gold price job and api entry point

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The web talks to the API: client, async actions, awaited call sites

**Files:**
- Create: `src/web/state/api.ts`, `src/web/state/boot.ts`
- Rewrite: `src/web/state/app.ts`, `src/web/state/actions.ts`
- Delete: `src/web/state/gold-price.ts`
- Modify: `src/web/main.tsx`, `src/web/ui/App.tsx`, `src/web/ui/feedback.ts`, `src/web/ui/components/{Form,Dialog,Sheet,RecurringSection}.tsx`, `src/web/ui/tabs/{Accounts,Bills,Goals,Gold,Income,Purchases,Settings}.tsx`, `src/web/app.css`, `package.json`
- Test: `test/web-state.ts`, `test/await-actions.ts`

**Interfaces:**
- Consumes: `applyChanges`, `MutationResponse`, `StateResponse`, `ErrorBody` and `UserCollection` (Task 5); endpoint paths and bodies (Tasks 7–9).
- Produces `src/web/state/app.ts`: `app: Signal<AppState>`, `snapshot(): AppState`, `reachable: Signal<boolean>`, `booting: Signal<boolean>`, `bootError: Signal<string | null>` and `hydrate(loaded: unknown): AppState`.
- Produces `src/web/state/api.ts`:
  - `class ApiError extends Error { status: number; code: string }` and `inFlight: Signal<number>`
  - `currentVersion(): number` and `onUnauthorized(handler: () => void): void`
  - `request<T>(method: string, path: string, body?: unknown, raw?: string): Promise<T>`
  - `mutate<R>(method: string, path: string, body?: unknown, raw?: string): Promise<R>`, which is serialized and resolves to `result`
  - `refresh(): Promise<void>`, `idle(): Promise<void>` and `forget(): void`
- Produces `src/web/state/boot.ts`: `interface BootOutcome { added: CatchUpResult }`, `boot(): Promise<BootOutcome | null>` (idempotent until `resetApp()`) and `resetApp(): void`.
- Produces `src/web/state/actions.ts`, with the same names as today, now async:
  - `upsert<K extends UserCollection>(c: K, r: Draft<K>): Promise<RecordOf<K>>`
  - `remove(c: UserCollection, id: Id): Promise<void>` and `updateSettings(patch): Promise<void>`
  - `replaceState(next: unknown): Promise<void>` and `clearAll(): Promise<void>`
  - `importJSON(text): Promise<Record<CollectionKey, number>>` and `exportJSON(): string` (still synchronous)
  - `generateBills(p): Promise<number>`, `generateIncome(p): Promise<number>` and `catchUp(): Promise<CatchUpResult>`
  - `linkGeneratedTo(c, t): Promise<number>`, `saveGoal(d, paid?): Promise<void>` and `moveGoal(id, delta): Promise<void>`
  - `borrow(t): Promise<void>`, `repay(id, p): Promise<void>` and `reconcile(id, actual, date): Promise<Cents>`
  - `recordGoldPrice` is removed, because gold prices are written by the server job (Task 10).
- Produces in `src/web/ui/feedback.ts`: `failureText(err: unknown): string` and `act(work: () => Promise<unknown>): Promise<boolean>`.
- `Form`'s `onSubmit`, `AddSection`'s `onSubmit` and `Editor`'s `onSave` now accept `(data) => void | Promise<unknown>`. They wait for the promise, keep the form open and toast if it rejects, and disable the submit button meanwhile.

- [ ] **Step 1: Write the failing tests**

`test/web-state.ts`:

```ts
/* Web state test: the browser's half of the wire, against a fake server.
   Boot loads then catches up; a write applies exactly the change it was sent;
   a version that skips ahead means another device wrote, so the whole state is
   fetched again; writes go one at a time; failures are errors with the
   server's own words.

   Run:  node test/web-state.ts */

import { blankState, upsert as domainUpsert } from '../src/domain/records.ts';
import type { AppState } from '../src/domain/types.ts';
import { reconcile, remove, upsert } from '../src/web/state/actions.ts';
import { ApiError, currentVersion, inFlight, onUnauthorized } from '../src/web/state/api.ts';
import { app, booting, reachable } from '../src/web/state/app.ts';
import { boot, resetApp } from '../src/web/state/boot.ts';
import { check, finish, title } from './support/check.ts';

type Reply = { status: number; body: unknown };
let route: (method: string, path: string, body: string | undefined) => Reply | Promise<Reply>;
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${String(input)}`);
  const reply = await route(method, String(input), init?.body as string | undefined);
  return new Response(JSON.stringify(reply.body), { status: reply.status });
}) as typeof fetch;

const serverState: AppState = domainUpsert(blankState(), 'accounts',
  { id: 'acc_1', name: 'Card', type: 'Current Account', opening: 100, target: 0, notes: '' }).state;
const none = { income: 0, bills: 0, total: 0 };
const tea = { id: 'pur_1', goalId: null, date: '2026-07-02', item: 'Tea', category: 'Groceries', amount: 250, accountId: 'acc_1', method: 'Cash', notes: '' };

title('boot');
route = (method, path) => path === '/api/state'
  ? { status: 200, body: { version: 4, state: serverState } }
  : { status: 200, body: { version: 4, changes: {}, result: none } };
const outcome = await boot();
check('loads the state, then asks for the catch-up', calls, ['GET /api/state', 'POST /api/recurring/catch-up']);
check('and reports what the catch-up added', outcome, { added: none });
check('the signal holds the server\'s state', app.peek().accounts.map((a) => a.id), ['acc_1']);
check('boot is over', booting.peek(), false);
check('the version is the server\'s', currentVersion(), 4);
check('booting twice does not load twice', [await boot(), calls.length], [{ added: none }, 2]);

title('a write');
route = () => ({ status: 200, body: { version: 5, changes: { purchases: { upserts: [tea], deletes: [] } }, result: tea } });
const saved = await upsert('purchases', { item: 'Tea', amount: 250 });
check('returns the saved record, as it always has', saved.item, 'Tea');
check('applies the change to the signal', app.peek().purchases.map((p) => p.id), ['pur_1']);
check('and moves the version on by one', currentVersion(), 5);
check('nothing is left in flight', inFlight.peek(), 0);

title('another device wrote in between');
calls.length = 0;
const both = { ...serverState, purchases: [tea, { ...tea, id: 'pur_2' }] };
route = (method, path) => path === '/api/state'
  ? { status: 200, body: { version: 7, state: both } }
  : { status: 200, body: { version: 7, changes: { purchases: { upserts: [], deletes: [] } }, result: null } };
await remove('purchases', 'pur_9');
check('a version two ahead means the state is fetched again', calls, ['DELETE /api/purchases/pur_9', 'GET /api/state']);
check('and the other device\'s record appears', app.peek().purchases.length, 2);
check('at the server\'s version', currentVersion(), 7);

title('a write that changed nothing');
calls.length = 0;
route = () => ({ status: 200, body: { version: 7, changes: {}, result: 0 } });
check('answers with its result', await reconcile('acc_1', 100, '2026-07-31'), 0);
check('and fetches nothing more', calls, ['POST /api/accounts/acc_1/reconcile']);

title('failures');
route = () => ({ status: 400, body: { error: { code: 'domain', message: 'This file is not an Income Tracker backup.' } } });
let failed: unknown = null;
try { await upsert('purchases', { item: 'x' }); } catch (err) { failed = err; }
check('a refused write is an ApiError with the server\'s message',
  [failed instanceof ApiError, (failed as ApiError).status, (failed as Error).message],
  [true, 400, 'This file is not an Income Tracker backup.']);
check('and the state is untouched', app.peek().purchases.length, 2);
route = () => { throw new TypeError('fetch failed'); };
failed = null;
try { await upsert('purchases', { item: 'x' }); } catch (err) { failed = err; }
check('no server at all is code "offline"', (failed as ApiError).code, 'offline');
check('and the page knows it is offline', reachable.peek(), false);
route = () => ({ status: 200, body: { version: 7, changes: {}, result: tea } });
await upsert('purchases', tea);
check('the next answer brings it back', reachable.peek(), true);
let signedOut = 0;
onUnauthorized(() => { signedOut++; });
route = () => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in to continue.' } } });
try { await upsert('purchases', tea); } catch { /* expected */ }
check('a 401 hands over to the sign-in screen', signedOut, 1);

title('writes go one at a time');
let active = 0;
let most = 0;
let next = 7;
route = async () => {
  active++; most = Math.max(most, active);
  await new Promise((r) => setTimeout(r, 20));
  active--;
  next++;
  return { status: 200, body: { version: next, changes: {}, result: tea } };
};
await Promise.all([upsert('purchases', tea), upsert('purchases', tea), upsert('purchases', tea)]);
check('never more than one in flight', most, 1);
check('and every version was applied in order', currentVersion(), 10);

title('signing out');
resetApp();
check('forgets the state and the version', [app.peek().purchases.length, currentVersion()], [0, 0]);

finish();
```

`test/await-actions.ts`:

```ts
/* Every write is a request now, and a request can fail. A call to an action
   that nobody awaits fails silently — the screen keeps showing what was typed
   and nothing says it was never saved. So every call to an action in the UI
   is either awaited (and its failure reaches a form, which says so) or handed
   to act() (which says so itself).

   Run:  node test/await-actions.ts */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish, title } from './support/check.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const ACTIONS = ['upsert', 'remove', 'updateSettings', 'replaceState', 'clearAll', 'importJSON',
  'generateBills', 'generateIncome', 'catchUp', 'linkGeneratedTo', 'saveGoal', 'moveGoal',
  'borrow', 'repay', 'reconcile', 'refresh'];
const CALL = new RegExp(`(?<![\\w.])(${ACTIONS.join('|')})\\(`, 'g');
const ALLOWED = /(await |act\(\(\) => |return )$/;

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []);

/** Comments blanked out, line breaks kept, so line numbers stay true. */
const code = (text: string): string => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|\s)\/\/.*$/gm, '$1');

title('every write in the UI is awaited or handed to act()');
const offenders: string[] = [];
for (const file of files(join(root, 'src', 'web', 'ui'))) {
  code(readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
    for (const match of line.matchAll(CALL)) {
      if (!ALLOWED.test(line.slice(0, match.index))) {
        offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
      }
    }
  });
}
check('no fire-and-forget writes', offenders, []);

finish();
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node test/web-state.ts`
Expected: `ERR_MODULE_NOT_FOUND` for `../src/web/state/api.ts`.
Run: `node test/await-actions.ts`
Expected: FAIL listing about 40 offenders, for example `src/web/ui/tabs/Bills.tsx:115: onCommit={(raw) => upsert('bills', …)}`.

- [ ] **Step 3: Implement**

3a. `src/web/state/app.ts` (full contents):

```ts
/* state/app.ts — the one signal the whole screen is drawn from.

   IMPORTANT for anything written in JSX: read `app.value` and pass it to the
   domain function — `activePeriods(app.value)`. A component that reads a
   plain copy renders correctly once and then never updates again.

   The state is replaced, never edited, because a signal compares with ===.
   It is filled from the server (boot.ts) and moved forward one write at a
   time by the changes each write answers with (api.ts). */

import { signal } from '@preact/signals';
import { blankState, migrate } from '../../domain/records.ts';
import type { AppState } from '../../domain/types.ts';

export const app = signal<AppState>(blankState());

/** The current state without subscribing to it. */
export const snapshot = (): AppState => app.peek();

/** False when the last request could not reach the server at all. */
export const reachable = signal(true);

export const booting = signal(true);
export const bootError = signal<string | null>(null);

/** Adopt a whole state from the server. */
export function hydrate(loaded: unknown): AppState {
  app.value = migrate(loaded);
  return app.value;
}
```

3b. `src/web/state/api.ts`:

```ts
/* state/api.ts — the browser's side of the wire.

   Reads are plain requests. Writes go through mutate(), one at a time: each
   starts only once the previous one has answered, so the version a write
   answers with is always the one after the last — and when it is not, another
   device wrote in between and the whole state is fetched again rather than
   guessed at. A write answers with what changed (wire.ts), which is applied to
   the signal as a new object so the screen redraws.

   Failures are ApiErrors carrying the server's own message, which is written
   for a person; the caller decides where to show it. */

import { signal } from '@preact/signals';
import { applyChanges } from '../../wire.ts';
import type { ErrorBody, MutationResponse, StateResponse } from '../../wire.ts';
import { app, hydrate, reachable } from './app.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Requests still on their way. The page dims its buttons while this is > 0. */
export const inFlight = signal(0);

let version = 0;
export const currentVersion = (): number => version;

let unauthorized: () => void = () => {};
/** Who to tell when the session has gone (any 401). */
export function onUnauthorized(handler: () => void): void { unauthorized = handler; }

export async function request<T>(method: string, path: string, body?: unknown, raw?: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  inFlight.value++;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    reachable.value = false;
    throw new ApiError(0, 'offline', 'Could not reach the server. Check your connection and try again.');
  } finally {
    inFlight.value--;
  }
  reachable.value = true;
  if (res.status === 401) unauthorized();

  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON — a proxy error page */ }
  if (!res.ok) {
    const error = (parsed as ErrorBody | null)?.error;
    throw new ApiError(res.status, error?.code ?? 'error', error?.message ?? `The server answered ${res.status}.`);
  }
  return parsed as T;
}

export async function refresh(): Promise<void> {
  const loaded = await request<StateResponse>('GET', '/api/state');
  hydrate(loaded.state);
  version = loaded.version;
}

async function adopt(res: MutationResponse<unknown>): Promise<void> {
  if (res.version <= version) return;               // nothing written, or already seen
  if (res.version === version + 1) {
    app.value = applyChanges(app.peek(), res);
    version = res.version;
    return;
  }
  await refresh();                                    // another device wrote in between
}

let queue: Promise<unknown> = Promise.resolve();

export function mutate<R>(method: string, path: string, body?: unknown, raw?: string): Promise<R> {
  const run = async (): Promise<R> => {
    const res = await request<MutationResponse<R>>(method, path, body, raw);
    await adopt(res);
    return res.result;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** Resolves once every queued write has answered. The browser suite waits on it. */
export const idle = (): Promise<void> => queue.then(() => undefined);

/** Signing out: nothing about the last user's version may carry over. */
export function forget(): void {
  version = 0;
  queue = Promise.resolve();
}
```

3c. `src/web/state/boot.ts`:

```ts
/* state/boot.ts — from "signed in" to "ready".

   Load the state, then ask the server to fill in the months that have passed
   since the last visit (POST /api/recurring/catch-up). The read stays a pure
   read; the catch-up is a write like any other, and the unique keys plus the
   per-user lock make it harmless when two tabs boot at once. Throws nothing: a
   failure lands in bootError, which is a screen rather than a blank page. */

import { blankState } from '../../domain/records.ts';
import type { CatchUpResult } from '../../domain/types.ts';
import { catchUp } from './actions.ts';
import { forget, refresh } from './api.ts';
import { app, bootError, booting } from './app.ts';

export interface BootOutcome {
  added: CatchUpResult;
}

let started: Promise<BootOutcome | null> | null = null;

export function boot(): Promise<BootOutcome | null> {
  started ??= (async () => {
    booting.value = true;
    bootError.value = null;
    try {
      await refresh();
      const added = await catchUp();
      booting.value = false;
      return { added };
    } catch (err) {
      booting.value = false;
      bootError.value = err instanceof Error ? err.message : String(err);
      return null;
    }
  })();
  return started;
}

/** After signing out: the next person to sign in boots from nothing. */
export function resetApp(): void {
  started = null;
  forget();
  app.value = blankState();
  booting.value = true;
  bootError.value = null;
}
```

3d. `src/web/state/actions.ts` (full contents):

```ts
/* state/actions.ts — every write the screen can make.

   The same names and the same answers as the offline build — upsert hands back
   the saved record, reconcile the difference, catchUp the counts — but each is
   now a request, so each returns a promise. The rules still live in domain/,
   on the server now: these functions only say which one to run. */

import * as Backup from '../../domain/backup.ts';
import type * as Debt from '../../domain/debt.ts';
import type * as Forecast from '../../domain/forecast.ts';
import { uid } from '../../domain/records.ts';
import type { Draft } from '../../domain/records.ts';
import type {
  CatchUpResult, Cents, CollectionKey, Id, IsoDate, Period, RecordOf, Settings
} from '../../domain/types.ts';
import type { UserCollection } from '../../wire.ts';
import { mutate } from './api.ts';
import { snapshot } from './app.ts';

const at = (id: Id): string => encodeURIComponent(id);

export const upsert = <K extends UserCollection>(collection: K, record: Draft<K>): Promise<RecordOf<K>> =>
  mutate<RecordOf<K>>('POST', `/api/${collection}`, record);

export async function remove(collection: UserCollection, id: Id): Promise<void> {
  await mutate('DELETE', `/api/${collection}/${at(id)}`);
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  await mutate('PATCH', '/api/settings', patch);
}

/** Replaces everything with the backup in `text`. */
export const importJSON = (text: string): Promise<Record<CollectionKey, number>> =>
  mutate('POST', '/api/backup/import', undefined, text);

export async function replaceState(next: unknown): Promise<void> {
  await importJSON(JSON.stringify(next));
}

export async function clearAll(): Promise<void> {
  await mutate('DELETE', '/api/data');
}

/** Built from what is on screen, which is what the server holds. */
export const exportJSON = (): string => Backup.exportJSON(snapshot());

/* ------------------------------------------------------------- generation */

export const generateBills = (period: Period): Promise<number> =>
  mutate('POST', '/api/recurring/generate', { collection: 'bills', period });

export const generateIncome = (period: Period): Promise<number> =>
  mutate('POST', '/api/recurring/generate', { collection: 'income', period });

export const catchUp = (): Promise<CatchUpResult> => mutate('POST', '/api/recurring/catch-up', {});

export async function linkGeneratedTo(
  collection: 'incomeTemplates' | 'billTemplates',
  template: { id?: Id; accountId?: Id | '' } | null | undefined
): Promise<number> {
  // The domain answers 0 for this without looking; no need to ask the server.
  if (!template?.id || !template.accountId) return 0;
  return mutate('POST', '/api/recurring/link', {
    collection, template: { id: template.id, accountId: template.accountId }
  });
}

/* ------------------------------------------------------------------ goals */

/* A new goal is given its id here, so it can be addressed like any other. */
export async function saveGoal(draft: Draft<'goals'>, paid: Forecast.GoalPayment = {}): Promise<void> {
  const { id = uid('gol'), ...fields } = draft;
  await mutate('PUT', `/api/goals/${at(id)}`, { draft: fields, paid });
}

export async function moveGoal(id: Id, delta: number): Promise<void> {
  await mutate('POST', `/api/goals/${at(id)}/move`, { delta });
}

/* ------------------------------------------------- debts and reconciling */

export async function borrow(taken: Debt.Borrowing): Promise<void> {
  await mutate('POST', '/api/debts', taken);
}

export async function repay(debtId: Id, paid: Debt.Repayment): Promise<void> {
  await mutate('POST', `/api/debts/${at(debtId)}/repay`, paid);
}

/** Writes the row that makes an account agree with its real balance, and says
    what it corrected by. Zero means it already agreed and nothing was written. */
export const reconcile = (accountId: Id, actual: Cents, date: IsoDate): Promise<Cents> =>
  mutate('POST', `/api/accounts/${at(accountId)}/reconcile`, { actual, date });
```

3e. `git rm src/web/state/gold-price.ts`. The server fetches the price now (Task 10).

3f. `src/web/ui/feedback.ts`: add this import and these two exports below `export { toast } …`:

```ts
/** What a failed write says. The server's messages are already written for a person. */
export const failureText = (err: unknown): string =>
  `Not saved — ${err instanceof Error ? err.message : String(err)}`;

/* For a write started from a plain button rather than a form: a failure becomes
   a toast instead of an unhandled rejection, and the caller learns whether it
   worked. Forms and editors do the same for themselves. */
export async function act(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (err) {
    toast(failureText(err));
    return false;
  }
}
```

3g. `src/web/ui/components/Form.tsx`:
- Add the imports `import { useState } from 'preact/hooks';`, `import { toast } from './Toast.tsx';` and `import { failureText } from '../feedback.ts';`.
- Change `onSubmit: (data: FormData) => void;` to `onSubmit: (data: FormData) => void | Promise<unknown>;`.
- Replace the `Form` function with:

```tsx
export function Form({ fields, record, state, onSubmit, onInvalid, onChange, children }: FormProps) {
  /* A save is a request now. While it is out, the buttons are disabled so a
     double click cannot send it twice; if it fails the form stays as typed and
     says why, rather than clearing as if it had worked. */
  const [saving, setSaving] = useState(false);
  return (
    <form
      onChange={onChange}
      aria-busy={saving ? 'true' : undefined}
      onSubmit={(e: Event) => {
        e.preventDefault();
        if (saving) return;
        const data = readForm(e.currentTarget as HTMLFormElement, fields);
        if (!data) { onInvalid?.(); return; }
        setSaving(true);
        void Promise.resolve()
          .then(() => onSubmit(data))
          .catch((err: unknown) => toast(failureText(err)))
          .finally(() => setSaving(false));
      }}
    >
      <FormGrid fields={fields} record={record} state={state} />
      <fieldset class="plain-fieldset" disabled={saving}>{children}</fieldset>
    </form>
  );
}
```

3h. `src/web/ui/components/Dialog.tsx`:
- Change `import { useLayoutEffect, useRef } from 'preact/hooks';` to `import { useLayoutEffect, useRef, useState } from 'preact/hooks';`.
- Add `import { toast } from './Toast.tsx';` and `import { failureText } from '../feedback.ts';`.
- Change `onSave: (data: FormData) => void;` to `onSave: (data: FormData) => void | Promise<unknown>;`.
- Inside `Editor`, after `const dialog = useRef…`, add `const [saving, setSaving] = useState(false);`.
- Replace the `onSubmit` handler and the save button:

```tsx
        onSubmit={(e: Event) => {
          e.preventDefault();
          if (saving) return;
          const data = readForm(e.currentTarget as HTMLFormElement, fields);
          if (!data) { onInvalid?.(); return; }
          /* Closed only once the server has it. A refusal keeps the dialog open
             with everything still typed in, and says why. */
          setSaving(true);
          void Promise.resolve()
            .then(() => onSave({ ...data, id }))
            .then(() => onClose(), (err: unknown) => { setSaving(false); toast(failureText(err)); });
        }}
```

```tsx
          <button class="primary" type="submit" disabled={saving}>
            {saving ? 'Saving…' : (saveLabel ?? 'Save changes')}
          </button>
```

3i. `src/web/ui/components/Sheet.tsx`:
- Change `onSubmit: (data: FormData) => void;` in `AddSectionProps` to `onSubmit: (data: FormData) => void | Promise<unknown>;`.
- Replace `onSubmit={(data) => { onSubmit(data); setGeneration(generation + 1); }}` with `onSubmit={async (data) => { await onSubmit(data); setGeneration((g) => g + 1); }}`, so the form only clears once the save has succeeded.

3j. `src/web/ui/components/RecurringSection.tsx`: replace the `onSubmit={(data) => { … }}` of the `<Form>` with:

```tsx
              onSubmit={async (data) => {
                /* The month on screen is where this commitment starts; nothing
                   is ever generated before it, and the sweep is reset so
                   changing the schedule refills from the anchor. */
                const template = await upsert(collection, { ...data, anchor: period, generatedThrough: '' });
                const linked = await linkGeneratedTo(collection, template);
                const added = await catchUp();
                setGeneration(generation + 1);
                toast(templateToast(saved, added.total, linked));
              }}
```

3k. Tabs. Make each replacement exactly as shown, and add `act` to the existing `import { … } from '../feedback.ts';` line of each tab that uses it.

`src/web/ui/tabs/Accounts.tsx`:
- `const saveMovement = (data: FormData): void => {` becomes `const saveMovement = async (data: FormData): Promise<void> => {`, and its body line `upsert('savingsTx', data);` becomes `await upsert('savingsTx', data);`.
- In the AddSection, `onSubmit={(data) => {` becomes `onSubmit={async (data) => {`, and `saveMovement(data);` becomes `await saveMovement(data);`.
- `if (ok) remove('accounts', a.id);` becomes `if (ok) void act(() => remove('accounts', a.id));`.
- `if (ok) remove('accounts', d.account.id);` becomes `if (ok) void act(() => remove('accounts', d.account.id));`.
- `onDelete={() => { if (confirmDelete('movement')) remove('savingsTx', t.id); }}` becomes `onDelete={() => { if (confirmDelete('movement')) void act(() => remove('savingsTx', t.id)); }}`.
- Borrow editor: `onSave={(data) => {` becomes `onSave={async (data) => {`, and `borrow({` becomes `await borrow({`.
- Repay editor: `onSave={(data) => {` becomes `onSave={async (data) => {`, and `repay(repaying.account.id, {` becomes `await repay(repaying.account.id, {`.
- Reconcile editor: `onSave={(data) => {` becomes `onSave={async (data) => {`, and `const corrected = reconcile(` becomes `const corrected = await reconcile(`.
- `onSave={(data) => { upsert('accounts', data); toast('Saved'); }}` becomes `onSave={async (data) => { await upsert('accounts', data); toast('Saved'); }}`.
- `onSave={(data) => { saveMovement(data); toast('Saved'); }}` becomes `onSave={async (data) => { await saveMovement(data); toast('Saved'); }}`.

`src/web/ui/tabs/Bills.tsx`:
- `onCommit={(raw) => upsert('bills', { id: b.id, amount: parseMoney(raw) })}` becomes `onCommit={(raw) => void act(() => upsert('bills', { id: b.id, amount: parseMoney(raw) }))}`.
- `onCommit={(raw) => upsert('bills', { id: b.id, units: raw.trim() === '' ? null : Number(raw) })}` becomes `onCommit={(raw) => void act(() => upsert('bills', { id: b.id, units: raw.trim() === '' ? null : Number(raw) }))}`.
- `onClick={() => upsert('bills', b.status === 'paid'` becomes `onClick={() => void act(() => upsert('bills', b.status === 'paid'`, and the closing `: { id: b.id, paidDate: todayISO() })}` becomes `: { id: b.id, paidDate: todayISO() }))}`.
- `onClick={() => { if (confirmDelete('bill')) remove('bills', b.id); }}` becomes `onClick={() => { if (confirmDelete('bill')) void act(() => remove('bills', b.id)); }}`.
- `onDelete={() => { if (confirmDelete('recurring bill')) remove('billTemplates', t.id); }}` becomes `onDelete={() => { if (confirmDelete('recurring bill')) void act(() => remove('billTemplates', t.id)); }}`.
- The generate button becomes:

```tsx
            <button
              onClick={() => void act(async () => {
                const made = await generateBills(period);
                toast(made ? `Added ${plural(made, 'bill')}` : 'Already up to date');
              })}
            >Generate from recurring</button>
```

- `onSave={(data) => { upsert('bills', data); toast('Saved'); }}` becomes `onSave={async (data) => { await upsert('bills', data); toast('Saved'); }}`.
- The template editor's `onSave={(data) => {` becomes `onSave={async (data) => {`, and `const linked = linkGeneratedTo('billTemplates', upsert('billTemplates', data));` becomes `const linked = await linkGeneratedTo('billTemplates', await upsert('billTemplates', data));`.

`src/web/ui/tabs/Income.tsx`:
- `remove('income', r.id)` and `remove('incomeTemplates', t.id)` inside the `onDelete` handlers become `void act(() => remove('income', r.id))` and `void act(() => remove('incomeTemplates', t.id))`.
- The AddSection `onSubmit={(data) => {` becomes `onSubmit={async (data) => {`, with `await upsert('income', data);`.
- The generate button becomes:

```tsx
            <button
              onClick={() => void act(async () => {
                const made = await generateIncome(period);
                toast(made ? `Added ${plural(made, 'entry', 'entries')}` : 'Already up to date');
              })}
            >Generate from recurring</button>
```

- `onSave={(data) => { upsert('income', data); toast('Saved'); }}` becomes `onSave={async (data) => { await upsert('income', data); toast('Saved'); }}`.
- The template editor: `onSave={async (data) => {` and `const linked = await linkGeneratedTo('incomeTemplates', await upsert('incomeTemplates', data));`.

`src/web/ui/tabs/Purchases.tsx`:
- `remove('purchases', r.id)` becomes `void act(() => remove('purchases', r.id))`.
- The AddSection `onSubmit={async (data) => {` with `await upsert('purchases', data);`.
- `onSave={async (data) => { await upsert('purchases', data); toast('Saved'); }}`.
- Change the feedback import to `import { act, confirmDelete, followDate } from '../feedback.ts';`.

`src/web/ui/tabs/Goals.tsx`:
- `onClick={() => moveGoal(g.goal.id, -1)}` becomes `onClick={() => void act(() => moveGoal(g.goal.id, -1))}`. Make the same change for `1`.
- Both `remove('goals', …)` delete handlers become `void act(() => remove('goals', g.goal.id))` and `void act(() => remove('goals', g.id))`.
- The AddSection: `onSubmit={async (data) => { await saveGoal({ ...data, priority: nextPriority(state) }); toast('Goal added'); }}`.
- The checkbox: `onChange={(e) => void act(() => updateSettings({ forecastSpendingAuto: (e.target as HTMLInputElement).checked }))}`.
- The figure box: `onChange={(e) => void act(() => updateSettings({ forecastSpending: parseMoney((e.target as HTMLInputElement).value) }))}`.
- The buy editor: `onSave={async (data) => {` and `await saveGoal(`.
- The edit editor: `onSave={async (data) => { await saveGoal(data); toast('Saved'); }}`.

`src/web/ui/tabs/Gold.tsx`:
- Delete `import { isBusy, refresh } from '../../state/gold-price.ts';` and add `import { refresh } from '../../state/api.ts';`.
- The price-settings button becomes:

```tsx
        <button
          class="primary"
          onClick={() => void act(async () => {
            await updateSettings({
              goldSync: !!sync.current?.checked,
              goldPremium: Number(premium.current?.value) || 0,
              goldManualPrice: parseMoney(manual.current?.value ?? '')
            });
            toast('Price settings saved');
          })}
        >Save price settings</button>
```

- Replace the comment above `const [fetching, setFetching] = useState(false);` with `/* The price is fetched once a day on the server for everyone; this button reloads it, and needs its own reason to redraw while it does. */`.
- The update button becomes:

```tsx
          <button
            disabled={fetching}
            onClick={() => {
              setFetching(true);
              void act(async () => {
                await refresh();
                toast('Price reloaded');
              }).finally(() => setFetching(false));
            }}
          >{fetching ? 'Updating…' : 'Update price'}</button>
```

- `remove('gold', r.id)` becomes `void act(() => remove('gold', r.id))`.
- The AddSection `onSubmit={async (data) => {` with `await upsert('gold', data);`.
- `onSave={async (data) => { await upsert('gold', { ...data, karat: Number(data.karat) }); toast('Saved'); }}`.

`src/web/ui/tabs/Settings.tsx`:
- Change the feedback import to `import { act, download } from '../feedback.ts';`.
- Replace `onRestoreFile`'s `reader.onload` with:

```tsx
    reader.onload = () => {
      void (async () => {
        try {
          const counts = await importJSON(String(reader.result));
          toast(`Imported ${counts.income} income, ${counts.bills} bills, ${counts.purchases} purchases`);
        } catch (err) {
          alert(`That file could not be imported.\n\n${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (restore.current) restore.current.value = '';
        }
      })();
    };
```

- Replace the Save-settings `onClick={() => { … }}` with:

```tsx
              onClick={() => void act(async () => {
                await updateSettings({
                  currencySymbol: symbol.current?.value || '',
                  currencyCode: code.current?.value || '',
                  locale: locale.current?.value || 'en-US',
                  savingsGoalRate: Number(goal.current?.value) || 0,
                  autoGenerate: !!auto.current?.checked
                });
                /* Switching it back on should catch up straight away rather
                   than waiting for the next time the app is opened. */
                const added = await catchUp();
                toast(added.total
                  ? `Settings saved · ${plural(added.total, 'entry', 'entries')} added`
                  : 'Settings saved');
              })}
```

- Replace the "Your data" paragraph text with `Your records are kept on the server, under your account. Download a backup now and then — it is also how records from the offline version are brought in.`
- Change the restore button's confirm text to `'Importing replaces everything currently stored.\n\n' + 'Download a backup first if you are unsure. Continue?'` and its label to `Import backup (.json)`.
- In the danger zone, `clearAll(); toast('All data erased');` becomes `void act(async () => { await clearAll(); toast('All data erased'); });`.

3l. `src/web/ui/App.tsx`:
- Change the imports to `import { app, bootError, booting, reachable } from '../state/app.ts';` and `import type { BootOutcome } from '../state/boot.ts';`.
- Replace `StorageNotice` with:

```tsx
function OfflineNotice() {
  if (reachable.value) return null;
  return (
    <div class="notice danger" style="margin-bottom:24px">
      <strong>Can't reach the server. </strong>
      Your last change may not have been saved. Check your connection — the app carries on as soon
      as the server answers again.
    </div>
  );
}
```

- Use `<OfflineNotice />` where `<StorageNotice />` was.
- In the outcome effect, delete the `if (result.migrated) { … } else` branch, so it begins `if (result.added.total) {`.
- The two Splash calls become `<Splash title="Could not start" lines={[bootError.value, 'Reload the page to try again.']} />` and `<Splash title="Income Tracker" lines={['Loading your data…']} />`.

3m. `src/web/main.tsx` (full contents):

```tsx
/* main.tsx — the bundle entry point. */

import { effect } from '@preact/signals';
import { render } from 'preact';
import { accountBalance } from '../domain/selectors.ts';
import { clearAll, upsert } from './state/actions.ts';
import { idle, inFlight, refresh } from './state/api.ts';
import { app, snapshot } from './state/app.ts';
import { boot } from './state/boot.ts';
import { goPeriod, goTab, startRouting } from './state/route.ts';
import type { TabId } from './state/route.ts';
import { App } from './ui/App.tsx';
import { build as buildWorkbook, filename as workbookFilename } from '../workbook/build.ts';
import type { Scope } from '../workbook/build.ts';

/* A handle on the running app, under `__app` in the console. The browser suite
   drives the app through it. Everything here is something the signed-in person
   can already do from the screen, against their own data only. */
Object.assign(globalThis, {
  __app: {
    /** The live state object. Replaced on every write, so read it each time. */
    state: snapshot,
    accountBalance: (id: string) => accountBalance(snapshot(), id),
    upsert,
    clearAll,
    /** Fetch the whole state again, e.g. after the gold price changed. */
    reload: refresh,
    /** Resolves when every write so far has answered. */
    idle,
    buildWorkbook: (scope: Scope) => buildWorkbook(snapshot(), scope),
    workbookFilename,
    goTab: (tab: TabId) => goTab(tab),
    goPeriod: (period: string) => goPeriod(period),
    render: () => { app.value = { ...app.peek() }; }
  }
});

function start(): void {
  startRouting();
  const host = document.getElementById('app');
  if (!host) return;
  // Outside any component, so a request starting or ending redraws nothing.
  effect(() => { document.body.classList.toggle('is-busy', inFlight.value > 0); });
  render(<App outcome={boot()} />, host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
```

3n. Append to `src/web/app.css`:

```css
/* A write is on its way. Buttons that would start another one look and act
   inert until it answers; forms and dialogs also disable their own submit. */
body.is-busy main button,
body.is-busy dialog button[type="submit"] { pointer-events: none; opacity: .6; }

/* Wraps a form's buttons so one `disabled` covers them all; draws nothing. */
.plain-fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
```

3o. Append ` && node test/web-state.ts && node test/await-actions.ts` to the `"test"` script.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test && pnpm build`
Expected: every suite ends with `all checks passed`, typecheck is clean, and `dist/web` is rebuilt.

- [ ] **Step 5: Commit**

```bash
git add -A src/web test/web-state.ts test/await-actions.ts package.json
git commit -m "feat(web): api client with serialized writes; actions and every call site go async

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Path routing, Kratos browser flows, auth screens and the session gate

**Files:**
- Rewrite: `src/web/state/route.ts`
- Create: `src/web/auth/kratos.ts`, `src/web/auth/session.ts`, `src/web/auth/FlowForm.tsx`, `src/web/auth/screens.tsx`
- Modify: `src/web/ui/App.tsx`, `src/web/ui/Topbar.tsx`, `src/web/main.tsx`, `src/web/app.css`, `package.json`
- Test: `test/route.ts`, `test/kratos.ts`

**Interfaces:**
- Consumes: `onUnauthorized` (Task 11), `boot`, `resetApp`, `BootOutcome` (Task 11).
- Produces `src/web/state/route.ts`:
  - `type TabId` and `TAB_IDS` (unchanged), `type AuthRoute = 'login' | 'registration' | 'recovery' | 'verification' | 'settings/security' | 'error'`
  - the signals `tab`, `period`, `authRoute: Signal<AuthRoute | null>` and `search: Signal<string>`
  - `interface ParsedPath { auth: AuthRoute | null; tab: TabId | null; period: Period | null }` and `parsePath(pathname: string): ParsedPath`
  - `pathFor(tab: TabId, period: Period): string` and `go(next: { tab?: TabId; period?: Period }): void`
  - `goTab(id)`, `goPeriod(p)`, `navigate(to: string, options?: { replace?: boolean }): void` and `startRouting(): void`
- Produces `src/web/auth/kratos.ts`:
  - the types `FlowKind`, `UiText`, `UiNode`, `Flow`, `Session`, `Outcome` (`{kind:'flow',flow} | {kind:'done',body} | {kind:'redirect',to} | {kind:'restart',reason}`) and `WhoAmI`
  - `outcomeOf(status: number, body: unknown): Outcome`
  - `createFlow(kind, params?): Promise<Outcome>`, `getFlow(kind, id): Promise<Outcome>` and `submitFlow(flow, body): Promise<Outcome>`
  - `whoami(): Promise<WhoAmI>`, `logout(): Promise<void>` and `errorMessage(id: string): Promise<string>`
  - `bodyFromForm(nodes: readonly UiNode[], entries: Iterable<[string, FormDataEntryValue]>, pressed: { name: string; value: string } | null): Record<string, unknown>`
- Produces `src/web/auth/session.ts`:
  - `session: Signal<Session | null | undefined>`, `emailOf(s): string` and `isVerified(s): boolean`
  - `checkSession(options?: { followRedirect?: boolean }): Promise<Session | null>` and `signOut(): Promise<void>`
- Produces `src/web/auth/FlowForm.tsx`: `FlowForm(props: { flow: Flow; groups?: readonly string[]; onOutcome: (o: Outcome) => void })`.
- Produces `src/web/auth/screens.tsx`: `AuthScreen({ route }: { route: AuthRoute })`, plus `Login`, `Registration`, `Recovery`, `Verification`, `SecuritySettings` and `AuthError`.
- `App` no longer takes an `outcome` prop. It boots itself once a session exists.

DOM contract that the browser suite (Task 14) relies on:
- Every rendered node is wrapped in an element with `data-node-id` equal to the Kratos node's `attributes.name` (inputs) or `attributes.id` (text and img).
- Inputs keep Kratos's `name`, for example `identifier`, `password`, `traits.email`, `totp_code`, `code` and `email`.
- Submit buttons are `<button type="submit" name value>`.

- [ ] **Step 1: Write the failing tests**

`test/route.ts`:

```ts
/* Route test: the address bar is the route. Tabs and months live in the path
   now (/bills/2026-07), beside the sign-in screens (/login), and
   /settings/security is a screen of its own even though /settings/<month> is
   the Settings tab.

   Run:  node test/route.ts */

import { parsePath, pathFor } from '../src/web/state/route.ts';
import { check, finish, title } from './support/check.ts';

title('paths');
check('a tab and a month', parsePath('/bills/2026-07'), { auth: null, tab: 'bills', period: '2026-07' });
check('a sign-in screen', parsePath('/login'), { auth: 'login', tab: null, period: null });
check('a trailing slash is the same screen', parsePath('/registration/'), { auth: 'registration', tab: null, period: null });
check('security settings are an auth screen', parsePath('/settings/security'), { auth: 'settings/security', tab: null, period: null });
check('the Settings tab in a month is not', parsePath('/settings/2026-07'), { auth: null, tab: 'settings', period: '2026-07' });
check('a tab with no month keeps the month on screen', parsePath('/gold'), { auth: null, tab: 'gold', period: null });
check('the root changes nothing', parsePath('/'), { auth: null, tab: null, period: null });
check('nonsense changes nothing', parsePath('/nope/13-2026'), { auth: null, tab: null, period: null });
check('building a path', pathFor('savings', '2026-08'), '/savings/2026-08');

finish();
```

`test/kratos.ts`:

```ts
/* Kratos client test: what each answer from a browser flow means for the
   screen, and that a form is sent the way Kratos's JSON API reads it.

   Run:  node test/kratos.ts */

import {
  bodyFromForm, createFlow, logout, outcomeOf, submitFlow, whoami
} from '../src/web/auth/kratos.ts';
import type { Flow, UiNode } from '../src/web/auth/kratos.ts';
import { check, finish, title } from './support/check.ts';

const flow: Flow = { id: 'f1', ui: { action: 'https://app.test/auth/self-service/login?flow=f1', method: 'POST', nodes: [] } };
const node = (name: string, type: string, value: unknown = '', group = 'password'): UiNode => ({
  type: 'input', group, attributes: { node_type: 'input', name, type, value }, messages: [], meta: {}
});

title('what an answer means');
check('a flow comes back to be drawn again', outcomeOf(400, flow), { kind: 'flow', flow });
check('so does a settings flow that succeeded', outcomeOf(200, { ...flow, state: 'success' }).kind, 'flow');
check('a session means done', outcomeOf(200, { session: { id: 's' } }).kind, 'done');
check('422 means go somewhere else',
  outcomeOf(422, { error: { id: 'browser_location_change_required' }, redirect_browser_to: 'https://app.test/settings/security?flow=x' }),
  { kind: 'redirect', to: 'https://app.test/settings/security?flow=x' });
check('an expired flow starts again', outcomeOf(410, { error: { id: 'self_service_flow_expired', message: 'expired' } }),
  { kind: 'restart', reason: 'expired' });
check('a CSRF failure starts again', outcomeOf(403, { error: { id: 'security_csrf_violation', reason: 'csrf' } }).kind, 'restart');
check('a refresh demand goes where it says',
  outcomeOf(403, { error: { id: 'session_refresh_required' }, redirect_browser_to: '/auth/self-service/login/browser?refresh=true' }).kind, 'redirect');
check('already signed in means the app', outcomeOf(400, { error: { id: 'session_already_available' } }), { kind: 'redirect', to: '/' });
check('no session for settings means sign in', outcomeOf(401, { error: { id: 'session_inactive' } }), { kind: 'redirect', to: '/login' });

title('a form as Kratos reads it');
const nodes = [node('csrf_token', 'hidden', 'tok', 'default'), node('traits.email', 'email'), node('password', 'password'),
  node('method', 'submit', 'password'), node('lookup_secret_reveal', 'submit', true, 'lookup_secret'), node('remember', 'checkbox', false)];
check('dotted names become nested objects, the button pressed is included',
  bodyFromForm(nodes, [['csrf_token', 'tok'], ['traits.email', 'a@b.c'], ['password', 'pw'], ['remember', 'true']],
    { name: 'method', value: 'password' }),
  { csrf_token: 'tok', traits: { email: 'a@b.c' }, password: 'pw', remember: true, method: 'password' });
check('a button keeps its value\'s type', bodyFromForm(nodes, [['csrf_token', 'tok']], { name: 'lookup_secret_reveal', value: 'true' }),
  { csrf_token: 'tok', lookup_secret_reveal: true });

title('requests');
const sent: { url: string; init: RequestInit | undefined }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: flow };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  sent.push({ url: String(input), init });
  return new Response(JSON.stringify(answer.body), { status: answer.status });
}) as typeof fetch;

await createFlow('login', { aal: 'aal2', return_to: '' });
check('a flow is created under /auth, empty parameters dropped', sent[0]?.url, '/auth/self-service/login/browser?aal=aal2');
check('as JSON, with the cookies', [new Headers(sent[0]?.init?.headers).get('accept'), sent[0]?.init?.credentials], ['application/json', 'include']);
await submitFlow(flow, { method: 'password' });
check('a submit goes to the flow\'s own action', [sent[1]?.url, sent[1]?.init?.method, sent[1]?.init?.body],
  [flow.ui.action, 'POST', '{"method":"password"}']);
answer = { status: 401, body: { error: { id: 'session_inactive' } } };
check('no session', (await whoami()).kind, 'none');
answer = { status: 403, body: { error: { id: 'session_aal2_required' }, redirect_browser_to: 'https://app.test/auth/self-service/login/browser?aal=aal2' } };
check('a second factor owed is a redirect', await whoami(),
  { kind: 'redirect', to: 'https://app.test/auth/self-service/login/browser?aal=aal2' });
sent.length = 0;
answer = { status: 200, body: { logout_token: 'lt', logout_url: 'x' } };
await logout();
check('logging out fetches a token, then spends it',
  sent.map((s) => s.url), ['/auth/self-service/logout/browser', '/auth/self-service/logout?token=lt']);

finish();
```

- [ ] **Step 2: Run, expect FAIL**

Run: `node test/route.ts`
Expected: `SyntaxError: … does not provide an export named 'parsePath'`.
Run: `node test/kratos.ts`
Expected: `ERR_MODULE_NOT_FOUND` for `../src/web/auth/kratos.ts`.

- [ ] **Step 3: Implement**

3a. `src/web/state/route.ts` (full contents):

```ts
/* state/route.ts — which screen, which tab and which month, kept in the path.

   `/bills/2026-07`, `/login`, `/settings/security`. Real paths rather than the
   hash the file:// build needed: Caddy answers every path with index.html
   (try_files), so a reload lands where you were and a month of a tab can be
   bookmarked. Back and forward arrive as popstate.

   Signals are written straight away rather than waiting for any event: a click
   must take effect in the same turn it happened. */

import { signal } from '@preact/signals';
import { currentPeriod } from '../../domain/period.ts';
import type { Period } from '../../domain/types.ts';

export type TabId = 'dashboard' | 'income' | 'bills' | 'purchases' | 'savings' | 'goals' | 'gold' | 'settings';

export const TAB_IDS: readonly TabId[] = [
  'dashboard', 'income', 'bills', 'purchases', 'savings', 'goals', 'gold', 'settings'
];

export type AuthRoute = 'login' | 'registration' | 'recovery' | 'verification' | 'settings/security' | 'error';

const AUTH_ROUTES: readonly AuthRoute[] = [
  'login', 'registration', 'recovery', 'verification', 'settings/security', 'error'
];

const isTab = (value: string): value is TabId => (TAB_IDS as readonly string[]).includes(value);
const isPeriod = (value: string): boolean => /^\d{4}-\d{2}$/.test(value);

export const tab = signal<TabId>('dashboard');
export const period = signal<Period>(currentPeriod());
/** Set while a sign-in screen is showing; null for the app itself. */
export const authRoute = signal<AuthRoute | null>(null);
/** The query string, which the sign-in screens read (?flow=…, ?aal=…). */
export const search = signal('');

export interface ParsedPath {
  auth: AuthRoute | null;
  tab: TabId | null;
  period: Period | null;
}

/** Auth screens first: /settings/security must not read as the Settings tab. */
export function parsePath(pathname: string): ParsedPath {
  const clean = pathname.replace(/^\/+|\/+$/g, '');
  if ((AUTH_ROUTES as readonly string[]).includes(clean)) {
    return { auth: clean as AuthRoute, tab: null, period: null };
  }
  const [rawTab = '', rawPeriod = ''] = clean.split('/');
  return {
    auth: null,
    tab: isTab(rawTab) ? rawTab : null,
    period: isTab(rawTab) && isPeriod(rawPeriod) ? rawPeriod : null
  };
}

export const pathFor = (t: TabId, p: Period): string => `/${t}/${p}`;

/** Unreadable parts keep whatever is on screen. */
function apply(pathname: string, query: string): void {
  const parsed = parsePath(pathname);
  authRoute.value = parsed.auth;
  search.value = query;
  if (parsed.tab) tab.value = parsed.tab;
  if (parsed.period) period.value = parsed.period;
}

export function go(next: { tab?: TabId; period?: Period }): void {
  if (next.tab) tab.value = next.tab;
  if (next.period) period.value = next.period;
  authRoute.value = null;
  search.value = '';
  const target = pathFor(tab.peek(), period.peek());
  if (globalThis.location?.pathname !== target || globalThis.location?.search) {
    history.pushState(null, '', target);
  }
}

export const goTab = (id: TabId): void => go({ tab: id });
export const goPeriod = (p: Period): void => go({ period: p });

/** Any address inside the app, including the sign-in screens. */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, location.origin);
  const target = url.pathname + url.search;
  if (options.replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  apply(url.pathname, url.search);
}

/** Called once at start-up. A bare / is written out as the tab and month it
    shows, so the first tab change is not the entry the back button returns to. */
export function startRouting(): void {
  apply(location.pathname, location.search);
  window.addEventListener('popstate', () => apply(location.pathname, location.search));
  if (!authRoute.peek()) {
    const target = pathFor(tab.peek(), period.peek());
    if (location.pathname !== target) history.replaceState(null, '', target);
  }
}
```

3b. `src/web/auth/kratos.ts`:

```ts
/* auth/kratos.ts — the browser's side of Ory Kratos.

   Everything goes through /auth on our own origin (Caddy strips the prefix and
   forwards to Kratos), so the session cookie is first-party and no CORS is
   involved. These are Kratos's *browser* flows answered as JSON: the CSRF token
   arrives as a hidden node in the flow and as a cookie, and both go back on
   submit.

   outcomeOf() is the whole protocol in one place: a flow (drawn again — with
   errors on a 400, with a success message on a settings 200), done (a login or
   registration that produced a session), a redirect (422, or a refresh or a
   second factor demanded), or start again (expired, CSRF). */

export const KRATOS = '/auth';

export type FlowKind = 'login' | 'registration' | 'recovery' | 'verification' | 'settings';

export interface UiText {
  id: number;
  text: string;
  type: 'info' | 'error' | 'success';
  context?: Record<string, unknown>;
}

export interface UiNodeAttributes {
  node_type: 'input' | 'img' | 'text' | 'a' | 'script';
  name?: string;
  type?: string;
  value?: unknown;
  required?: boolean;
  disabled?: boolean;
  autocomplete?: string;
  pattern?: string;
  id?: string;
  src?: string;
  width?: number;
  height?: number;
  text?: UiText;
  href?: string;
  title?: UiText;
}

export interface UiNode {
  type: 'input' | 'img' | 'text' | 'a' | 'script';
  group: string;
  attributes: UiNodeAttributes;
  messages: UiText[];
  meta: { label?: UiText };
}

export interface Flow {
  id: string;
  state?: string;
  requested_aal?: string;
  return_to?: string;
  ui: { action: string; method: string; nodes: UiNode[]; messages?: UiText[] };
}

export interface Session {
  id: string;
  active: boolean;
  identity: {
    id: string;
    traits: { email?: string; name?: string };
    verifiable_addresses?: { value: string; verified: boolean }[];
  };
}

export type Outcome =
  | { kind: 'flow'; flow: Flow }
  | { kind: 'done'; body: unknown }
  | { kind: 'redirect'; to: string }
  | { kind: 'restart'; reason: string };

export type WhoAmI = { kind: 'session'; session: Session } | { kind: 'none' } | { kind: 'redirect'; to: string };

interface KratosError {
  error?: { id?: string; message?: string; reason?: string };
  redirect_browser_to?: string;
}

async function send(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, { ...init, headers, credentials: 'include' });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* an error page from a proxy */ }
  return { status: res.status, body };
}

const isFlow = (body: unknown): body is Flow =>
  !!body && typeof body === 'object' && 'ui' in body && 'id' in body;

export function outcomeOf(status: number, body: unknown): Outcome {
  if (isFlow(body)) return { kind: 'flow', flow: body };
  const err = (body ?? {}) as KratosError;
  if (err.redirect_browser_to) return { kind: 'redirect', to: err.redirect_browser_to };
  if (err.error?.id === 'session_already_available') return { kind: 'redirect', to: '/' };
  if (status === 401) return { kind: 'redirect', to: '/login' };
  if (status >= 200 && status < 300) return { kind: 'done', body };
  return { kind: 'restart', reason: err.error?.message ?? err.error?.reason ?? `The sign-in service answered ${status}.` };
}

export async function createFlow(kind: FlowKind, params: Record<string, string> = {}): Promise<Outcome> {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
  const { status, body } = await send(`${KRATOS}/self-service/${kind}/browser${query ? `?${query}` : ''}`);
  return outcomeOf(status, body);
}

export async function getFlow(kind: FlowKind, id: string): Promise<Outcome> {
  const { status, body } = await send(`${KRATOS}/self-service/${kind}/flows?id=${encodeURIComponent(id)}`);
  return outcomeOf(status, body);
}

export async function submitFlow(flow: Flow, body: Record<string, unknown>): Promise<Outcome> {
  const answer = await send(flow.ui.action, { method: flow.ui.method.toUpperCase(), body: JSON.stringify(body) });
  return outcomeOf(answer.status, answer.body);
}

/* 403 here is a session that still owes its second factor: Kratos says where
   to go to give it. */
export async function whoami(): Promise<WhoAmI> {
  const { status, body } = await send(`${KRATOS}/sessions/whoami`);
  if (status === 200) return { kind: 'session', session: body as Session };
  if (status === 403) {
    return { kind: 'redirect', to: (body as KratosError | null)?.redirect_browser_to ?? '/login?aal=aal2' };
  }
  return { kind: 'none' };
}

export async function logout(): Promise<void> {
  const { status, body } = await send(`${KRATOS}/self-service/logout/browser`);
  const token = status === 200 ? (body as { logout_token?: string } | null)?.logout_token : undefined;
  if (token) await send(`${KRATOS}/self-service/logout?token=${encodeURIComponent(token)}`);
}

export async function errorMessage(id: string): Promise<string> {
  const { body } = await send(`${KRATOS}/self-service/errors?id=${encodeURIComponent(id)}`);
  return (body as KratosError | null)?.error?.message ?? 'Something went wrong while signing in.';
}

/* Kratos names fields with dots (traits.email) and reads JSON as nested
   objects, so the names are unfolded. The button that was pressed is part of
   the answer — it says which method — and keeps its value's real type: a
   `lookup_secret_reveal: true` sent as "true" would be refused. */
export function bodyFromForm(
  nodes: readonly UiNode[],
  entries: Iterable<[string, FormDataEntryValue]>,
  pressed: { name: string; value: string } | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (name: string, value: unknown): void => {
    const parts = name.split('.');
    let at = out;
    for (const part of parts.slice(0, -1)) {
      at = (at[part] ??= {}) as Record<string, unknown>;
    }
    at[parts[parts.length - 1]!] = value;
  };
  const checkboxes = new Set(nodes.filter((n) => n.attributes.type === 'checkbox').map((n) => n.attributes.name));
  for (const [name, value] of entries) {
    put(name, checkboxes.has(name) ? value === 'true' : typeof value === 'string' ? value : value.name);
  }
  if (pressed?.name) {
    const button = nodes.find((n) => n.attributes.name === pressed.name && String(n.attributes.value ?? '') === pressed.value);
    put(pressed.name, button ? button.attributes.value : pressed.value);
  }
  return out;
}
```

3c. `src/web/auth/session.ts`:

```ts
/* auth/session.ts — who is signed in, according to Kratos.

   `undefined` while the question is out, `null` when the answer is nobody.
   The api never decides this on its own: any 401 from it means the session has
   gone (expired, or ended in another tab), and the person is sent to sign in. */

import { signal } from '@preact/signals';
import { onUnauthorized } from '../state/api.ts';
import { resetApp } from '../state/boot.ts';
import { authRoute, navigate } from '../state/route.ts';
import { logout, whoami } from './kratos.ts';
import type { Session } from './kratos.ts';

export const session = signal<Session | null | undefined>(undefined);

export const emailOf = (s: Session | null | undefined): string => s?.identity.traits.email ?? '';

export const isVerified = (s: Session | null | undefined): boolean => {
  const email = emailOf(s);
  return (s?.identity.verifiable_addresses ?? []).some((a) => a.value === email && a.verified);
};

/* A session that still owes its second factor is sent to give it — but not
   from a sign-in screen, where the redirect would land right back here. */
export async function checkSession(options: { followRedirect?: boolean } = {}): Promise<Session | null> {
  const follow = options.followRedirect ?? authRoute.peek() === null;
  const answer = await whoami().catch((): { kind: 'none' } => ({ kind: 'none' }));
  if (answer.kind === 'redirect' && follow) {
    location.assign(answer.to);
    return null;
  }
  session.value = answer.kind === 'session' ? answer.session : null;
  return session.value;
}

export async function signOut(): Promise<void> {
  await logout();
  session.value = null;
  resetApp();
  navigate('/login');
}

onUnauthorized(() => {
  if (session.peek() === null) return;
  session.value = null;
  resetApp();
  navigate('/login');
});
```

3d. `src/web/auth/FlowForm.tsx`:

```tsx
/* auth/FlowForm.tsx — one renderer for every Kratos flow.

   Kratos describes each form as a list of nodes — inputs, the hidden CSRF
   token, buttons, the TOTP QR image, the secret beside it, backup codes — each
   with its own messages, and the form with messages of its own. Drawing them
   generically means a method switched on in kratos.yml shows up here without a
   line of screen code. Values go in as defaultValue, as in every form in this
   app (see ui/components/Form.tsx): a redraw must never eat what was typed. */

import { useState } from 'preact/hooks';
import { bodyFromForm, submitFlow } from './kratos.ts';
import type { Flow, Outcome, UiNode, UiText } from './kratos.ts';

export interface FlowFormProps {
  flow: Flow;
  /** The node groups to show; `default` (the CSRF token) always comes along. Omit for all. */
  groups?: readonly string[];
  onOutcome: (outcome: Outcome) => void;
}

function Messages({ list }: { list?: UiText[] }) {
  if (!list?.length) return null;
  return <>{list.map((m) => <p key={`${m.id}${m.text}`} class={`auth-message is-${m.type}`}>{m.text}</p>)}</>;
}

function Node({ node, busy }: { node: UiNode; busy: boolean }) {
  const a = node.attributes;
  const label = node.meta.label?.text;

  if (node.type === 'img') {
    return (
      <div class="auth-node" data-node-id={a.id}>
        <img src={a.src} width={a.width} height={a.height} alt={label ?? ''} />
      </div>
    );
  }
  if (node.type === 'text') {
    const secrets = (a.text?.context as { secrets?: { text: string }[] } | undefined)?.secrets;
    return (
      <div class="auth-node" data-node-id={a.id}>
        {label ? <span class="muted">{label}</span> : null}
        {secrets
          ? <ul class="auth-codes">{secrets.map((s) => <li key={s.text}><code>{s.text}</code></li>)}</ul>
          : <code class="auth-secret">{a.text?.text}</code>}
        <Messages list={node.messages} />
      </div>
    );
  }
  if (node.type === 'a') {
    return <p class="auth-node" data-node-id={a.id}><a href={a.href}>{a.title?.text ?? a.href}</a></p>;
  }
  if (node.type !== 'input') return null;

  if (a.type === 'hidden') return <input type="hidden" name={a.name} value={String(a.value ?? '')} />;
  if (a.type === 'submit' || a.type === 'button') {
    return (
      <button class="primary" type="submit" name={a.name} value={String(a.value ?? '')}
        disabled={busy || a.disabled} data-node-id={a.name}>
        {label ?? 'Continue'}
      </button>
    );
  }
  if (a.type === 'checkbox') {
    return (
      <label class="check auth-node" data-node-id={a.name}>
        <input type="checkbox" name={a.name} value="true" defaultChecked={a.value === true} disabled={a.disabled} />
        {label}
        <Messages list={node.messages} />
      </label>
    );
  }
  return (
    <label class="auth-field auth-node" data-node-id={a.name}>
      <span>{label ?? a.name}</span>
      <input
        name={a.name} type={a.type} required={a.required} disabled={a.disabled}
        autocomplete={a.autocomplete} pattern={a.pattern}
        defaultValue={a.value === undefined || a.value === null ? '' : String(a.value)}
      />
      <Messages list={node.messages} />
    </label>
  );
}

export function FlowForm({ flow, groups, onOutcome }: FlowFormProps) {
  const [busy, setBusy] = useState(false);
  const shown = flow.ui.nodes.filter((n) => !groups || n.group === 'default' || groups.includes(n.group));
  if (groups && !shown.some((n) => n.group !== 'default')) return null;

  return (
    <form
      class="auth-form" method="post" action={flow.ui.action}
      onSubmit={(e: Event) => {
        e.preventDefault();
        if (busy) return;
        const form = e.currentTarget as HTMLFormElement;
        const pressed = (e as SubmitEvent).submitter as HTMLButtonElement | null;
        const body = bodyFromForm(shown, new FormData(form), pressed ? { name: pressed.name, value: pressed.value } : null);
        setBusy(true);
        void submitFlow(flow, body)
          .then(onOutcome, () => onOutcome({ kind: 'restart', reason: 'Could not reach the sign-in service.' }))
          .finally(() => setBusy(false));
      }}
    >
      <Messages list={flow.ui.messages} />
      {shown.map((n, i) => (
        <Node key={`${n.attributes.name ?? n.attributes.id ?? ''}:${String(n.attributes.value ?? '')}:${i}`} node={n} busy={busy} />
      ))}
    </form>
  );
}
```

3e. `src/web/auth/screens.tsx`:

```tsx
/* auth/screens.tsx — sign in, sign up, recover, verify, security.

   Each is a thin wrapper around FlowForm: start (or resume, from ?flow=) the
   right Kratos flow, draw it, and decide what "done" means. The flow id is
   written into the address so a reload resumes the same flow rather than
   throwing away what Kratos already knows (a code just sent, a TOTP secret just
   shown). Visually these borrow the app's existing sheets; the redesign is
   phase 2. */

import { useEffect, useState } from 'preact/hooks';
import { go, navigate, search } from '../state/route.ts';
import type { AuthRoute } from '../state/route.ts';
import { Toast, toast } from '../ui/components/Toast.tsx';
import { FlowForm } from './FlowForm.tsx';
import { createFlow, errorMessage, getFlow } from './kratos.ts';
import type { Flow, FlowKind, Outcome } from './kratos.ts';
import { checkSession } from './session.ts';

const param = (name: string): string => new URLSearchParams(search.peek()).get(name) ?? '';

/** In-app addresses are routed; Kratos's own (/auth/…) need a real navigation. */
function follow(to: string): void {
  const url = new URL(to, location.origin);
  if (url.origin === location.origin && !url.pathname.startsWith('/auth/')) navigate(url.pathname + url.search);
  else location.assign(url.href);
}

function useFlow(kind: FlowKind, params: Record<string, string> = {}) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const start = async (resume: boolean): Promise<void> => {
    const id = resume ? param('flow') : '';
    const outcome = id ? await getFlow(kind, id) : await createFlow(kind, params);
    if (outcome.kind === 'flow') {
      setFlow(outcome.flow);
      history.replaceState(null, '', `${location.pathname}?flow=${encodeURIComponent(outcome.flow.id)}`);
    } else if (outcome.kind === 'redirect') {
      follow(outcome.to);
    } else if (outcome.kind === 'restart' && id) {
      await start(false);
    } else {
      setProblem(outcome.kind === 'restart' ? outcome.reason : 'The sign-in service gave an unexpected answer.');
    }
  };

  useEffect(() => {
    void start(true).catch(() => setProblem('Could not reach the sign-in service.'));
  }, []);

  /** Everything except "done" is handled the same way on every screen. */
  const handle = (outcome: Outcome, onDone: (body: unknown) => void): void => {
    if (outcome.kind === 'flow') setFlow(outcome.flow);
    else if (outcome.kind === 'redirect') follow(outcome.to);
    else if (outcome.kind === 'restart') { toast(outcome.reason); void start(false); }
    else onDone(outcome.body);
  };

  return { flow, setFlow, problem, handle };
}

function Link({ to, children }: { to: string; children: preact.ComponentChildren }) {
  return <a href={to} onClick={(e) => { e.preventDefault(); navigate(to); }}>{children}</a>;
}

function AuthShell({ title, children, links }: {
  title: string; children: preact.ComponentChildren; links?: preact.ComponentChildren;
}) {
  return (
    <main class="auth">
      <div class="sheet auth-card">
        <h1>{title}</h1>
        {children}
        {links ? <p class="auth-links">{links}</p> : null}
      </div>
      <Toast />
    </main>
  );
}

const Problem = ({ text }: { text: string | null }) =>
  text ? <p class="auth-message is-error">{text}</p> : null;

const Loading = () => <p class="muted">Loading…</p>;

/** After a flow ends in a session: into the app, or wherever we were sent from. */
async function enterApp(returnTo: string): Promise<void> {
  const signedIn = await checkSession({ followRedirect: true });
  if (!signedIn) return;
  if (returnTo) follow(returnTo);
  else go({});
}

export function Login() {
  const returnTo = param('return_to');
  const { flow, problem, handle } = useFlow('login', { aal: param('aal'), refresh: param('refresh'), return_to: returnTo });
  const second = flow?.requested_aal === 'aal2' || param('aal') === 'aal2';
  return (
    <AuthShell
      title={second ? 'Enter your authentication code' : 'Sign in'}
      links={<><Link to="/registration">Create an account</Link> · <Link to="/recovery">Forgot your password?</Link></>}
    >
      <Problem text={problem} />
      {flow ? <FlowForm flow={flow} onOutcome={(o) => handle(o, () => void enterApp(returnTo))} /> : <Loading />}
    </AuthShell>
  );
}

export function Registration() {
  const { flow, problem, handle } = useFlow('registration');
  return (
    <AuthShell title="Create your account" links={<>Already have one? <Link to="/login">Sign in</Link></>}>
      <Problem text={problem} />
      {flow ? <FlowForm flow={flow} onOutcome={(o) => handle(o, () => void enterApp(''))} /> : <Loading />}
    </AuthShell>
  );
}

/* A correct recovery code answers with a redirect to the security screen,
   signed in, to choose a new password — FlowForm's redirect handling covers it. */
export function Recovery() {
  const { flow, problem, handle } = useFlow('recovery');
  return (
    <AuthShell title="Recover your account" links={<Link to="/login">Back to sign in</Link>}>
      <Problem text={problem} />
      {flow ? <FlowForm flow={flow} onOutcome={(o) => handle(o, () => go({}))} /> : <Loading />}
    </AuthShell>
  );
}

export function Verification() {
  const { flow, problem, handle } = useFlow('verification');
  const passed = flow?.state === 'passed_challenge';
  useEffect(() => { if (passed) void checkSession({ followRedirect: false }); }, [passed]);
  return (
    <AuthShell title="Verify your email" links={<Link to="/">Back to the app</Link>}>
      <Problem text={problem} />
      {flow ? <FlowForm flow={flow} onOutcome={(o) => handle(o, () => go({}))} /> : <Loading />}
    </AuthShell>
  );
}

export function SecuritySettings() {
  const { flow, setFlow, problem, handle } = useFlow('settings');
  useEffect(() => { if (flow?.state === 'success') void checkSession({ followRedirect: false }); }, [flow?.state]);
  const section = (title: string, groups: readonly string[]) => flow ? (
    <section class="auth-section">
      <h2>{title}</h2>
      <FlowForm flow={flow} groups={groups} onOutcome={(o) => handle(o, () => setFlow(flow))} />
    </section>
  ) : null;
  return (
    <AuthShell title="Security" links={<Link to="/">Back to the app</Link>}>
      <Problem text={problem} />
      {flow ? null : <Loading />}
      {section('Password', ['password'])}
      {section('Authenticator app (2FA)', ['totp'])}
      {section('Backup codes', ['lookup_secret'])}
    </AuthShell>
  );
}

export function AuthError() {
  const [message, setMessage] = useState('Something went wrong while signing in.');
  useEffect(() => {
    const id = param('id');
    if (id) void errorMessage(id).then(setMessage).catch(() => {});
  }, []);
  return (
    <AuthShell title="Sign-in problem" links={<Link to="/login">Back to sign in</Link>}>
      <p class="auth-message is-error">{message}</p>
    </AuthShell>
  );
}

/** Keyed on the query string, so /login → /login?aal=aal2 starts a new flow. */
export function AuthScreen({ route }: { route: AuthRoute }) {
  const key = `${route}${search.value}`;
  switch (route) {
    case 'login': return <Login key={key} />;
    case 'registration': return <Registration key={key} />;
    case 'recovery': return <Recovery key={key} />;
    case 'verification': return <Verification key={key} />;
    case 'settings/security': return <SecuritySettings key={key} />;
    case 'error': return <AuthError key={key} />;
  }
}
```

3f. `src/web/ui/App.tsx`: replace the whole `App` function and its imports. Keep `TABS`, `Splash` and `OfflineNotice` as they are.

```tsx
/* ui/App.tsx — the whole page: the session gate, boot, frame, and whichever
   tab is on.

   Sign-in screens render on their own. Anything else needs a session: while
   Kratos is being asked there is a splash, with no session it is the login
   screen, and with one the state is loaded (once) and the tab is drawn. */

import { useEffect, useRef } from 'preact/hooks';
import { plural } from '../../domain/money.ts';
import { AuthScreen } from '../auth/screens.tsx';
import { emailOf, isVerified, session } from '../auth/session.ts';
import { app, bootError, booting, reachable } from '../state/app.ts';
import { boot } from '../state/boot.ts';
import type { BootOutcome } from '../state/boot.ts';
import { authRoute, navigate, tab as routeTab } from '../state/route.ts';
import type { TabId } from '../state/route.ts';
import { Toast, toast } from './components/Toast.tsx';
import { Topbar } from './Topbar.tsx';
```

(Keep the tab imports, `TABS`, `Splash` and `OfflineNotice` unchanged.) Then:

```tsx
function VerifyNotice() {
  const who = session.value;
  if (!who || isVerified(who)) return null;
  return (
    <div class="notice warn" style="margin-bottom:24px">
      <strong>Please verify your email. </strong>
      {`A code was sent to ${emailOf(who)}. `}
      <a href="/verification" onClick={(e) => { e.preventDefault(); navigate('/verification'); }}>Enter it here</a>.
    </div>
  );
}

export function App() {
  const auth = authRoute.value;
  const who = session.value;
  const tabId = routeTab.value;
  const announced = useRef<Promise<BootOutcome | null> | null>(null);

  /* Booted once per sign-in (boot() remembers), and announced once. A quiet
     catch-up that moved a balance is alarming when it is not explained. */
  useEffect(() => {
    if (!who || auth) return;
    const outcome = boot();
    if (announced.current === outcome) return;
    announced.current = outcome;
    void outcome.then((result) => {
      if (!result?.added.total) return;
      const parts: string[] = [];
      if (result.added.income) parts.push(plural(result.added.income, 'income entry', 'income entries'));
      if (result.added.bills) parts.push(plural(result.added.bills, 'bill'));
      toast(`Added ${parts.join(' and ')} from your recurring set-up`);
    });
  }, [who, auth]);

  useEffect(() => {
    if (who === null && !auth) navigate('/login', { replace: true });
  }, [who, auth]);

  useEffect(() => { window.scrollTo(0, 0); }, [tabId]);

  if (auth) return <AuthScreen route={auth} />;
  if (who === undefined) return <Splash title="Income Tracker" lines={['Checking your session…']} />;
  if (who === null) return null;
  if (bootError.value) {
    return <Splash title="Could not start" lines={[bootError.value, 'Reload the page to try again.']} />;
  }
  if (booting.value) return <Splash title="Income Tracker" lines={['Loading your data…']} />;

  // Read so the frame redraws with the data, not only with the route.
  app.value;

  const Tab = TABS[tabId];
  return (
    <>
      <Topbar />
      <main>
        <VerifyNotice />
        <OfflineNotice />
        <Tab key={tabId} />
      </main>
      <Toast />
    </>
  );
}
```

Delete the now-unused `import type { BootOutcome } from '../state/app.ts'` if it is still present. `reachable` stays imported; `OfflineNotice` uses it.

3g. `src/web/ui/Topbar.tsx`:
- Add `import { emailOf, session, signOut } from '../auth/session.ts';` and change the route import to `import { go, navigate, period as routePeriod, tab as routeTab } from '../state/route.ts';`.
- Replace `<button class="primary" onClick={() => setExporting(true)}>Export to Excel</button>` with:

```tsx
        <div class="account-menu">
          <button class="primary" onClick={() => setExporting(true)}>Export to Excel</button>
          <span class="muted" title="Signed in as">{emailOf(session.value)}</span>
          <button class="quiet" onClick={() => navigate('/settings/security')}>Security</button>
          <button class="quiet" onClick={() => void signOut()}>Log out</button>
        </div>
```

3h. `src/web/main.tsx`:
- Add `import { checkSession } from './auth/session.ts';`.
- Remove `import { boot } from './state/boot.ts';`.
- Replace `render(<App outcome={boot()} />, host);` with:

```tsx
  render(<App />, host);
  void checkSession();
```

3i. Append to `src/web/app.css`:

```css
/* ---- sign-in screens: plain, in the app's existing style (phase 2 redesigns) ---- */
.auth { max-width: 440px; margin: 64px auto; padding: 0 16px; }
.auth-card { padding: 24px; }
.auth-card h1 { margin: 0 0 16px; font-size: 1.4rem; }
.auth-section + .auth-section { margin-top: 24px; }
.auth-section h2 { font-size: 1.05rem; margin: 0 0 8px; }
.auth-form { display: grid; gap: 12px; margin-bottom: 8px; }
.auth-field { display: grid; gap: 4px; }
.auth-field input { width: 100%; }
.auth-message { margin: 0; font-size: .9rem; }
.auth-message.is-error { color: #b91c1c; }
.auth-message.is-success { color: #15803d; }
.auth-secret { display: block; font-size: 1rem; word-break: break-all; }
.auth-codes { columns: 2; margin: 4px 0; padding-left: 1.2em; }
.auth-links { margin: 16px 0 0; }
.account-menu { display: flex; gap: 8px; align-items: center; }
```

3j. Append ` && node test/route.ts && node test/kratos.ts` to the `"test"` script.

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test && pnpm build`
Expected: every suite ends with `all checks passed`, and the build succeeds. This task touches the auth wiring, so `test/web-state.ts` and `test/await-actions.ts` still pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add -A src/web test/route.ts test/kratos.ts package.json
git commit -m "feat(web): path routing, Kratos browser flows, auth screens and session gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The Compose stack: Postgres, Kratos, api, Caddy, Mailpit

**Files:**
- Create: `deploy/compose.yaml`, `deploy/compose.dev.yaml`, `deploy/.env.example`, `deploy/dev.env`, `deploy/kratos/kratos.yml`, `deploy/kratos/identity.schema.json`, `deploy/caddy/Caddyfile`, `deploy/caddy/Caddyfile.dev`, `deploy/caddy/routes.caddy`, `deploy/caddy/Dockerfile`, `server/Dockerfile`, `.dockerignore`
- Modify: `package.json` (stack scripts), `.gitignore`

**Interfaces:**
- Consumes: `server/main.ts` and its env (Task 10), `deploy/postgres/init.sh` (Task 4), `build.mjs` and `dist/web` (Task 2), and the web routes `/login`, `/registration`, `/recovery`, `/verification`, `/settings/security` and `/error` (Task 12).
- Produces: `pnpm stack:dev`, which serves the dev stack at `https://localhost` with Mailpit on `http://localhost:8025`, plus `pnpm stack:dev:down` and `pnpm stack:dev:logs`. The production command is `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d`.

This is infrastructure, so verification commands take the place of a unit test.

- [ ] **Step 1: Write the verification first**

Add these to `package.json` scripts. The verification below runs them.

```json
"stack:dev": "docker compose --env-file deploy/dev.env -f deploy/compose.yaml -f deploy/compose.dev.yaml --profile dev up -d --build",
"stack:dev:down": "docker compose --env-file deploy/dev.env -f deploy/compose.yaml -f deploy/compose.dev.yaml --profile dev down",
"stack:dev:logs": "docker compose --env-file deploy/dev.env -f deploy/compose.yaml -f deploy/compose.dev.yaml --profile dev logs -f",
```

- [ ] **Step 2: Run, expect FAIL**

Run: `docker compose --env-file deploy/dev.env -f deploy/compose.yaml -f deploy/compose.dev.yaml config --quiet`
Expected: `open …/deploy/dev.env: The system cannot find the file specified` (or `no such file`).

- [ ] **Step 3: Implement**

`deploy/compose.yaml`:

```yaml
# The whole app on one host. Caddy is the only thing listening publicly; it
# serves the web build and proxies /auth/* to Kratos (prefix stripped) and
# /api/* to the api, so everything is one origin and the Kratos session cookie
# is first-party. Kratos's admin port (4434) is never routed.
#
#   docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
name: income

x-kratos-env: &kratos-env
  DSN: postgres://kratos:${KRATOS_DB_PASSWORD:?set KRATOS_DB_PASSWORD in deploy/.env}@postgres:5432/kratos?sslmode=disable&max_conns=20&max_idle_conns=4

services:
  postgres:
    image: postgres:17.11-alpine
    restart: unless-stopped
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in deploy/.env}
      APP_DB_PASSWORD: ${APP_DB_PASSWORD:?set APP_DB_PASSWORD in deploy/.env}
      KRATOS_DB_PASSWORD: ${KRATOS_DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init.sh:/docker-entrypoint-initdb.d/10-init.sh:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres -d app"]
      interval: 5s
      timeout: 3s
      retries: 30

  kratos-migrate:
    image: oryd/kratos:v1.3.1
    command: migrate sql -e --yes
    environment: *kratos-env
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  kratos:
    image: oryd/kratos:v1.3.1
    command: serve -c /etc/config/kratos/kratos.yml --watch-courier
    restart: unless-stopped
    environment:
      <<: *kratos-env
      # Everything that depends on the domain or is secret is set here, over
      # the localhost defaults in kratos.yml. Arrays take an index suffix.
      SERVE_PUBLIC_BASE_URL: https://${APP_DOMAIN:?set APP_DOMAIN in deploy/.env}/auth/
      SELFSERVICE_DEFAULT_BROWSER_RETURN_URL: https://${APP_DOMAIN}/
      SELFSERVICE_ALLOWED_RETURN_URLS_0: https://${APP_DOMAIN}/
      SELFSERVICE_FLOWS_ERROR_UI_URL: https://${APP_DOMAIN}/error
      SELFSERVICE_FLOWS_LOGIN_UI_URL: https://${APP_DOMAIN}/login
      SELFSERVICE_FLOWS_REGISTRATION_UI_URL: https://${APP_DOMAIN}/registration
      SELFSERVICE_FLOWS_RECOVERY_UI_URL: https://${APP_DOMAIN}/recovery
      SELFSERVICE_FLOWS_VERIFICATION_UI_URL: https://${APP_DOMAIN}/verification
      SELFSERVICE_FLOWS_VERIFICATION_AFTER_DEFAULT_BROWSER_RETURN_URL: https://${APP_DOMAIN}/
      SELFSERVICE_FLOWS_SETTINGS_UI_URL: https://${APP_DOMAIN}/settings/security
      SELFSERVICE_FLOWS_LOGOUT_AFTER_DEFAULT_BROWSER_RETURN_URL: https://${APP_DOMAIN}/login
      SECRETS_COOKIE_0: ${KRATOS_COOKIE_SECRET:?set KRATOS_COOKIE_SECRET in deploy/.env}
      SECRETS_CIPHER_0: ${KRATOS_CIPHER_SECRET:?set KRATOS_CIPHER_SECRET (exactly 32 characters) in deploy/.env}
      COURIER_SMTP_CONNECTION_URI: ${SMTP_URI:?set SMTP_URI in deploy/.env}
      COURIER_SMTP_FROM_ADDRESS: ${SMTP_FROM:?set SMTP_FROM in deploy/.env}
      COURIER_SMTP_FROM_NAME: Income Tracker
    volumes:
      - ./kratos:/etc/config/kratos:ro
    depends_on:
      kratos-migrate:
        condition: service_completed_successfully

  api:
    build:
      context: ..
      dockerfile: server/Dockerfile
    restart: unless-stopped
    environment:
      APP_DOMAIN: ${APP_DOMAIN}
      DATABASE_URL: postgres://app:${APP_DB_PASSWORD}@postgres:5432/app
      MIGRATION_DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/app
      KRATOS_PUBLIC_URL: http://kratos:4433
      # The recurring catch-up decides "this month" by this clock.
      TZ: ${TZ:-Africa/Cairo}
    depends_on:
      postgres:
        condition: service_healthy
      kratos:
        condition: service_started
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/healthz || exit 1"]
      interval: 10s
      timeout: 3s
      retries: 10

  caddy:
    build:
      context: ..
      dockerfile: deploy/caddy/Dockerfile
    restart: unless-stopped
    environment:
      APP_DOMAIN: ${APP_DOMAIN}
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api
      - kratos

  # Catches every email Kratos sends, in development only: --profile dev.
  mailpit:
    image: axllent/mailpit:v1.32.0
    profiles: ["dev"]
    ports:
      - "127.0.0.1:8025:8025"

volumes:
  pgdata:
  caddy_data:
  caddy_config:
```

`deploy/compose.dev.yaml`:

```yaml
# Development overrides: https://localhost with Caddy's own CA, the web build
# mounted from dist/web (pnpm dev keeps it fresh), and the api restarting on
# change. Mail goes to Mailpit (http://localhost:8025).
#
#   pnpm stack:dev      (uses deploy/dev.env and --profile dev)
services:
  api:
    command: ["node", "--watch", "server/main.ts"]
    volumes:
      - ../server:/app/server:ro
      - ../src/domain:/app/src/domain:ro
      - ../src/wire.ts:/app/src/wire.ts:ro

  caddy:
    command: ["caddy", "run", "--config", "/etc/caddy/Caddyfile.dev", "--adapter", "caddyfile"]
    volumes:
      - ../dist/web:/srv:ro

  kratos:
    depends_on:
      mailpit:
        condition: service_started
```

`deploy/dev.env`. These are throwaway values for the local stack only, and they are committed on purpose:

```
# Development only — never use these anywhere reachable. Production values go
# in deploy/.env (see deploy/.env.example), which is not committed.
APP_DOMAIN=localhost
POSTGRES_PASSWORD=dev-postgres
APP_DB_PASSWORD=dev-app
KRATOS_DB_PASSWORD=dev-kratos
KRATOS_COOKIE_SECRET=dev-cookie-secret-not-for-production-0000
KRATOS_CIPHER_SECRET=dev-cipher-secret-32-characters!
SMTP_URI=smtp://mailpit:1025/?disable_starttls=true
SMTP_FROM=no-reply@localhost
TZ=Africa/Cairo
```

`deploy/.env.example`:

```
# Copy to deploy/.env and fill in every value. deploy/.env is never committed.
#
# Secrets:  openssl rand -hex 32   (the cipher secret: openssl rand -hex 16,
#                                   which is exactly the 32 characters Kratos needs)

# The domain whose DNS A record points at this server. No scheme, no slash.
APP_DOMAIN=money.example.com

POSTGRES_PASSWORD=
APP_DB_PASSWORD=
KRATOS_DB_PASSWORD=
KRATOS_COOKIE_SECRET=
KRATOS_CIPHER_SECRET=

# Where Kratos sends verification and recovery codes.
# smtps:// for implicit TLS (465), smtp:// for STARTTLS (587).
SMTP_URI=smtps://user:password@smtp.example.com:465/
SMTP_FROM=no-reply@money.example.com

# The clock the recurring catch-up uses to decide what "this month" is.
TZ=Africa/Cairo
```

`deploy/kratos/kratos.yml`:

```yaml
# Ory Kratos v1.3.1. Values tied to the domain, and every secret, come from the
# environment in deploy/compose.yaml; the URLs below are the localhost defaults
# they override.
version: v1.3.1

serve:
  public:
    # Reached through Caddy at /auth (prefix stripped). Same origin as the app,
    # so CORS stays off.
    base_url: https://localhost/auth/
    cors:
      enabled: false
  admin:
    base_url: http://kratos:4434/

selfservice:
  default_browser_return_url: https://localhost/
  allowed_return_urls:
    - https://localhost/

  methods:
    password:
      enabled: true
    totp:
      enabled: true
      config:
        issuer: Income Tracker
    lookup_secret:
      enabled: true
    code:
      enabled: true
      passwordless_enabled: false
      mfa_enabled: false
    link:
      enabled: false

  flows:
    error:
      ui_url: https://localhost/error
    login:
      ui_url: https://localhost/login
      lifespan: 10m
      style: unified
    registration:
      ui_url: https://localhost/registration
      lifespan: 10m
      # One form: email and password together. Password is the only sign-up method.
      enable_legacy_one_step: true
      after:
        password:
          hooks:
            - hook: session
    verification:
      enabled: true
      use: code
      ui_url: https://localhost/verification
      after:
        default_browser_return_url: https://localhost/
    recovery:
      enabled: true
      use: code
      ui_url: https://localhost/recovery
    settings:
      ui_url: https://localhost/settings/security
      privileged_session_max_age: 15m
      required_aal: highest_available
    logout:
      after:
        default_browser_return_url: https://localhost/login

session:
  lifespan: 720h
  cookie:
    same_site: Lax
    persistent: true
    path: /
  whoami:
    # Someone who has enabled TOTP is not signed in until they have used it.
    required_aal: highest_available

cookies:
  same_site: Lax
  path: /

ciphers:
  algorithm: xchacha20-poly1305

hashers:
  algorithm: bcrypt
  bcrypt:
    cost: 12

identity:
  default_schema_id: default
  schemas:
    - id: default
      url: file:///etc/config/kratos/identity.schema.json

courier:
  smtp:
    connection_uri: smtp://mailpit:1025/?disable_starttls=true
    from_address: no-reply@localhost

log:
  level: info
  format: json
  leak_sensitive_values: false
```

`deploy/kratos/identity.schema.json`:

```json
{
  "$id": "https://income-tracker.local/identity.schema.json",
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Person",
  "type": "object",
  "properties": {
    "traits": {
      "type": "object",
      "properties": {
        "email": {
          "type": "string",
          "format": "email",
          "title": "Email",
          "minLength": 3,
          "maxLength": 320,
          "ory.sh/kratos": {
            "credentials": {
              "password": { "identifier": true },
              "totp": { "account_name": true }
            },
            "verification": { "via": "email" },
            "recovery": { "via": "email" }
          }
        },
        "name": {
          "type": "string",
          "title": "Name",
          "maxLength": 100
        }
      },
      "required": ["email"],
      "additionalProperties": false
    }
  }
}
```

`deploy/caddy/routes.caddy`:

```
# Shared by Caddyfile (production) and Caddyfile.dev.
encode zstd gzip

# Kratos's public API, under our own origin. handle_path strips /auth.
handle_path /auth/* {
	reverse_proxy kratos:4433
}

handle /api/* {
	reverse_proxy api:3000
}

# The web build. Hashed assets are immutable; every other path is the app
# (path routing), so it falls back to index.html, which is always revalidated.
handle {
	root * /srv
	@assets path /assets/*
	header @assets Cache-Control "public, max-age=31536000, immutable"
	@pages not path /assets/*
	header @pages Cache-Control "no-cache"
	try_files {path} /index.html
	file_server
}
```

`deploy/caddy/Caddyfile`:

```
# Production: automatic HTTPS from Let's Encrypt for $APP_DOMAIN.
{$APP_DOMAIN} {
	import /etc/caddy/routes.caddy
}
```

`deploy/caddy/Caddyfile.dev`:

```
# Development: Caddy's own local CA instead of Let's Encrypt.
{$APP_DOMAIN} {
	tls internal
	import /etc/caddy/routes.caddy
}
```

`deploy/caddy/Dockerfile`:

```dockerfile
# Built from the repository root (compose: context ..).
# Stage 1 builds the web bundle; stage 2 is Caddy serving it.
FROM node:26.13.0-alpine AS web
WORKDIR /src
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY build.mjs ./
COPY src ./src
RUN node build.mjs

FROM caddy:2.11.7-alpine
COPY deploy/caddy/Caddyfile deploy/caddy/Caddyfile.dev deploy/caddy/routes.caddy /etc/caddy/
COPY --from=web /src/dist/web /srv
```

`server/Dockerfile`:

```dockerfile
# The api. Built from the repository root (compose: context ..), because it
# imports src/domain directly — Node 26 runs the TypeScript as it is.
FROM node:26.13.0-alpine
WORKDIR /app
RUN npm install -g pnpm@11.9.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY server ./server
COPY src/domain ./src/domain
COPY src/wire.ts ./src/wire.ts
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "server/main.ts"]
```

`.dockerignore`:

```
node_modules
dist
.tmp
.git
.playwright-mcp
docs
deploy/.env
deploy/dev.env
```

Append to `.gitignore`:

```
# Production secrets: copy deploy/.env.example
deploy/.env
```

- [ ] **Step 4: Run, expect PASS**

Start Docker Desktop first. Then run, in Git Bash from the repo root:

```bash
docker version --format '{{.Server.Version}}'
docker compose --env-file deploy/dev.env -f deploy/compose.yaml -f deploy/compose.dev.yaml --profile dev config --quiet && echo dev-config-ok
docker compose --env-file deploy/dev.env -f deploy/compose.yaml config --quiet && echo prod-config-ok
pnpm build
pnpm stack:dev
until curl -skf https://localhost/auth/health/ready >/dev/null; do sleep 2; done
curl -sk https://localhost/auth/health/ready; echo
curl -sk -o /dev/null -w 'api/me without a session: %{http_code}\n' https://localhost/api/me
curl -sk https://localhost/dashboard/2026-07 | grep -c '<div id="app"></div>'
curl -sk -H 'Accept: application/json' https://localhost/auth/self-service/registration/browser | grep -o '"action":"[^"]*"'
curl -sk -o /dev/null -w 'admin api through caddy: %{http_code}\n' https://localhost/auth/admin/identities
curl -s -o /dev/null -w 'mailpit: %{http_code}\n' http://localhost:8025/
docker compose --env-file deploy/dev.env -f deploy/compose.yaml exec -T postgres psql -U postgres -d app -c '\dt' | grep -c 'gold_prices'
docker compose --env-file deploy/dev.env -f deploy/compose.yaml logs kratos | grep -ci 'secret' || true
```

Expected, in order:
- a version number
- `dev-config-ok`
- `prod-config-ok`
- the build output
- containers created
- `{"status":"ok"}`
- `api/me without a session: 401`
- `1`, from the SPA fallback
- `"action":"https://localhost/auth/self-service/registration?flow=…"`
- `admin api through caddy: 404`
- `mailpit: 200`
- `1`, the migrations having run at api start
- no warning about default or missing secrets in the Kratos log

If Kratos complains that the cipher secret is missing, the indexed env override (`SECRETS_CIPHER_0`) did not apply. Put `secrets: { cookie: […], cipher: […] }` in a `kratos.yml` that is generated at deploy time. See Risks.

- [ ] **Step 5: Commit**

```bash
git add deploy .dockerignore .gitignore server/Dockerfile package.json
git commit -m "feat(deploy): compose stack with postgres, kratos, api, caddy and mailpit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The browser suite against the dev stack

**Files:**
- Modify: `test/browser.mjs`, `package.json` (`test:browser`, `test:full`)

**Interfaces:**
- Consumes:
  - `__app` (Task 11): `state`, `accountBalance`, `upsert`, `clearAll`, `reload`, `idle`, `buildWorkbook`, `goTab`, `goPeriod`
  - the FlowForm DOM contract (Task 12)
  - `fixtureBackup` (Task 6)
  - Mailpit's `GET /api/v1/messages` and `GET /api/v1/message/{ID}`
  - the dev stack (Task 13)

- [ ] **Step 1: Rewrite the suite**

Edit `test/browser.mjs` as follows. Every section not named here stays as it is. That covers adding records through the forms, the date field, the half-typed form, the inline bill edit, the calendar in a dialog, the Goals tab, buying a goal, the overspend banners, borrowing and paying back, and reconciling.

1. Replace everything from the top of the file down to and including the `/* ---------------- boot ---------------- */` block (through `check('every tab renders', …)`) with:

```js
/* Browser test: drives the app in a real browser against the dev stack —
   https://localhost, with Kratos, the api and Postgres behind Caddy.

   This is the half Node cannot reach: the real forms, the DOM, the Blob path,
   the sign-in screens and the session cookie. It signs a fresh person up
   through the UI, runs the offline build's regression checks against the
   server, imports a backup and compares the figures with the domain's own
   arithmetic, and ends with email verification, recovery, two-factor sign-in
   and logging out.

   Run:  pnpm stack:dev && pnpm test:browser
   Set CHROME_PATH to pick a browser, APP_URL / MAILPIT_URL to aim elsewhere. */
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importJSON } from '../src/domain/backup.ts';
import { formatMoney } from '../src/domain/money.ts';
import { accountBalance, summary } from '../src/domain/selectors.ts';
import { fixtureBackup } from './support/fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BASE = process.env.APP_URL ?? 'https://localhost';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const COMPOSE = ['compose', '--env-file', 'deploy/dev.env', '-f', 'deploy/compose.yaml', '-f', 'deploy/compose.dev.yaml'];
const email = `browser-${Date.now()}@example.test`;
const firstPassword = `First-${Date.now()}-correct-horse`;
const secondPassword = `Second-${Date.now()}-battery-staple`;

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.log('No Chrome or Edge found — skipping the browser suite.');
  console.log('Set CHROME_PATH to run it.');
  process.exit(0);
}

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  } else console.log(`  ok   ${label}`);
};

/** SQL straight into the dev database — only for the shared gold prices, which no user can write. */
const psql = (sql) => execFileSync('docker', [...COMPOSE, 'exec', '-T', 'postgres',
  'psql', '-U', 'postgres', '-d', 'app', '-v', 'ON_ERROR_STOP=1', '-c', sql], { cwd: root, stdio: 'pipe' });

/** Ids of every message Mailpit holds, so a new one can be told apart. */
const mailIds = async () => new Set(((await (await fetch(`${MAILPIT}/api/v1/messages`)).json()).messages ?? [])
  .map((m) => m.ID));

/** The six-digit code in the first new message to `to`. */
async function mailedCode(to, seen) {
  for (let i = 0; i < 60; i++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()).messages ?? [];
    const hit = list.find((m) => !seen.has(m.ID) && m.To?.some((t) => t.Address === to));
    if (hit) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
      const code = /\b(\d{6})\b/.exec(full.Text ?? '')?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no code was mailed to ${to}`);
}

/** RFC 6238 TOTP, as an authenticator app computes it. */
function totp(secret, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/\s|=+$/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/** A code different from the last one used, waiting out the 30 s window if need be. */
async function freshTotp(secret, used) {
  while (totp(secret) === used) await new Promise((r) => setTimeout(r, 1000));
  return totp(secret);
}

const browser = await puppeteer.launch({ executablePath, headless: true, acceptInsecureCerts: true });

try {
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', (e) => errors.push(String(e)));
  /* The sign-in protocol answers 401 (no session yet), 403 (second factor
     owed) and 422 (go elsewhere) as a matter of course, and Chrome logs every
     non-2xx response as a console error. Those are the protocol working, not
     the app failing; anything else still counts. */
  const EXPECTED_STATUS = /Failed to load resource: the server responded with a status of (401|403|422)/;
  tab.on('console', (m) => { if (m.type() === 'error' && !EXPECTED_STATUS.test(m.text())) errors.push(m.text()); });
  tab.on('dialog', (d) => void d.accept());

  /** Every write answered, then one more frame for the redraw. */
  const settle = () => tab.evaluate(() => globalThis.__app.idle().then(() => new Promise((r) => setTimeout(r, 150))));

  const open = async () => {
    await tab.goto(`${BASE}/`, { waitUntil: 'load' });
    await tab.waitForSelector('.topbar', { timeout: 30000 });
    await settle();
  };

  const clickButton = (text, scope = 'body') => tab.evaluate((t, s) =>
    [...document.querySelector(s).querySelectorAll('button')].find((b) => b.textContent === t).click(), text, scope);

  const logOut = async () => {
    await open();
    await clickButton('Log out', '.account-menu');
    await tab.waitForSelector('input[name="identifier"]', { timeout: 15000 });
  };

  const submitPassword = async (password) => {
    await tab.type('input[name="identifier"]', email);
    await tab.type('input[name="password"]', password);
    await tab.click('button[name="method"][value="password"]');
  };

  /* ---------------- signing up ---------------- */
  console.log('signing up through the real form:');
  await tab.goto(`${BASE}/registration`, { waitUntil: 'load' });
  await tab.waitForSelector('input[name="traits.email"]', { timeout: 30000 });
  await tab.type('input[name="traits.email"]', email);
  await tab.type('input[name="password"]', firstPassword);
  await tab.click('button[name="method"][value="password"]');
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  await settle();
  check('a new account lands in the app', new URL(tab.url()).pathname.startsWith('/dashboard/'), true);
  check('the topbar says who is signed in',
    await tab.evaluate((e) => document.querySelector('.account-menu').textContent.includes(e), email), true);
  check('and they are asked to verify their email',
    await tab.evaluate(() => !!document.querySelector('.notice.warn')), true);

  /* ---------------- boot ---------------- */
  console.log('\nboot:');
  check('the build stamp is on the page',
    await tab.evaluate(() => !!document.querySelector('.brand span')?.textContent), true);
  check('every tab renders',
    await tab.evaluate(() => document.querySelectorAll('.tab').length), 8);
```

2. Replace the `/* ---------------- hash routing ---------------- */` block, from its comment down to and including `check('and forward returns', tab.url(), stepped);`, with:

```js
  /* ---------------- path routing ---------------- */
  console.log('\npath routing (reload and back/forward):');
  const selectedTab = () => tab.evaluate(() =>
    [...document.querySelectorAll('.tab')].find((b) => b.getAttribute('aria-selected') === 'true')?.textContent);

  await tab.evaluate(() => globalThis.__app.goTab('gold'));
  await settle();
  check('the tab is in the address bar', /\/gold\/\d{4}-\d{2}$/.test(tab.url()), true);

  await tab.evaluate(() => [...document.querySelectorAll('.period-nav button')]
    .find((b) => b.getAttribute('aria-label') === 'Previous month').click());
  await settle();
  const stepped = tab.url();
  check('and so is the month', /\/gold\/\d{4}-\d{2}$/.test(stepped), true);

  await tab.reload({ waitUntil: 'load' });
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  check('a reload lands on the same tab', await selectedTab(), 'Gold');
  check('in the same month', tab.url(), stepped);

  await tab.goBack({ waitUntil: 'load' });
  await settle();
  check('back steps to the month before it', tab.url() !== stepped, true);
  await tab.goForward({ waitUntil: 'load' });
  await settle();
  check('and forward returns', tab.url(), stepped);

  await tab.goto(`${BASE}/bills/2026-07`, { waitUntil: 'load' });
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  check('a deep link opens on its own tab', await selectedTab(), 'Bills');
```

3. Replace `console.log('\npersistence (SQLite -> IndexedDB -> reload):');` with `console.log('\npersistence (server -> reload):');`, and `check('open() really reloaded the page, hash routing notwithstanding',` with `check('open() really reloaded the page',`.

4. Replace every `await tab.evaluate(() => new Promise((r) => setTimeout(r, 300)));` and every `await tab.evaluate(() => new Promise((r) => setTimeout(r, 200)));` with `await settle();`. Delete the old `const settle = …` line in the hash-routing block, because step 2 replaced that block and `settle` is now defined at the top.

5. In the "every tab draws with data in it" block, replace the `tab.evaluate(() => { const a = globalThis.__app; a.upsert('savingsTx', …); … })` call with:

```js
  await tab.evaluate(async () => {
    const a = globalThis.__app;
    await a.upsert('savingsTx', { id: 'sav_t', date: '2026-07-07', accountId: 'acc_t', fromAccountId: '', direction: 'in', amount: 50000, notes: '' });
    await a.upsert('gold', { id: 'gld_t', date: '2026-07-10', direction: 'buy', karat: 21, grams: 8, pricePerGram: 90000, amount: 720000, accountId: 'acc_t', dealer: 'Souq', notes: '' });
  });
  /* Gold prices are shared and written only by the server's daily job, so the
     two the sparkline needs go straight into the database. */
  psql(`INSERT INTO gold_prices (date, usd_per_oz, egp_per_usd, egp_per_gram24, source, fetched_at) VALUES
    ('2026-07-29', 3110.34768, 10, 100000, 'browser-test', ''),
    ('2026-07-30', 3200, 10, 102890, 'browser-test', '') ON CONFLICT (date) DO NOTHING`);
  await tab.evaluate(() => globalThis.__app.reload());
```

6. Delete the `/* ---------------- the browser-only export path ---------------- */` block's second half, from `const db = await tab.evaluate(() => {` through `check('the .db download is a real SQLite file', db, 'SQLite format 3');`. Keep the `.xlsx` checks above it. Delete the whole `/* ---------------- the read-only SQL console ---------------- */` block, from its comment through `check('the delete really did not happen', …);`.

7. Make the two goals `upsert`s and the two template deactivations awaited:

```js
  await tab.evaluate(async () => {
    const a = globalThis.__app;
    await a.upsert('goals', { id: 'gol_1', name: 'First', price: 100000, priority: 1, boughtDate: '', notes: '' });
    await a.upsert('goals', { id: 'gol_2', name: 'Second', price: 200000, priority: 2, boughtDate: '', notes: '' });
  });
```

```js
  await tab.evaluate(async () => {
    await globalThis.__app.upsert('incomeTemplates', { id: 'itp_t', active: false });
    await globalThis.__app.upsert('billTemplates', { id: 'bit_lump', active: false });
  });
```

8. Rename labels: `console.log('\ngoals survive the SQLite round-trip:');` becomes `console.log('\ngoals survive a reload from Postgres:');`, and `check('a debt comes back out of SQLite as a debt',` becomes `check('a debt comes back out of Postgres as a debt',`.

9. Replace the `/* ---------------- leave nothing behind ---------------- */` block, through `check('no uncaught errors or console errors', errors, []);`, with:

```js
  /* ---------------- importing an offline backup ---------------- */
  console.log('\nimporting a v1-offline backup shows the same figures:');
  const backupText = fixtureBackup();
  const expected = importJSON(backupText).state;
  const fixtureFile = join(root, '.tmp', 'fixture-backup.json');
  mkdirSync(dirname(fixtureFile), { recursive: true });
  writeFileSync(fixtureFile, backupText);
  await tab.evaluate(() => globalThis.__app.goTab('settings'));
  await settle();
  const restoreInput = await tab.$('input[type="file"]');
  await restoreInput.uploadFile(fixtureFile);
  await tab.waitForFunction((n) => globalThis.__app.state().income.length === n, { timeout: 15000 }, expected.income.length);
  await settle();
  const counts = (s) => [s.income, s.bills, s.purchases, s.accounts, s.goals, s.savingsTx, s.gold, s.incomeTemplates, s.billTemplates]
    .map((list) => list.length);
  check('every collection arrived whole', counts(await tab.evaluate(() => globalThis.__app.state())), counts(expected));
  for (const account of expected.accounts) {
    check(`${account.name} has the same balance`,
      await tab.evaluate((id) => globalThis.__app.accountBalance(id), account.id), accountBalance(expected, account.id));
  }
  for (const p of ['2026-05', '2026-06', '2026-07']) {
    await tab.evaluate((period) => { globalThis.__app.goTab('dashboard'); globalThis.__app.goPeriod(period); }, p);
    await settle();
    const shown = await tab.evaluate(() => Object.fromEntries([...document.querySelectorAll('.figure')]
      .map((f) => [f.querySelector('.label')?.textContent, f.querySelector('.figure-value')?.textContent])));
    const s = summary(expected, p);
    const money = (cents) => formatMoney(cents, expected.settings);
    check(`the dashboard for ${p} shows the same figures`,
      [shown['Income'], shown['Spent'], shown['Net'], shown['Saved']],
      [money(s.income), money(s.spent), money(s.net), money(s.savedNet)]);
  }

  /* ---------------- verifying the email address ---------------- */
  console.log('\nverifying the email address:');
  let seen = await mailIds();
  await tab.goto(`${BASE}/verification`, { waitUntil: 'load' });
  await tab.waitForSelector('input[name="email"]', { timeout: 15000 });
  await tab.type('input[name="email"]', email);
  await tab.click('button[name="method"][value="code"]');
  const verifyCode = await mailedCode(email, seen);
  await tab.waitForSelector('input[name="code"]', { timeout: 15000 });
  await tab.type('input[name="code"]', verifyCode);
  await tab.click('button[name="method"][value="code"]');
  await tab.waitForSelector('.auth-message.is-success', { timeout: 15000 });
  await open();
  check('the verify notice is gone', await tab.evaluate(() => !!document.querySelector('.notice.warn')), false);

  /* ---------------- recovering a forgotten password ---------------- */
  console.log('\nrecovering a forgotten password:');
  await logOut();
  check('logging out lands on sign-in', new URL(tab.url()).pathname, '/login');
  check('and the api no longer answers', await tab.evaluate(async () => (await fetch('/api/me')).status), 401);
  seen = await mailIds();
  await tab.goto(`${BASE}/recovery`, { waitUntil: 'load' });
  await tab.waitForSelector('input[name="email"]', { timeout: 15000 });
  await tab.type('input[name="email"]', email);
  await tab.click('button[name="method"][value="code"]');
  const recoveryCode = await mailedCode(email, seen);
  await tab.waitForSelector('input[name="code"]', { timeout: 15000 });
  await tab.type('input[name="code"]', recoveryCode);
  await tab.click('button[name="method"][value="code"]');
  await tab.waitForSelector('[data-node-id="password"] input', { timeout: 15000 });
  check('a correct code opens the security screen', new URL(tab.url()).pathname, '/settings/security');
  await tab.type('[data-node-id="password"] input', secondPassword);
  await tab.click('button[name="method"][value="password"]');
  await tab.waitForSelector('.auth-message.is-success', { timeout: 15000 });
  await logOut();
  await submitPassword(secondPassword);
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  check('the new password signs in', !!(await tab.$('.topbar')), true);

  /* ---------------- two-factor sign-in ---------------- */
  console.log('\ntwo-factor sign-in:');
  await tab.goto(`${BASE}/settings/security`, { waitUntil: 'load' });
  await tab.waitForSelector('[data-node-id="totp_secret_key"] code', { timeout: 15000 });
  check('a QR code is shown to scan', await tab.evaluate(() => !!document.querySelector('[data-node-id="totp_qr"] img')), true);
  const secret = await tab.$eval('[data-node-id="totp_secret_key"] code', (el) => el.textContent.trim());
  const enrolCode = totp(secret);
  await tab.type('input[name="totp_code"]', enrolCode);
  await tab.click('button[name="method"][value="totp"]');
  await tab.waitForSelector('button[name="totp_unlink"]', { timeout: 15000 });
  check('the authenticator is enrolled', !!(await tab.$('button[name="totp_unlink"]')), true);
  await logOut();
  await submitPassword(secondPassword);
  await tab.waitForSelector('input[name="totp_code"]', { timeout: 30000 });
  check('a password alone is no longer enough', new URL(tab.url()).pathname, '/login');
  await tab.type('input[name="totp_code"]', await freshTotp(secret, enrolCode));
  await tab.click('button[name="method"][value="totp"]');
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  await settle();
  // Accounts, not income: signing in boots, and boot's catch-up has since
  // filled in the months after the fixture's July.
  check('the code lets them in, to their own data',
    (await tab.evaluate(() => globalThis.__app.state().accounts.map((a) => a.id))).sort(),
    expected.accounts.map((a) => a.id).sort());

  /* ---------------- leave nothing behind ---------------- */
  await tab.evaluate(() => globalThis.__app.clearAll());
  await settle();
  psql(`DELETE FROM gold_prices WHERE source = 'browser-test'`);

  console.log('\nconsole:');
  check('no uncaught errors or console errors', errors, []);
```

In `package.json`, set `"test:browser": "pnpm build && node test/browser.mjs"` (unchanged) and `"test:full": "pnpm test && pnpm test:db && pnpm test:browser"`.

- [ ] **Step 2: Run it with the stack down, expect FAIL**

```bash
pnpm stack:dev:down
node test/browser.mjs
```

Expected: `net::ERR_CONNECTION_REFUSED at https://localhost/registration`. This shows the suite now targets the stack and no longer `file://`.

- [ ] **Step 3: Bring the stack up**

```bash
pnpm build
pnpm stack:dev
until curl -skf https://localhost/auth/health/ready >/dev/null; do sleep 2; done
```

- [ ] **Step 4: Run, expect PASS**

Run: `node test/browser.mjs`
Expected: `all checks passed`. If a check fails, fix the app, not the expectation. The figures come from the same domain code the offline build used.

- [ ] **Step 5: Commit**

```bash
git add test/browser.mjs package.json
git commit -m "test(browser): run the regression suite against the dev stack, plus sign-up, import, recovery and 2FA

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Deployment runbook and README

**Files:**
- Create: `deploy/README.md`
- Modify: `README.md`, `package.json` (`description`)

**Interfaces:**
- Consumes: every script name and file path above.

There is no unit test for documentation. Step 2 checks that the documents name only things that exist.

- [ ] **Step 1: Write the check**

```bash
# Every pnpm script the docs mention must exist; every file they name must exist.
for s in $(grep -ohE 'pnpm [a-z:]+' README.md deploy/README.md | awk '{print $2}' | sort -u); do
  case "$s" in install|add) continue;; esac
  node -e "process.exit(require('./package.json').scripts['$s'] ? 0 : 1)" || echo "missing script: $s"
done
for f in deploy/compose.yaml deploy/compose.dev.yaml deploy/.env.example deploy/dev.env deploy/kratos/kratos.yml deploy/caddy/Caddyfile; do
  test -f "$f" || echo "missing file: $f"
done
grep -nE 'income-tracker\.html|SQLite|IndexedDB|SQL console|\.db\b|make-shortcut' README.md || echo "no stale offline references"
```

- [ ] **Step 2: Run, expect FAIL**

Run the block above.
Expected: `missing file`-free output, but the grep prints many stale lines, for example `3:a real SQLite database…` and `14:Double-click **income-tracker.html**`. `deploy/README.md` does not exist yet, so `grep` also reports `No such file or directory`.

- [ ] **Step 3: Implement**

`deploy/README.md`:

````markdown
# Deploying Income Tracker

One Linux server, one domain, Docker Compose. Caddy gets the HTTPS
certificate from Let's Encrypt by itself.

## What runs

| Service | What it is |
| --- | --- |
| `caddy` | The only public port (80/443). Serves the web app, proxies `/auth/*` to Kratos and `/api/*` to the api. |
| `api` | Node 26, Hono. Applies database migrations on start, then serves. Fetches the gold price once a day. |
| `kratos` | Ory Kratos v1.3.1: accounts, passwords, 2FA, email verification and recovery. Its admin API is never exposed. |
| `kratos-migrate` | Runs Kratos's own migrations once, then exits. |
| `postgres` | Postgres 17, two databases: `app` and `kratos`. Data in the `pgdata` volume. |

## First deployment

1. **DNS.** Create an `A` record for your domain (e.g. `money.example.com`)
   pointing at the server's public IP. Wait until `dig +short money.example.com`
   prints that IP — Caddy needs it to get a certificate.
2. **Server.** Install Docker Engine with the Compose plugin. Open ports 80 and
   443 (TCP) and 443 (UDP) in the firewall.
3. **Code.** `git clone` this repository onto the server and `cd` into it.
4. **Configuration.**

   ```bash
   cp deploy/.env.example deploy/.env
   openssl rand -hex 32   # POSTGRES_PASSWORD, APP_DB_PASSWORD, KRATOS_DB_PASSWORD, KRATOS_COOKIE_SECRET — one each
   openssl rand -hex 16   # KRATOS_CIPHER_SECRET — must be exactly 32 characters
   ```

   Edit `deploy/.env`: set `APP_DOMAIN`, paste the secrets, and fill in
   `SMTP_URI` / `SMTP_FROM` with a real mail provider (verification and
   recovery codes are sent by email). `chmod 600 deploy/.env`.
5. **Start.**

   ```bash
   docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
   docker compose --env-file deploy/.env -f deploy/compose.yaml ps
   ```

6. **Check.** `https://money.example.com` shows the sign-in screen;
   `curl https://money.example.com/auth/health/ready` prints `{"status":"ok"}`.
   Create your account, then **Settings → Import backup (.json)** with the
   backup downloaded from the offline version.

## Backups

The database is the only state worth keeping (Caddy's certificates are
re-issued if lost). A nightly dump, kept for 14 days — `crontab -e`:

```cron
15 3 * * * cd /srv/income && docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres pg_dumpall -U postgres | gzip > /var/backups/income-$(date +\%F).sql.gz && find /var/backups -name 'income-*.sql.gz' -mtime +14 -delete
```

Copy `/var/backups` off the server too. To restore onto a fresh stack: start
only `postgres`, then
`gunzip -c income-YYYY-MM-DD.sql.gz | docker compose … exec -T postgres psql -U postgres`,
then start everything else.

Each user can also download their own JSON backup from **Settings**.

## Upgrades

```bash
git pull
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

The api applies new migrations on start. Before a Kratos version bump, take a
backup, change the tag in `deploy/compose.yaml` for both `kratos` and
`kratos-migrate`, and read Ory's upgrade notes for that release.

## Logs

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml logs -f api
```

The api logs one JSON line per request with a `requestId`; the same id is in
the `x-request-id` response header, so a user's error can be found in the log.
````

`README.md`:
- Replace lines 1–38 (from `# Income Tracker` through the end of the `### As a desktop app` section, just before `### What it tracks`) with:

```markdown
# Income Tracker

A personal money tracker for income, bills, purchases, accounts, goals and
gold, with Excel export. It runs as a web app: sign up, and your records are
kept on the server under your account, separate from everyone else's.

The offline single-file version is retired. It is still available from the
`v1-offline` tag. Download a backup from it (**Settings → Download backup
(.json)**) and import that here under **Settings → Import backup (.json)**.

## Using it

Open the site, create an account with your email and a password, and you are
in. A code is emailed to verify the address. Under **Security** (top right)
you can change your password, add an authenticator app for two-factor sign-in,
and get backup codes. **Forgot your password?** on the sign-in screen emails a
recovery code.

It starts in Egyptian pounds (`E£` / `EGP`). Change that, and the number
format, under **Settings → Currency & goals**.

To run your own copy on a server, see [deploy/README.md](deploy/README.md).
```

- Replace the `### The address bar remembers where you were` section's body with:

```markdown
The tab and the month are in the address — `https://…/bills/2026-07`. Reload
and you land back on the same screen in the same month; back and forward step
through the months you have looked at; and a month of a tab can be bookmarked.
```

- In `### Gold`, replace `Once a day the app fetches` with `Once a day the server fetches`, and replace `Every reading is kept, so the price history is a series you can chart or export\neven when you are offline.` with `Every reading is kept, so the price history is a series you can chart or export.`
- Replace the `### Where your data is kept` and `### Back up your data` sections, up to `## Working on the code`, with:

```markdown
### Where your data is kept

In Postgres on the server, in tables named after the lists you see — income,
bills, purchases, accounts and so on — with every row tagged with your
account. Money is stored as whole minor units (`BIGINT`), so totals never
drift. Every query the server runs names your account, and the database
itself refuses to show one account's rows to another (row-level security).

### Back up your data

**Settings → Download backup (.json)** is your whole record set in one file,
and **Import backup (.json)** reads it back — replacing what is there. The
Excel file is a report, not a backup.
```

- Replace everything from `## Working on the code` to the end of the file with:

````markdown
## Working on the code

```
pnpm install       # once
pnpm test          # typecheck + the Node suites (no database needed)
pnpm db:test:up    # a throwaway Postgres on 127.0.0.1:54329
pnpm test:db       # schema, repository, api and gold-price suites against it
pnpm build         # dist/web
pnpm stack:dev     # the whole stack at https://localhost, mail at http://localhost:8025
pnpm dev           # rebuild dist/web on change (the dev stack serves it)
pnpm test:browser  # the browser suite against the dev stack
pnpm test:full     # all of the above
```

The dev stack uses Caddy's own certificate authority; the first visit to
`https://localhost` asks you to accept it.

| Path | What it is |
| --- | --- |
| `src/domain/` | Every rule: records, recurring, debts, reconciling, forecast, gold. Pure TypeScript, shared by the web app and the api. |
| `src/wire.ts` | The shape of what the api answers, and how the web applies it. |
| `src/web/` | The Preact app: `state/` (signal, api client, actions, routing), `ui/` (tabs and components), `auth/` (sign-in screens). |
| `src/workbook/` | The Excel writer, run in the browser. |
| `server/` | The api: Hono app, routes, repository, migrations, the daily gold-price job. |
| `deploy/` | Compose files, Kratos and Caddy config, the Postgres init script. |
| `test/` | Node suites, `support/` helpers, and `browser.mjs`. |

#### How a write reaches the screen

A screen calls an action (`upsert`, `borrow`, `reconcile`…). The action sends
one request; the api takes a per-user lock, loads the whole state, calls the
same domain function the offline build called, diffs the result by id, writes
the diff and answers with it. The browser applies the diff to the `app` signal,
and the screen redraws. If the answer's version skips one, another device
wrote in between and the whole state is fetched again.

### The `__app` console handle

The page exposes `__app` in the browser console — the live state, account
balances, `upsert`, `clearAll`, `reload`, and the workbook builder. The browser
suite drives the app through it. It can do nothing the signed-in person cannot
already do from the screen, and only to their own data.
````

- In `package.json`, set `"description"` to `"Personal income, bills, purchases and savings tracker — web app with Excel export"`.

- [ ] **Step 4: Run, expect PASS**

Run the Step 1 block again.
Expected: no `missing script` or `missing file` lines, and the last line is `no stale offline references`.

- [ ] **Step 5: Commit**

```bash
git add deploy/README.md README.md package.json
git commit -m "docs: deployment runbook and README for the web app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec section | Task(s) |
| --- | --- |
| Context / phases, offline build retired | 1, 15 |
| Decisions: open sign-up, separate data | 6, 8, 12 |
| Decisions: Kratos headless, own screens | 12, 13 |
| Decisions: REST + Postgres, server owns rules | 4–9 |
| Decisions: VPS + Caddy HTTPS | 13, 15 |
| Decisions: SQL console removed | 1 |
| Decisions: gold price server-side, shared | 4 (`gold_prices`), 6, 10 |
| Decisions: existing data via import | 9, 11, 14 |
| Architecture: single origin, `/auth` prefix stripped, admin unexposed | 13 |
| Repository layout (`src/web`, `src/web/auth`, `server`, `server/migrations`, `deploy`) | 1, 4, 12, 13 |
| sqlite/SqlConsole/vendor/single-file removed; `dist/web` | 1, 2 |
| Excel export stays client-side | 1 (unchanged `src/workbook`), 14 |
| Compose services, pinned images, dev overrides, `.env`, README | 13, 15 |
| Kratos identity schema, methods, session, cookie, URLs | 13 |
| Verification wired, not enforced; banner | 12, 13, 14 |
| `kratos.ts`, `FlowForm.tsx`, screens, session gate, 401 → login, topbar email/logout | 12 |
| Path routing + `try_files` | 12, 13 |
| Database: tables, `user_id`, composite PK, snake_case, BIGINT, settings/users | 4, 6 |
| Phase-3-ready: `accounts.currency`, `fx_rates`, `baseCurrency`, `CURRENCY_EXPONENT` | 3, 4, 6 |
| Shared `gold_prices` | 4, 6, 10 |
| UNIQUE `(user_id, template_id, period)` on bills and income | 4 |
| Isolation: repo userId-first, RLS + `SET LOCAL` (via `set_config(…, true)`), non-owner role | 4, 6 |
| API: Hono, Node 26 type-stripping, zod | 7, 8 |
| Middleware order: request id/log, session cache, Origin, lock, rate limit | 7 (lock inside `mutate`) |
| Diff-based writes, `state_version`, response shape | 5, 6, 7 |
| Endpoints table | 7, 8, 9 |
| Collection validation minus goldPrices; error shape and codes | 8, 7 |
| Jobs: gold daily; catch-up via POST after load | 10, 11 |
| Web data layer: `boot`, `api.ts`, async actions, await + toast + disabled, version refetch, offline notice | 11 |
| Testing: domain/roundtrip/export unchanged in substance | 1 |
| Testing: `test/api.ts` isolation, CSRF, concurrency, composite equality | 7, 8, 9 (split into `api-core`/`api-records`/`api-composite`), 6 (RLS alone) |
| Testing: browser suite on dev stack, register, import, login/logout, 2FA | 14 |
| Acceptance | 13 (stack up), 14 (flows, figures), 15 (runbook) |

## Deviations and decisions made while planning (for the reviewer)

1. **`test/roundtrip.ts` is the xlsx writer's round trip, not sqlite's.** The spec says to retarget it to repo load/save. It never touched sqlite, so it stays unchanged, and the Postgres round trip lives in the new `test/repo.ts`.
2. **`test/domain.ts` and `test/export.ts` cannot stay byte-for-byte unchanged.** They import `src/state/*`, whose actions become async API calls. They now import `test/support/store.ts`, the offline build's synchronous store kept verbatim. That changes their import lines only. The "saves are batched" block in `domain.ts` is deleted, because it tested sql.js persistence coalescing, which no longer exists.
3. **Responses carry `result` and optional `settings`** alongside `{ version, changes }`. That is how actions keep returning what they return today (`upsert` gives the record, `reconcile` the difference). `/api/state` returns `{ version, state }`, because `AppState.version` is already `SCHEMA_VERSION`.
4. **RLS context uses `set_config('app.user_id', $1, true)`**, which is exactly `SET LOCAL` but accepts a bound parameter. The policy uses `current_setting('app.user_id', true)`, so an unset context matches no rows rather than raising an error.
5. **The non-owner role** is `app`, which runs every request. Migrations run as the `postgres` superuser through `MIGRATION_DATABASE_URL`. The api container therefore holds the superuser password too. If that is unwanted, run migrations as a separate one-shot service.
6. **Rows keep their insertion order** through a `seq` identity column. The domain relies on array order (`lastAccountFor`) and the sqlite store preserved it implicitly.
7. **`accounts.currency`** is set by the repository on insert, because a column default cannot read the user's settings. The fallback default is `'EGP'`.
8. **PUT `/api/:collection/:id`** is update-only and returns 404 for a missing id, which the isolation tests need. The web uses `POST /api/:collection` (upsert) everywhere, matching `Records.upsert`. `PUT /api/goals/:id` upserts, because it is `saveGoal` and the web generates new goal ids itself.
9. **The per-user lock** is taken inside `mutate()`, in the write's own transaction, not as middleware. Middleware cannot hold a transaction open across the handler.
10. **The rate limit is per user only.** `/api/*` requires a session before the bucket is consulted, so there is never an anonymous key to fall back to an IP for.
11. **The "Update price" button on the Gold tab** reloads the state, because no refresh endpoint exists. The server checks hourly and fetches once a day.
12. **`recordGoldPrice` is removed from web actions.** Gold prices are written only by the job. The spec says actions keep every name; this is the one exception.
13. **Kratos cookie domain** is left unset, which makes it a host-only cookie on `$APP_DOMAIN` rather than `Domain=$APP_DOMAIN`. Browsers reject `Domain=localhost`, which would break the dev stack. A host-only cookie is also strictly narrower.
14. **The client serializes its writes** through a promise queue, so `version === previous + 1` holds within a tab. A jump means another device wrote, and the client refetches.
15. **`TZ`** was added to `.env` for the api. Catch-up uses the server clock to decide "this month", which the offline build took from the user's machine.
16. **`make-shortcut.ps1`, `make-icon.mjs` and `income-tracker.ico`** are left in the repo but no longer documented. They point at a file that is no longer built. Delete them or repurpose them, for example as an app-mode shortcut to the deployed URL.
