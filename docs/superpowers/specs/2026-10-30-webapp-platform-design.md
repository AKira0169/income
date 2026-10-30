# Phase 1 — Web app platform: auth, API, deploy

Date: 2026-10-30 · Branch: `feat/webapp-platform` · Previous offline build tagged `v1-offline`

## Context

Income Tracker today is a single-file offline app: Preact UI, pure TypeScript
domain layer (`src/domain/*`), SQLite via sql.js persisted to the browser's
IndexedDB. It is being turned into a deployed multi-user web app.

The whole effort is three phases, each with its own spec → plan → build:

1. **Platform (this spec)** — Docker Compose stack, Ory Kratos auth, REST API
   on Postgres, every tab rewired to the API, backup import. *Current look kept.*
2. **Redesign** — modern fintech UI (sidebar, KPI cards, light/dark, mobile).
3. **Tracking** — net-worth history, assets vs liabilities, manual assets with
   valuations, multi-currency UI, upcoming & overdue payments.

Phase 1 keeps the existing visuals on purpose: `test/browser.mjs` remains a
regression check that the rewire changed no behaviour.

## Decisions (agreed)

| Topic | Decision |
| --- | --- |
| Users | Open sign-up, fully separate data per user |
| Auth | Ory Kratos (headless); our own auth screens |
| Data | Full REST API, Postgres, server owns the rules |
| Deploy | Linux VPS + own domain, Caddy with automatic HTTPS |
| SQL console | Removed (unsafe with multiple users) |
| Gold price | Fetched server-side once a day, shared by all users |
| Offline build | Retired; recoverable from tag `v1-offline` |
| Existing data | Imported via Settings → Import backup (current backup JSON) |

## Architecture

```
Browser ──HTTPS──▶ caddy  ($APP_DOMAIN, Let's Encrypt)
                    ├── /auth/*  → kratos:4433   (public API, prefix stripped)
                    ├── /api/*   → api:3000
                    └── /*       → static web build (served by caddy)
api    ──▶ kratos:4433/sessions/whoami   (cookie forwarded, 30 s cache)
api    ──▶ postgres/app
kratos ──▶ postgres/kratos, SMTP
```

One origin for everything, so the Kratos session cookie is first-party and no
CORS is needed. The Kratos admin API (4434) is never exposed through Caddy.

### Repository layout

```
src/domain/        unchanged pure logic — shared by web and api
src/web/           today's src/ui + src/state + main.tsx, moved
src/web/auth/      Kratos flow screens
server/            api: Hono app, routes, repository, db, jobs
server/migrations/ SQL migrations (plain .sql, applied in order at startup)
deploy/            compose.yaml, Caddyfile, kratos/ (kratos.yml, identity.schema.json), .env.example
```

`src/data/sqlite.ts`, `src/ui/tabs/SqlConsole.tsx`, `vendor/sql-wasm.*` and the
single-file assembly in `build.mjs` are removed. `build.mjs` instead emits
`dist/web/` (index.html + hashed JS/CSS). The Excel export (`src/workbook/*`)
stays client-side, built from the loaded state.

## Compose stack (`deploy/compose.yaml`)

| Service | Image | Notes |
| --- | --- | --- |
| `postgres` | `postgres:17-alpine` | init script creates `app` and `kratos` DBs + roles; named volume |
| `kratos-migrate` | `oryd/kratos` (latest v1.x, exact tag pinned at build time) | `migrate sql -e --yes`, runs once, `depends_on` postgres healthy |
| `kratos` | `oryd/kratos` (same tag) | `serve --watch-courier`; depends on kratos-migrate completed |
| `api` | built from `server/Dockerfile` (node:26-alpine) | runs migrations then serves on 3000 |
| `caddy` | built from `deploy/Caddyfile` + `dist/web` (multi-stage: node build → caddy:2-alpine) | ports 80/443, volumes for certs |
| `mailpit` | `axllent/mailpit` | **dev profile only**; UI on 8025 |

`compose.dev.yaml` overrides: `APP_DOMAIN=localhost`, Caddy `tls internal`,
mailpit enabled, api with `--watch`.

Secrets and config via `deploy/.env` (`.env.example` committed):
`APP_DOMAIN`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `KRATOS_DB_PASSWORD`,
`KRATOS_COOKIE_SECRET`, `KRATOS_CIPHER_SECRET` (32 chars), `SMTP_URI`,
`SMTP_FROM`. A `deploy/README.md` documents: DNS A record → VPS, copy
`.env.example`, generate secrets (`openssl rand -hex 32`),
`docker compose up -d`, backups (`pg_dump` cron example), upgrades.

## Authentication (Kratos)

**Identity schema:** trait `email` (identifier for password + TOTP,
verification and recovery via `code`), optional trait `name`.

**Enabled methods:** `password`, `totp`, `code` (verification + recovery),
`lookup_secret` (2FA backup codes). Session lifespan 30 days, cookie
`SameSite=Lax`, `Secure`, domain `$APP_DOMAIN`. Verification required before
login is **not** enforced in phase 1 (sign-up works without SMTP in dev), but
the verification flow is wired and a banner asks unverified users to verify.

**Self-service URLs** in `kratos.yml` point at web routes:
`/login`, `/registration`, `/recovery`, `/verification`, `/settings/security`,
`/error`; default return URL `/`.

**Web side (`src/web/auth/`):**
- `kratos.ts` — fetch wrapper for browser flows on `/auth` (`credentials:
  'include'`, `Accept: application/json`): create/get/submit flow, whoami,
  logout.
- `FlowForm.tsx` — **one generic renderer** for a flow's `ui.nodes` (input,
  hidden csrf_token, submit buttons, TOTP QR image, lookup-secret text, and
  `ui.messages` per node and per form). Handles 400 (re-render with
  messages), 410/403 (restart flow), 422 `redirect_browser_to`.
- Screens: `Login`, `Registration`, `Recovery`, `Verification`,
  `SecuritySettings` (password change, TOTP enrol/unlink, backup codes),
  all thin wrappers around `FlowForm`.
- Session gate in `App.tsx`: whoami on boot → no session ⇒ auth screens;
  session ⇒ load state; any API 401 ⇒ back to `/login`.
- Topbar shows the user's email and a Log out action.

Routing moves from hash routes to path routes (`/dashboard/2026-07`,
`/login`), with Caddy's `try_files {path} /index.html`.

## Database (app schema)

Every table has `user_id UUID NOT NULL` (Kratos identity id) and primary key
`(user_id, id)`. `id` is TEXT and may be client-generated (existing `uid()`
ids keep working; the composite key prevents cross-user collision).

Tables mirror `TABLES` in today's `sqlite.ts`: `income`, `income_templates`,
`bill_templates`, `bills`, `purchases`, `accounts`, `goals`, `savings_tx`,
`gold`, plus `settings (user_id PK, data JSONB)` and `users (id PK,
created_at, state_version BIGINT)`. Money columns are `BIGINT` minor units.
Column names snake_case; the repository maps to the camelCase domain types.

Phase-3-ready now (schema only, no UI yet):
- `accounts.currency CHAR(3) NOT NULL DEFAULT` the user's base currency.
- `fx_rates (user_id, date, currency, rate_to_base NUMERIC, PK(user_id, date, currency))`.
- `settings.data.baseCurrency` (defaults to today's `currencyCode`).
- A `CURRENCY_EXPONENT` map in `src/domain/money.ts` (default 2; JPY 0,
  KWD/BHD/OMR 3) — money stays integer minor units per currency.

Shared, not per user: `gold_prices (date PK, usd_per_oz, egp_per_usd,
egp_per_gram24, source, fetched_at)`. The domain's `goldPrices` collection
is fed from it read-only.

Generated rows are protected against duplicates:
`UNIQUE (user_id, template_id, period)` on `bills` and on `income` (income
gets a stored `period` column derived from `date`).

**Isolation:** all SQL goes through `server/repo.ts`, which takes `userId` as
a required first argument and adds it to every statement. As a backstop, RLS
is enabled on every per-user table with policy
`user_id = current_setting('app.user_id')::uuid`, set per transaction via
`SET LOCAL`. The api connects as a non-owner role so RLS applies.

## API

Hono on Node 26 (native TS type-stripping — `src/domain/*` is imported
directly, same as the tests do today). `zod` validates every body.

**Middleware, in order:** request id + logging → for `/api/*`: session
(whoami via forwarded cookie, 30 s LRU cache keyed by session token;
401 if none; creates the `users` row on first sight) → for non-GET:
`Origin` must equal `https://$APP_DOMAIN` (CSRF) → per-user mutation lock
(`pg_advisory_xact_lock(hashtext(user_id))` inside the request's
transaction) → rate limit (simple in-memory token bucket per user/IP).

**How writes reuse the domain:** a mutating handler opens a transaction,
takes the lock, loads the user's full `AppState` (`repo.loadState`), calls
the *existing* domain function, diffs old vs new per collection by id
(`server/diff.ts`), writes inserts/updates/deletes, bumps
`users.state_version`, commits, and responds with
`{ version, changes: { [collection]: { upserts: Record[], deletes: Id[] } } }`.
Data sizes are personal-finance small; loading full state per write is fine.

**Endpoints:**

| Method & path | Domain call |
| --- | --- |
| `GET /api/me` | identity email, verified flag, `version` |
| `GET /api/state` | full `AppState` + `version` (the web's read path) |
| `GET /api/:collection` / `GET /api/:collection/:id` | list / one (REST reads) |
| `POST /api/:collection` · `PUT /api/:collection/:id` | `Records.upsert` |
| `DELETE /api/:collection/:id` | `Records.remove` |
| `PATCH /api/settings` | `Records.updateSettings` |
| `POST /api/recurring/catch-up` | `Recurring.catchUp` |
| `POST /api/recurring/generate` `{collection, period}` | `generateBills` / `generateIncome` |
| `POST /api/recurring/link` `{collection, template}` | `linkGeneratedTo` |
| `PUT /api/goals/:id` `{draft, paid}` · `POST /api/goals/:id/move` `{delta}` | `saveGoal` / `moveGoal` |
| `POST /api/debts` · `POST /api/debts/:id/repay` | `Debt.borrow` / `Debt.repay` |
| `POST /api/accounts/:id/reconcile` `{actual, date}` | `Reconcile.reconcile` |
| `GET /api/backup` · `POST /api/backup/import` · `DELETE /api/data` | export / `Backup.importJSON` (replaces) / erase |

`collection` is validated against `COLLECTION_KEYS` minus `goldPrices`.
Errors: `{ error: { code, message } }` with 400/401/403/404/409/429/500;
domain-thrown errors map to 400 with the domain's message (they are already
written for humans).

**Jobs (in-process, `server/jobs.ts`):** gold price fetch daily (moves
`src/data/gold-price.ts` server-side; respects nothing per user — the manual
price and premium stay per-user settings applied client-side as today).
Recurring catch-up replaces the browser boot sweep: the web calls
`POST /api/recurring/catch-up` right after loading state (GET stays
read-only), and the unique `(user_id, template_id, period)` keys plus the
lock make repeated or concurrent calls harmless.

## Web data layer

`src/web/state/app.ts` keeps the `app` signal and its contract (screens keep
reading `app.value` and passing it to domain selectors — no screen logic
changes). Persistence/sqlite boot is replaced by:
- `boot()` → `GET /api/state` → `hydrate`.
- `src/web/state/api.ts` — typed fetch client, applies a `changes` response
  to the signal (immutably), tracks `version`.
- `actions.ts` keeps every exported function name; each becomes `async`,
  calls its endpoint, applies the returned changes, and returns the same
  value it returns today (`upsert` → saved record, `reconcile` →
  difference, `catchUp` → counts). Call sites in tabs gain `await` and show
  a toast on failure; buttons disable while a request is in flight.
- Version conflict handling: if a response's `version` is not
  `previous + 1`, refetch `/api/state` (another device wrote).
- The "storage blocked" notice becomes an "offline / can't reach server"
  notice.

## Testing

- `test/domain.ts`, `test/roundtrip.ts`, `test/export.ts` keep passing
  unchanged (domain untouched; roundtrip retargeted from sqlite to
  repo load/save against Postgres).
- `test/api.ts` (new) against a disposable Postgres (`compose.test.yaml`)
  with Kratos whoami stubbed:
  - **Isolation:** user A cannot GET/PUT/DELETE user B's record by id
    (404), and `/api/state` never contains B's rows. RLS alone (repo
    bypassed) also blocks it.
  - CSRF: non-GET with a foreign `Origin` → 403.
  - Concurrency: two parallel `catch-up` calls create no duplicate bills.
  - Each composite endpoint (borrow, repay, reconcile, saveGoal, import)
    produces the same state as calling the domain function directly.
- `test/browser.mjs` updated to run against the dev compose stack: register
  a user through the UI, import a fixture backup, then run the existing
  checks. Plus login/logout and 2FA enrol smoke test.

## Out of scope for phase 1

Redesign, net-worth/payments features, multi-currency UI, email reminders,
Google sign-in, admin console, horizontal scaling (single api instance;
the in-memory caches assume it).

## Acceptance

- `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d` on a
  fresh VPS with DNS pointed brings up the site on `https://$APP_DOMAIN`.
- A new user can sign up, verify email, log in, enable TOTP, recover a
  password, and log out.
- Importing an existing `v1-offline` backup shows the same figures on every
  tab as the offline build did.
- All test suites above pass, including the isolation tests.
