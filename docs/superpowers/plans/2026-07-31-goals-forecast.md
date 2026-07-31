# Goals and the Cash Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `goals` collection and a pure month-by-month cash forecast that answers "when can I afford this" and "how much will I have in March", taking non-monthly bills seriously.

**Architecture:** One pure function, `forecast(state)`, produces a month-by-month projection line. "When can I afford it" is the first month the line crosses a threshold; "how much will I have" is a lookup on the same line; the on-screen table is the line itself. The engine lives in a new `src/domain/forecast.ts` because `selectors.ts` is already 210 lines and forecasting is a separate concern. Goals are funded in order: goal *n*'s threshold is its own price plus every price ahead of it.

**Tech Stack:** TypeScript (strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`), Preact + `@preact/signals`, SQLite via sql.js/WASM, esbuild single-file build, Node's own type-stripping for the test suite (no test framework — plain `check(label, actual, expected)` functions).

**Source spec:** `docs/superpowers/specs/2026-07-31-goals-forecast-design.md`. Every task below carries the exact values it needs; no task should need to open the spec.

## Global Constraints

Every task's requirements implicitly include this section.

- **`src/domain/` is pure.** No DOM, no browser APIs, no signals, no network. State comes in as the first argument. This is what makes it testable in Node.
- **Every write returns a new state object.** Never mutate the state passed in — replace the state object, the collection array, and the record. A signal compares with `===`; an in-place edit notifies nobody and the screen silently disagrees with the data.
- **Money is `Cents`: an integer number of minor units.** Never a fractional currency value. Use `Math.round` when dividing.
- **Forms are uncontrolled.** Initial values go in through `defaultValue` / `defaultChecked` / `<option selected>` — never `value` or `checked` — and are read back off `form.elements` on submit. The browser suite fails if this is undone.
- **`readAll()` in `sqlite.ts` coerces only the literal column `active` back into a boolean.** Every other column added by a later build reads back as SQL `NULL` → `null` on an existing database. So: test `boughtDate` with a falsy check (`!goal.boughtDate`), never `=== ''`; and read every number as `price || 0`, `priority || 0`.
- **The forecast never generates rows.** It reads templates and returns numbers. Never call `generateBills` / `generateIncome` for a future month — "nothing is generated ahead of today" is a deliberate invariant of the recurring model.
- **Nothing is smoothed.** A yearly premium is charged in the one month it is really due. `occursIn(tpl, period)` already encodes every frequency and its anchor; use it.
- **Reuse the existing components:** `TargetProgress` from `Figure.tsx`, `Sheet` / `SheetHead` / `SheetBody` / `AddSection`, `Table` / `EmptyRow` / `RowActions`, `Form` / `Editor`, `ScopeToggle`, `Figure`, `toast`.
- **No special-casing in `backup.ts`, `records.ts:migrate()`, or `workbook/`.** They iterate `COLLECTION_KEYS`; adding the key is the whole change.
- **No Goals sheet in the Excel export.** Everything in the workbook is recorded fact; a forecast is an assumption and would go stale inside the file.
- **TypeScript settings that bite:** `noUnusedLocals` and `noUnusedParameters` are on (no leftover variables), `verbatimModuleSyntax` is on (type-only imports must use `import type`), `erasableSyntaxOnly` is on (no enums, no namespaces, no parameter properties). Index accesses in existing code use `!` / `?.`; follow that.
- **Comment density matches the surrounding code.** Files in this repo open with a `/* file.ts — one line on what it is. */` header and explain *why* at the tricky spots. Match that; do not narrate the obvious.

## Verification

Run from the repo root:

- `pnpm test` — typechecks both tsconfigs, then runs `test/domain.ts`, `test/roundtrip.ts`, `test/export.ts`. **Every task must end with this passing.**
- `pnpm test:browser` — builds the single-file app and drives it in headless Chrome. **Required for Task 5 and Task 6 only.** It skips itself with exit code 0 if no Chrome/Edge is found; if you see "No Chrome or Edge found — skipping the browser suite", say so in your report rather than claiming a pass.

## Two decisions already taken by the human partner

Both were raised before execution and answered; do not re-litigate them.

1. **The bill cash-date rule is extracted into one shared `billCashDate(bill)` helper** (Task 2) and used by both `accountFlows` and the projection, rather than written inline in both places. The spec's prose describes the duplicated form; the helper is what to build.
2. **The far-future invariant test `cashOnHand(state, '9999-12') === totalSavings(state)` is kept**, alongside the hand-computed current-period test that actually discriminates. It is intentional and paired, not a weak test standing alone.

One further deviation, decided while planning: the spec asks for the goals persistence tests in `test/roundtrip.ts`. That file is the `.xlsx` writer's round-trip against the SheetJS oracle and has nothing to do with the database. The JSON backup round-trip therefore goes in `test/domain.ts` (Task 1) and the SQLite write/read cycle goes in `test/browser.mjs` (Task 5), which is the only place SQLite actually runs. Both assertions the spec asked for are kept, including `price` and `priority` coming back as numbers.

---

### Task 1: The `Goal` record and its storage

Adding a collection is four small generic edits plus two new settings. Nothing here computes anything; it is the shape everything later reads.

**Files:**
- Modify: `src/domain/types.ts` — add `Goal`, add `goals` to `Collections`, add two `Settings` fields
- Modify: `src/domain/catalog.ts` — `COLLECTION_KEYS`, `ID_PREFIX`
- Modify: `src/domain/records.ts` — `blankState()`
- Modify: `src/data/sqlite.ts` — `TABLES`, `TYPES`
- Test: `test/domain.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Goal` (`id`, `name`, `price`, `priority`, `boughtDate`, `notes`); `state.goals: Goal[]`; `state.settings.forecastSpendingAuto: boolean` (default `true`); `state.settings.forecastSpending: Cents` (default `0`). `upsert(state, 'goals', draft)` and `remove(state, 'goals', id)` work with no further change because they are generic over `CollectionKey`.

- [ ] **Step 1: Write the failing test**

Add `migrate` to the existing `records.ts` import at the top of `test/domain.ts`, and add a new import line for the backup module. The two import lines become:

```ts
import { exportJSON, importJSON } from '../src/domain/backup.ts';
import { blankState, migrate, updateSettings, upsert } from '../src/domain/records.ts';
```

Then append this block to `test/domain.ts`, immediately **before** the final `console.log(failures ? ...)` / `process.exit(...)` two lines:

```ts
/* ---------------- goals are just another collection ---------------- */

/* Every persistence path is generic over COLLECTION_KEYS, so the whole of
   "adding a collection" is that the generic paths now see it. These check the
   generic paths really did pick it up rather than that a bespoke one works. */
console.log('\ngoals are a stored collection:');
check('a blank state has an empty goals list', blankState().goals, []);
check('the forecast settings have defaults',
  [blankState().settings.forecastSpendingAuto, blankState().settings.forecastSpending],
  [true, 0]);
check('a save written before goals existed still loads', migrate({ income: [] }).goals, []);

const noGoals = blankState();
const goalState = upsert(noGoals, 'goals', {
  name: 'RTX 5080', price: 4500000, priority: 1, boughtDate: '', notes: ''
}).state;
check('a new goal gets an id with the goals prefix',
  goalState.goals[0]?.id.startsWith('gol_'), true);
check('the state object is replaced rather than edited', goalState === noGoals, false);
check('and the state it was handed still has no goals', noGoals.goals.length, 0);

const restored = importJSON(exportJSON(goalState)).state;
check('goals survive a JSON backup and restore', restored.goals, goalState.goals);
check('price and priority come back as numbers',
  [typeof restored.goals[0]?.price, typeof restored.goals[0]?.priority],
  ['number', 'number']);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — typecheck errors first, because `blankState().goals` and `settings.forecastSpendingAuto` do not exist yet.

- [ ] **Step 3: Add the `Goal` type and the settings fields**

In `src/domain/types.ts`, add these two fields to the `Settings` interface, after `goldManualPrice`:

```ts
  /** Average the last few months' purchases rather than using a typed figure. */
  forecastSpendingAuto: boolean;
  /** The monthly purchases figure the forecast uses when auto is off. */
  forecastSpending: Cents;
```

Add the `Goal` interface next to the other record interfaces (put it after `Account`):

```ts
/** Something you are saving up for. */
export interface Goal {
  id: Id;
  name: string;
  /** 0 when you do not know the price yet. */
  price: Cents;
  /* `priority`, not `order`: the schema quotes every identifier so `order`
     would in fact work, but the SQL-keyword trap is not worth leaving. */
  /** Funding order, ascending. */
  priority: number;
  /* A date rather than a `bought` boolean: readAll() coerces only the literal
     column `active` back into a boolean, so a new boolean field would come back
     as 0/1 and contradict its own type. It also matches how Bill derives
     `status` from `paidDate`, and records *when* you bought it. */
  /** Set when you actually bought it; empty means still saving. */
  boughtDate: IsoDate | '';
  notes: string;
}
```

Add `goals` to `Collections`, after `accounts`:

```ts
  goals: Goal[];
```

- [ ] **Step 4: Register the collection**

In `src/domain/catalog.ts`, add `'goals'` to `COLLECTION_KEYS` after `'accounts'`, and `goals: 'gol'` to `ID_PREFIX`. The two constants become:

```ts
export const COLLECTION_KEYS: readonly CollectionKey[] = [
  'income', 'incomeTemplates', 'billTemplates', 'bills', 'purchases',
  'accounts', 'goals', 'savingsTx', 'gold', 'goldPrices'
];

/** Id prefixes, so a record's origin is readable in the database. */
export const ID_PREFIX: Readonly<Record<CollectionKey, string>> = {
  income: 'inc', incomeTemplates: 'itp', billTemplates: 'tpl', bills: 'bil',
  purchases: 'pur', accounts: 'acc', goals: 'gol', savingsTx: 'sav',
  gold: 'gld', goldPrices: 'gpr'
};
```

- [ ] **Step 5: Add the defaults to `blankState()`**

In `src/domain/records.ts`, inside `blankState()`, add the two settings after `goldManualPrice: 0` (keep the existing trailing comment block above `goldSync` where it is):

```ts
      goldManualPrice: 0,

      /* The forecast's assumed monthly purchases. Auto averages the last three
         complete months; turning it off uses the figure you typed instead. */
      forecastSpendingAuto: true,
      forecastSpending: 0
```

and add the collection after `accounts: []`:

```ts
    goals: [],
```

`migrate()` needs no change — it loops `COLLECTION_KEYS`.

- [ ] **Step 6: Add the SQLite table**

In `src/data/sqlite.ts`, add the row to `TABLES` after `accounts`:

```ts
  goals: ['id', 'name', 'price', 'priority', 'boughtDate', 'notes'],
```

and add the two integer columns to `TYPES` — `price` and `priority` — so the object reads:

```ts
const TYPES: Readonly<Record<string, string>> = {
  amount: 'INTEGER', expected: 'INTEGER', target: 'INTEGER', opening: 'INTEGER',
  price: 'INTEGER', priority: 'INTEGER',
  dueDay: 'INTEGER', payDay: 'INTEGER', active: 'INTEGER', units: 'REAL', unitRate: 'REAL',
  karat: 'INTEGER', grams: 'REAL', pricePerGram: 'INTEGER',
  usdPerOz: 'REAL', egpPerUsd: 'REAL', egpPerGram24: 'INTEGER'
};
```

No index: goals are few and are never filtered by date. An existing database picks the table up because `applySchema()` runs `CREATE TABLE IF NOT EXISTS` on every open.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS, including the six new `goals are a stored collection` checks.

- [ ] **Step 8: Commit**

```bash
git add src/domain/types.ts src/domain/catalog.ts src/domain/records.ts src/data/sqlite.ts test/domain.ts
git commit -m "feat: add the goals collection and the two forecast settings"
```

---

### Task 2: Balances as of a month

`accountFlows` currently applies every record whatever its date, so `totalSavings(state)` means "the balance once everything recorded has settled", not "the balance today". The forecast needs the dated version.

**Files:**
- Modify: `src/domain/selectors.ts` — `billCashDate`, `accountFlows`, `accountBalance`, new `cashOnHand`
- Test: `test/domain.ts`

**Interfaces:**
- Consumes: `state.accounts` (Task 1 changed nothing here).
- Produces:
  ```ts
  export const billCashDate = (bill: { paidDate?: IsoDate | ''; dueDate?: IsoDate | '' }): IsoDate
  export function accountFlows(state: AppState, accountId: Id, throughPeriod?: Period): AccountFlows
  export function accountBalance(state: AppState, accountId: Id, throughPeriod?: Period): Cents
  export function cashOnHand(state: AppState, throughPeriod: Period): Cents
  ```
  With `throughPeriod` omitted the behaviour is exactly as today, so **no existing call site changes.**

- [ ] **Step 1: Write the failing test**

Append this block to `test/domain.ts`, immediately before the final `console.log(failures ? ...)` / `process.exit(...)` lines. Add `accountBalance`, `billCashDate`, `cashOnHand` and `totalSavings` to the imports at the top:

```ts
import { accountBalance, billCashDate, cashOnHand, totalSavings } from '../src/domain/selectors.ts';
```

```ts
/* ---------------- balances as of a month ---------------- */

/* The fixture puts records deliberately on both sides of a 2026-07 cut-off.
   The far-future invariant below passes even when the date filter is wrong in
   every other case, so the hand-computed figure is the test that discriminates
   and the invariant is what pins the two readings together. */
console.log('\nbalances as of a month:');
let dated: AppState = upsert(blankState(), 'accounts', {
  id: 'a_d', name: 'Card', type: 'Current Account', opening: 100000, target: 0, notes: ''
}).state;
dated = upsert(dated, 'income', {
  id: 'i_now', date: '2026-07-05', source: 'Salary', category: 'Salary',
  amount: 50000, accountId: 'a_d', method: '', notes: ''
}).state;
dated = upsert(dated, 'income', {
  id: 'i_later', date: '2026-09-05', source: 'Salary', category: 'Salary',
  amount: 70000, accountId: 'a_d', method: '', notes: ''
}).state;
dated = upsert(dated, 'purchases', {
  id: 'p_now', date: '2026-07-09', item: 'Tea', category: 'Groceries',
  amount: 1000, accountId: 'a_d', method: '', notes: ''
}).state;
// Due in June, paid in August: cash left the account in August, not June.
dated = upsert(dated, 'bills', {
  id: 'b_late', name: 'Water', category: 'Water', provider: '', dueDate: '2026-06-10',
  amount: 3000, accountId: 'a_d', units: null, unitRate: null, paidDate: '2026-08-02',
  method: '', notes: ''
}).state;
// Paid, but with no paid date recorded. periodOf('') is '', which sorts before
// every real period — this must fall under its due date instead.
dated = upsert(dated, 'bills', {
  id: 'b_nodate', name: 'Internet', category: 'Internet', provider: '', dueDate: '2026-09-10',
  amount: 2000, accountId: 'a_d', units: null, unitRate: null, paidDate: '',
  method: '', notes: ''
}).state;
dated = { ...dated, bills: dated.bills.map((b) => (b.id === 'b_nodate' ? { ...b, status: 'paid' } : b)) };

check('the cash date of a bill paid late is the date it was paid',
  billCashDate({ dueDate: '2026-06-10', paidDate: '2026-08-02' }), '2026-08-02');
check('and a paid bill with no paid date falls under its due date',
  billCashDate({ dueDate: '2026-09-10', paidDate: '' }), '2026-09-10');

// 100,000 opening + 50,000 July income − 1,000 July purchase. The September
// income, the bill paid in August and the bill dated September are all after.
check('the balance as of July is hand-computable',
  accountBalance(dated, 'a_d', '2026-07'), 149000);
check('the September income is excluded until September',
  accountBalance(dated, 'a_d', '2026-09'), 149000 + 70000 - 3000 - 2000);
check('a bill paid late counts in the month it was paid, not the month it was due',
  accountBalance(dated, 'a_d', '2026-08'), 149000 - 3000);

check('cash on hand adds every account together',
  cashOnHand(dated, '2026-07'), 149000);
check('and far enough out it is exactly the undated total',
  cashOnHand(dated, '9999-12'), totalSavings(dated));
check('omitting the cut-off leaves the old behaviour alone',
  accountBalance(dated, 'a_d'), totalSavings(dated));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `billCashDate` and `cashOnHand` are not exported, and `accountBalance` takes two arguments.

- [ ] **Step 3: Add `billCashDate` and thread the cut-off through**

In `src/domain/selectors.ts`, add the helper just above `accountFlows`:

```ts
/* When a bill actually moves money. `paidDate || dueDate` rather than
   `paidDate` alone because a paid bill can carry an empty paid date, and
   periodOf('') is '', which sorts before every real period — such a bill would
   otherwise count as paid in the distant past. One helper rather than the
   expression twice, so the balance and the projection cannot drift apart. */
export const billCashDate = (
  bill: { paidDate?: IsoDate | ''; dueDate?: IsoDate | '' }
): IsoDate => bill.paidDate || bill.dueDate || '';
```

Replace `accountFlows` and `accountBalance` with the dated versions. The comment above `accountFlows` stays as it is; add the cut-off paragraph to it:

```ts
/* Every flow that touches an account, in the order money actually moves. A bill
   only leaves the account when it is paid — an unpaid bill is a commitment, not
   a withdrawal, and deducting it would make the balance disagree with the bank.

   With `throughPeriod` given, a flow counts only if its cash date falls on or
   before the end of that period. Omitted, every record counts whatever its
   date, which is what every existing caller means. */
export function accountFlows(state: AppState, accountId: Id, throughPeriod?: Period): AccountFlows {
  const flows: AccountFlows = {
    opening: 0, income: 0, purchases: 0, bills: 0, savedIn: 0, savedOut: 0, gold: 0
  };
  const account = byId(state, 'accounts', accountId);
  if (!account) return flows;

  /* The opening balance has no date and counts in full at every cut-off. That
     is the correct reading rather than a limitation: an opening balance is by
     definition the money that was there before the records begin, and Account
     carries no date it could be filed under. "As of a month" invites the
     opposite assumption, which is why this says so. */
  flows.opening = account.opening || 0;

  const settled = (date: IsoDate | '' | null | undefined): boolean =>
    !throughPeriod || periodOf(date) <= throughPeriod;

  for (const r of state.income) {
    if (r.accountId === accountId && settled(r.date)) flows.income += r.amount || 0;
  }
  for (const r of state.purchases) {
    if (r.accountId === accountId && settled(r.date)) flows.purchases += r.amount || 0;
  }
  for (const b of state.bills) {
    if (b.accountId === accountId && b.status === 'paid' && settled(billCashDate(b))) {
      flows.bills += b.amount || 0;
    }
  }
  // Buying gold takes money out of an account and turns it into metal; selling
  // puts it back. Net, so a positive figure means gold has cost this account.
  for (const r of state.gold) {
    if (r.accountId !== accountId || !settled(r.date)) continue;
    flows.gold += r.direction === 'sell' ? -(r.amount || 0) : (r.amount || 0);
  }
  for (const tx of state.savingsTx) {
    if (!settled(tx.date)) continue;
    const amount = tx.amount || 0;
    if (tx.direction === 'transfer') {
      if (tx.accountId === accountId) flows.savedIn += amount;
      if (tx.fromAccountId === accountId) flows.savedOut += amount;
      continue;
    }
    if (tx.accountId !== accountId) continue;
    if (tx.direction === 'out') flows.savedOut += amount;
    else flows.savedIn += amount;
  }
  return flows;
}

export function accountBalance(state: AppState, accountId: Id, throughPeriod?: Period): Cents {
  const f = accountFlows(state, accountId, throughPeriod);
  return f.opening + f.income + f.savedIn - f.purchases - f.bills - f.savedOut - f.gold;
}
```

- [ ] **Step 4: Add `cashOnHand`**

Add it directly after `totalSavings` in the same file:

```ts
/* Every account added together, as of the end of `throughPeriod`. Summed per
   account rather than over the raw tables so that transfers cancel out and a
   record pointing at a deleted account is excluded — the same way totalSavings
   already excludes it. */
export function cashOnHand(state: AppState, throughPeriod: Period): Cents {
  return sum(state.accounts, (a) => accountBalance(state, a.id, throughPeriod));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — the nine new `balances as of a month` checks, and every pre-existing check still green (no call site was changed).

- [ ] **Step 6: Commit**

```bash
git add src/domain/selectors.ts test/domain.ts
git commit -m "feat: read account balances as of a given month"
```

---

### Task 3: The forecast engine

One pure function producing a month-by-month projection. Starting at the *current* month and projecting only months after it avoids every partial-month double count: this month's salary is already a recorded row and therefore already inside `cashOnHand`, and this month's purchases so far are too.

**Files:**
- Modify: `src/domain/types.ts` — `ForecastMonth`, `ForecastOptions`, `Forecast`
- Create: `src/domain/forecast.ts`
- Test: `test/domain.ts`

**Interfaces:**
- Consumes: from `src/domain/selectors.ts` — `billCashDate(bill)`, `cashOnHand(state, throughPeriod)`, `purchasesIn(state, period)`, `sum(list, pick)`. From `src/domain/period.ts` — `currentPeriod()`, `periodOf(isoDate)`, `shiftPeriod(period, months)`, `occursIn(template, period)`.
- Produces:
  ```ts
  export const HORIZON_MONTHS = 60;
  export const SPENDING_WINDOW = 3;
  export function assumedSpending(state: AppState, throughPeriod?: Period): Cents
  export function forecastSpending(state: AppState): Cents
  export function forecast(state: AppState, opts?: ForecastOptions): Forecast
  ```

- [ ] **Step 1: Add the three types**

In `src/domain/types.ts`, under the `/* ------- derived data */` banner (next to `MonthSummary`), add:

```ts
/** One month of the cash projection. */
export interface ForecastMonth {
  period: Period;
  income: Cents;
  bills: Cents;
  spending: Cents;
  /** Gold and outside movements already recorded for this month; signed. */
  other: Cents;
  surplus: Cents;
  /** Money on hand at the end of this month. */
  balance: Cents;
}

export interface ForecastOptions {
  /** Defaults to currentPeriod(). */
  from?: Period;
  /** How many future months. Defaults to HORIZON_MONTHS. */
  months?: number;
  /** Overrides forecastSpending(state). */
  spending?: Cents;
}

export interface Forecast {
  startPeriod: Period;
  /** cashOnHand at startPeriod, less `outstanding`. */
  start: Cents;
  /** Unpaid bills dated in startPeriod or earlier. */
  outstanding: Cents;
  /** The assumed monthly purchases actually used. */
  spending: Cents;
  /** One row per future month, oldest first. Never includes startPeriod. */
  months: ForecastMonth[];
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/domain.ts`, before the final two lines. Add the import at the top:

```ts
import { assumedSpending, forecast, HORIZON_MONTHS } from '../src/domain/forecast.ts';
```

```ts
/* ---------------- the cash projection ---------------- */

/* The worked example from the spec, pinned to fixed periods so it never drifts
   with the real calendar: salary 18,000, four monthly bills totalling 5,700, a
   9,000 insurance premium every January, usual purchases 3,300. Accounts hold
   12,000 with 1,400 of bills unpaid, so the line starts at 10,600. */
console.log('\nthe cash projection:');
const FROM = '2026-07';

let world: AppState = upsert(blankState(), 'accounts', {
  id: 'a_f', name: 'Card', type: 'Current Account', opening: 1200000, target: 0, notes: ''
}).state;
world = upsert(world, 'incomeTemplates', {
  id: 'itp_pay', source: 'Acme', category: 'Salary', frequency: 'Monthly', payDay: 28,
  expected: 1800000, accountId: 'a_f', method: '', active: true, anchor: '2026-01',
  generatedThrough: '', notes: ''
}).state;
world = upsert(world, 'billTemplates', {
  id: 'tpl_fixed', name: 'Fixed bills', category: 'Rent', provider: '', frequency: 'Monthly',
  dueDay: 1, expected: 570000, accountId: 'a_f', method: '', active: true, anchor: '2026-01',
  generatedThrough: '', notes: ''
}).state;
world = upsert(world, 'billTemplates', {
  id: 'tpl_ins', name: 'Insurance', category: 'Insurance', provider: '', frequency: 'Yearly',
  dueDay: 15, expected: 900000, accountId: 'a_f', method: '', active: true, anchor: '2026-01',
  generatedThrough: '', notes: ''
}).state;
// Unpaid and dated in the starting month: a commitment the bank has not taken.
world = upsert(world, 'bills', {
  id: 'b_out', name: 'Mobile', category: 'Mobile', provider: '', dueDate: '2026-07-20',
  amount: 140000, accountId: 'a_f', units: null, unitRate: null, paidDate: '', method: '', notes: ''
}).state;

const line = forecast(world, { from: FROM, spending: 330000 });

check('the starting line subtracts unpaid bills dated in or before this month',
  [line.start, line.outstanding], [1060000, 140000]);
check('the projection never includes the starting month', line.months[0]?.period, '2026-08');
check('and runs to the horizon', line.months.length, HORIZON_MONTHS);

const at = (period: string) => line.months.find((m) => m.period === period);
check('a plain month is income less bills less spending',
  [at('2026-08')?.bills, at('2026-08')?.surplus, at('2026-08')?.balance],
  [570000, 900000, 1960000]);
check('the yearly premium lands in January and nowhere else',
  [at('2026-12')?.bills, at('2027-01')?.bills, at('2027-02')?.bills],
  [570000, 1470000, 570000]);
check('so January eats the whole surplus', at('2027-01')?.surplus, 0);
check('and November is where 45,000 is first covered',
  line.months.find((m) => m.balance >= 4500000)?.period, '2026-11');

/* A hand-entered future bill must not also be projected from its template, and
   one already paid must not be deducted a second time — cashOnHand has it. */
let entered = upsert(world, 'bills', {
  id: 'b_sep', templateId: 'tpl_fixed', name: 'Fixed bills', category: 'Rent', provider: '',
  dueDate: '2026-09-01', amount: 600000, accountId: 'a_f', units: null, unitRate: null,
  paidDate: '', method: '', notes: ''
}).state;
check('a hand-entered future bill replaces its template, it does not add to it',
  forecast(entered, { from: FROM, spending: 330000 }).months.find((m) => m.period === '2026-09')?.bills,
  600000);

entered = upsert(entered, 'bills', { id: 'b_sep', paidDate: '2026-07-15' }).state;
check('and one already paid is not deducted twice',
  forecast(entered, { from: FROM, spending: 330000 }).months.find((m) => m.period === '2026-09')?.bills,
  0);

const filled = upsert(world, 'income', {
  id: 'i_sep', templateId: 'itp_pay', date: '2026-09-28', source: 'Acme', category: 'Salary',
  amount: 1900000, accountId: 'a_f', method: '', notes: ''
}).state;
check('a hand-filled month is counted once, not twice',
  forecast(filled, { from: FROM, spending: 330000 }).months.find((m) => m.period === '2026-09')?.income,
  1900000);

/* ---------------- assumed spending ---------------- */

console.log('\nassumed spending:');
check('no purchases at all is 0, not NaN', assumedSpending(blankState(), FROM), 0);

let spent: AppState = blankState();
for (const [id, date, amount] of [
  ['s1', '2026-04-04', 300000],   // outside the three-month window
  ['s2', '2026-05-04', 600000],
  ['s3', '2026-06-04', 300000],
  ['s4', '2026-07-04', 999999]    // the current month, still running
] as const) {
  spent = upsert(spent, 'purchases', {
    id, date, item: 'Shop', category: 'Groceries', amount, accountId: '', method: '', notes: ''
  }).state;
}
// April, May and June: (300,000 + 600,000 + 300,000) / 3. July is ignored.
check('the last three complete months are averaged and the current one ignored',
  assumedSpending(spent, FROM), 400000);

let young: AppState = upsert(blankState(), 'purchases', {
  id: 's5', date: '2026-06-04', item: 'Shop', category: 'Groceries',
  amount: 300000, accountId: '', method: '', notes: ''
}).state;
check('a younger database divides by fewer months', assumedSpending(young, FROM), 300000);
young = upsert(young, 'purchases', {
  id: 's6', date: '2026-07-20', item: 'Shop', category: 'Groceries',
  amount: 900000, accountId: '', method: '', notes: ''
}).state;
check('and purchases only in the current month still average to 0',
  assumedSpending(upsert(blankState(), 'purchases', {
    id: 's7', date: '2026-07-20', item: 'Shop', category: 'Groceries',
    amount: 900000, accountId: '', method: '', notes: ''
  }).state, FROM), 0);
check('the younger figure is unchanged by a purchase in the current month',
  assumedSpending(young, FROM), 300000);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `src/domain/forecast.ts` does not exist.

- [ ] **Step 4: Write `src/domain/forecast.ts`**

```ts
/* domain/forecast.ts — when will I have enough, and how much will I have.

   One pure function produces a month-by-month cash projection. "When can I
   afford it" is the first month the line crosses a threshold; "how much will I
   have in March" is a lookup on the same line; the table on screen is the line
   itself. One thing to build, one thing to test.

   Pure, like the rest of domain/: no DOM, no signals, state in as the first
   argument. It reads recurring templates and returns numbers — it never
   generates rows. "Nothing is generated ahead of today" is a deliberate
   invariant of the recurring model, and writing future months here would put
   data in the database the user never asked for. */

import { currentPeriod, occursIn, periodOf, shiftPeriod } from './period.ts';
import { billCashDate, cashOnHand, purchasesIn, sum } from './selectors.ts';
import type {
  AppState, Cents, Forecast, ForecastMonth, ForecastOptions, Period
} from './types.ts';

/** Five years. Far enough that "not within the horizon" really means never. */
export const HORIZON_MONTHS = 60;
/** How many complete months the assumed spending is averaged over. */
export const SPENDING_WINDOW = 3;

/* ------------------------------------------------------- assumed spending */

/* Average one-off purchases over the last SPENDING_WINDOW complete months. The
   months *before* throughPeriod, because the current one is still running and
   would drag the average down.

   The divisor is the number of those months at or after the earliest month
   holding a purchase, so a database two months old is not averaged over three.
   That earliest month has to come from state.purchases and not from
   activePeriods(), which always includes the current month and would leave the
   divisor at zero on a fresh database. */
export function assumedSpending(state: AppState, throughPeriod?: Period): Cents {
  const through = throughPeriod || currentPeriod();

  let earliest = '';
  for (const p of state.purchases) {
    const period = periodOf(p.date);
    if (!period) continue;
    if (!earliest || period < earliest) earliest = period;
  }
  if (!earliest) return 0;

  let total = 0;
  let months = 0;
  for (let back = SPENDING_WINDOW; back >= 1; back--) {
    const period = shiftPeriod(through, -back);
    if (period < earliest) continue;
    months++;
    total += sum(purchasesIn(state, period), (r) => r.amount || 0);
  }
  return months ? Math.round(total / months) : 0;
}

/** What the projection should actually use. */
export function forecastSpending(state: AppState): Cents {
  return state.settings.forecastSpendingAuto === false
    ? (state.settings.forecastSpending || 0)
    : assumedSpending(state);
}

/* ------------------------------------------------------------- the line */

export function forecast(state: AppState, opts: ForecastOptions = {}): Forecast {
  const startPeriod = opts.from || currentPeriod();
  const horizon = opts.months ?? HORIZON_MONTHS;
  const spending = opts.spending ?? forecastSpending(state);

  /* Unpaid bills the bank has not taken yet. The app deliberately keeps them
     out of a balance; a forecast that also ignored them would flatter you by
     exactly that amount. */
  const outstanding = sum(
    state.bills.filter((b) => b.status !== 'paid' && b.period <= startPeriod),
    (b) => b.amount || 0
  );
  const start = cashOnHand(state, startPeriod) - outstanding;

  const months: ForecastMonth[] = [];
  let balance = start;

  for (let ahead = 1; ahead <= horizon; ahead++) {
    const period = shiftPeriod(startPeriod, ahead);

    /* Recorded rows first, then each template that has not already produced one
       for this month. The second clause is what stops a hand-filled month being
       counted twice; it mirrors the check the automatic sweep uses. */
    let income = 0;
    for (const r of state.income) {
      if (periodOf(r.date) === period) income += r.amount || 0;
    }
    for (const tpl of state.incomeTemplates) {
      if (!occursIn(tpl, period)) continue;
      if (state.income.some((r) => r.templateId === tpl.id && periodOf(r.date) === period)) continue;
      income += tpl.expected || 0;
    }

    let bills = 0;
    for (const b of state.bills) {
      /* The cash-date guard covers the rare bill filed under a future month but
         already paid, which cashOnHand has taken off the starting line. */
      if (b.period !== period || periodOf(billCashDate(b)) <= startPeriod) continue;
      bills += b.amount || 0;
    }
    for (const tpl of state.billTemplates) {
      if (!occursIn(tpl, period)) continue;
      if (state.bills.some((b) => b.templateId === tpl.id && b.period === period)) continue;
      bills += tpl.expected || 0;
    }

    /* A future-dated purchase is something you know about on top of your usual
       habits, so it adds to the assumed figure rather than replacing it. */
    const purchases = sum(purchasesIn(state, period), (r) => r.amount || 0);

    /* Gold bought or sold, and movements in or out from outside your accounts.
       Signed, positive meaning cash in. Transfers between your own accounts are
       ignored because they net to zero on the total. */
    let other = 0;
    for (const g of state.gold) {
      if (periodOf(g.date) !== period) continue;
      other += g.direction === 'sell' ? (g.amount || 0) : -(g.amount || 0);
    }
    for (const tx of state.savingsTx) {
      if (tx.direction === 'transfer' || periodOf(tx.date) !== period) continue;
      other += tx.direction === 'out' ? -(tx.amount || 0) : (tx.amount || 0);
    }

    const spend = spending + purchases;
    const surplus = income - bills - spend + other;
    balance += surplus;
    months.push({ period, income, bills, spending: spend, other, surplus, balance });
  }

  return { startPeriod, start, outstanding, spending, months };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — the fifteen new checks under `the cash projection` and `assumed spending`.

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/domain/forecast.ts test/domain.ts
git commit -m "feat: project cash month by month from templates and records"
```

---

### Task 4: Funding goals in order

Goal *n* needs the prices of every goal ahead of it plus its own. That is exactly "buy the first, then keep saving for the second", expressed as one running line rather than a simulation.

**Files:**
- Modify: `src/domain/types.ts` — `GoalForecast`
- Modify: `src/domain/forecast.ts` — `goalQueue`, `goalForecasts`, `moveGoal`
- Modify: `src/state/actions.ts` — the `moveGoal` wrapper
- Test: `test/domain.ts`

**Interfaces:**
- Consumes: `Goal` and `state.goals` (Task 1); `forecast(state, opts)` returning `{ startPeriod, start, outstanding, spending, months }` where each month is `{ period, income, bills, spending, other, surplus, balance }` (Task 3).
- Produces:
  ```ts
  export function goalQueue(state: AppState): Goal[]
  export function goalForecasts(state: AppState, f?: Forecast): GoalForecast[]
  export function moveGoal(state: AppState, id: Id, delta: number): AppState
  ```
  and in `src/state/actions.ts`: `export function moveGoal(id: Id, delta: number): void`.

- [ ] **Step 1: Add the `GoalForecast` type**

In `src/domain/types.ts`, next to `Forecast`:

```ts
export interface GoalForecast {
  goal: Goal;
  /** Total price of the goals ahead of this one. */
  reserved: Cents;
  /** reserved + goal.price — the balance this goal needs. */
  threshold: Cents;
  /** Already yours toward this goal: start − reserved, floored at 0, capped at price. */
  saved: Cents;
  /** 0..1 against this goal's own price. Always 0 when price is 0. */
  progress: number;
  /** First month whose balance reaches `threshold`; '' if never inside the horizon. */
  reachedIn: Period | '';
  /** Months from startPeriod, 0 meaning affordable now; null when reachedIn is ''. */
  monthsAway: number | null;
}
```

- [ ] **Step 2: Write the failing test**

Append to `test/domain.ts`, before the final two lines. Extend the `forecast.ts` import at the top to:

```ts
import {
  assumedSpending, forecast, goalForecasts, goalQueue, HORIZON_MONTHS, moveGoal
} from '../src/domain/forecast.ts';
```

```ts
/* ---------------- goals, funded in order ---------------- */

/* Reuses the worked example: the line starts at 10,600 and gains 9,000 a month
   apart from the January insurance month. 45,000 lands in November; a second
   goal of 20,000 needs 65,000, which the January premium pushes out to March. */
console.log('\ngoals, funded in order:');
let planned = world;
for (const [id, name, price, priority] of [
  ['gol_a', 'RTX 5080', 4500000, 1],
  ['gol_b', 'New phone', 2000000, 2]
] as const) {
  planned = upsert(planned, 'goals', { id, name, price, priority, boughtDate: '', notes: '' }).state;
}

const plannedLine = forecast(planned, { from: FROM, spending: 330000 });
const [first, second] = goalForecasts(planned, plannedLine);

check('the first goal needs only its own price', [first?.reserved, first?.threshold], [0, 4500000]);
check('and lands in November', [first?.reachedIn, first?.monthsAway], ['2026-11', 4]);
check('the second reserves the first price on top of its own',
  [second?.reserved, second?.threshold], [4500000, 6500000]);
check('so the January premium pushes it to March', second?.reachedIn, '2027-03');
check('progress is measured against the goal\'s own price',
  [first?.saved, Math.round((first?.progress ?? 0) * 100)], [1060000, 24]);
check('and a goal with nothing yet saved reads 0', [second?.saved, second?.progress], [0, 0]);

const priced = upsert(planned, 'goals', {
  id: 'gol_none', name: 'Something', price: 0, priority: 0, boughtDate: '', notes: ''
}).state;
const withoutPrice = goalForecasts(priced, forecast(priced, { from: FROM, spending: 330000 }));
check('a goal with no price gets no date', [withoutPrice[0]?.reachedIn, withoutPrice[0]?.monthsAway], ['', null]);
check('and never blocks a goal behind it', withoutPrice[1]?.threshold, 4500000);

const broke = goalForecasts(planned, forecast(planned, { from: FROM, spending: 3300000 }));
check('a negative surplus yields no date, not a date far away',
  [broke[0]?.reachedIn, broke[0]?.monthsAway], ['', null]);

const cheap = upsert(planned, 'goals', {
  id: 'gol_now', name: 'A cable', price: 100000, priority: -1, boughtDate: '', notes: ''
}).state;
const affordable = goalForecasts(cheap, forecast(cheap, { from: FROM, spending: 330000 }));
check('a goal you can already afford is 0 months away',
  [affordable[0]?.reachedIn, affordable[0]?.monthsAway], [FROM, 0]);

const bought = upsert(planned, 'goals', { id: 'gol_a', boughtDate: '2026-11-04' }).state;
check('a bought goal drops out of the funding queue',
  goalQueue(bought).map((g) => g.id), ['gol_b']);
// readAll() returns SQL NULL as null, so the test has to be falsy, not === ''.
const nulled = { ...planned, goals: planned.goals.map((g) => ({ ...g, boughtDate: null as unknown as '' })) };
check('and a null bought date read back off SQLite still counts as unbought',
  goalQueue(nulled).length, 2);

/* ---------------- reordering the queue ---------------- */

console.log('\nreordering the funding queue:');
const moved = moveGoal(planned, 'gol_b', -1);
check('moving up swaps the pair in one new state', goalQueue(moved).map((g) => g.id), ['gol_b', 'gol_a']);
check('the state object is replaced', moved === planned, false);
check('and the original is untouched', goalQueue(planned).map((g) => g.id), ['gol_a', 'gol_b']);
check('moving down returns it', goalQueue(moveGoal(moved, 'gol_b', 1)).map((g) => g.id), ['gol_a', 'gol_b']);
// Identity, not deep equality: a no-op must hand back the very same object, or
// the signal redraws and the database is rewritten for nothing.
check('moving up from the top is a no-op', moveGoal(planned, 'gol_a', -1) === planned, true);
check('moving down from the bottom is a no-op', moveGoal(planned, 'gol_b', 1) === planned, true);
check('moving a goal that is not in the queue is a no-op',
  moveGoal(planned, 'nope', 1) === planned, true);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `goalQueue`, `goalForecasts` and `moveGoal` are not exported from `forecast.ts`.

- [ ] **Step 4: Add the three functions to `src/domain/forecast.ts`**

Extend the imports at the top of the file — `withCollection` from `./records.ts`, and the extra types:

```ts
import { withCollection } from './records.ts';
import type {
  AppState, Cents, Forecast, ForecastMonth, ForecastOptions, Goal, GoalForecast, Id, Period
} from './types.ts';
```

Append to the end of the file:

```ts
/* --------------------------------------------------------- goals in order */

/* Goals still being saved for, in funding order. The test is falsy rather than
   === '': readAll() returns SQL NULL as null, so a column added to `goals` by a
   later build reads back as null on an existing database. The `id` tiebreak is
   what keeps the order stable when two priorities are equal — which they can
   be, for the same reason. */
export function goalQueue(state: AppState): Goal[] {
  return state.goals
    .filter((g) => !g.boughtDate)
    .slice()
    .sort((a, b) => ((a.priority || 0) - (b.priority || 0))
      || String(a.id).localeCompare(String(b.id)));
}

/* Goal n needs the prices of every goal ahead of it plus its own. That is
   exactly "buy the first, then keep saving for the second", expressed as one
   running line rather than a simulation. */
export function goalForecasts(state: AppState, f?: Forecast): GoalForecast[] {
  const line = f ?? forecast(state);
  const out: GoalForecast[] = [];
  let reserved = 0;

  for (const goal of goalQueue(state)) {
    const price = goal.price || 0;
    const threshold = reserved + price;
    const saved = Math.min(Math.max(line.start - reserved, 0), price);

    let reachedIn: Period | '' = '';
    let monthsAway: number | null = null;
    /* A goal with no price contributes 0 to `reserved` so it never blocks one
       behind it, and gets no date: the screen shows the projection and invites
       a price instead of inventing an answer. */
    if (price > 0) {
      if (line.start >= threshold) {
        reachedIn = line.startPeriod;
        monthsAway = 0;
      } else {
        const idx = line.months.findIndex((m: ForecastMonth) => m.balance >= threshold);
        if (idx !== -1) {
          reachedIn = line.months[idx]!.period;
          monthsAway = idx + 1;
        }
      }
    }

    out.push({
      goal,
      reserved,
      threshold,
      saved,
      progress: price > 0 ? saved / price : 0,
      reachedIn,
      monthsAway
    });
    reserved += price;
  }
  return out;
}

/* Moves a goal one place up (-1) or down (+1) the funding queue, and is a no-op
   at either end.

   One pure function returning one new state, rather than two upsert calls: two
   calls mean two commits, two saves, and an intermediate state where both goals
   hold the same priority — the queue order would flicker on the `id` tiebreak
   in between. The whole queue is renumbered rather than two numbers swapped,
   because priorities read back off an older database can be duplicated or null,
   and swapping two equal numbers would change nothing. */
export function moveGoal(state: AppState, id: Id, delta: number): AppState {
  const queue = goalQueue(state);
  const from = queue.findIndex((g) => g.id === id);
  if (from === -1) return state;
  const to = from + delta;
  if (to < 0 || to >= queue.length) return state;

  const order = queue.slice();
  const moving = order[from]!;
  order[from] = order[to]!;
  order[to] = moving;

  const priorities = new Map(order.map((g, i) => [g.id, i + 1]));
  return withCollection(state, 'goals', state.goals.map((g) => {
    const priority = priorities.get(g.id);
    return priority === undefined ? g : { ...g, priority };
  }));
}
```

- [ ] **Step 5: Add the action wrapper**

In `src/state/actions.ts`, add the module import beside the others (alphabetical, after `Gold`):

```ts
import * as Forecast from '../domain/forecast.ts';
```

and add the wrapper at the end of the file, following the same call-domain-then-commit shape as the rest:

```ts
/* Adding and deleting a goal need nothing here — upsert and remove are already
   generic over CollectionKey. Reordering is the one write with a rule. */
export function moveGoal(id: Id, delta: number): void {
  const next = Forecast.moveGoal(app.peek(), id, delta);
  if (next !== app.peek()) commit(next);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test`
Expected: PASS — the seventeen new checks under `goals, funded in order` and `reordering the funding queue`.

- [ ] **Step 7: Commit**

```bash
git add src/domain/types.ts src/domain/forecast.ts src/state/actions.ts test/domain.ts
git commit -m "feat: fund goals in order off the projection line"
```

---

### Task 5: The Goals tab

A new tab between **Accounts** and **Gold**. This is the largest task; the complete component is given below, so it is transcription plus wiring plus testing.

**Files:**
- Modify: `src/state/route.ts` — `TabId`, `TAB_IDS`
- Modify: `src/ui/Topbar.tsx` — `TABS`
- Modify: `src/ui/App.tsx` — import and `TABS`
- Modify: `src/ui/fields.ts` — `FIELDS.goal`
- Modify: `src/ui/components/ScopeToggle.tsx` — optional labels
- Modify: `src/app.css` — one rule for a negative figure in a table cell
- Create: `src/ui/tabs/Goals.tsx`
- Test: `test/browser.mjs`

**Interfaces:**
- Consumes: `forecast(state)`, `goalForecasts(state, f)`, `goalQueue(state)`, `HORIZON_MONTHS`, `SPENDING_WINDOW` from `src/domain/forecast.ts`; `moveGoal(id, delta)`, `upsert(collection, record)`, `remove(collection, id)`, `updateSettings(patch)` from `src/state/actions.ts`; `state.settings.forecastSpendingAuto` and `state.settings.forecastSpending`.
- Produces: the `'goals'` tab id, and `FIELDS.goal` for the add/edit forms.

- [ ] **Step 1: Register the tab**

`src/state/route.ts` — add `'goals'` between `'savings'` and `'gold'` in both places:

```ts
export type TabId = 'dashboard' | 'income' | 'bills' | 'purchases' | 'savings' | 'goals' | 'gold' | 'settings';

export const TAB_IDS: readonly TabId[] = [
  'dashboard', 'income', 'bills', 'purchases', 'savings', 'goals', 'gold', 'settings'
];
```

`src/ui/Topbar.tsx` — add to `TABS`, after the `savings` entry:

```ts
  { id: 'goals', label: 'Goals' },
```

`src/ui/App.tsx` — add the import beside the others (alphabetical, after `Gold`):

```ts
import { Goals } from './tabs/Goals.tsx';
```

and the entry to the `TABS` record, after `savings: Accounts`:

```ts
  goals: Goals,
```

- [ ] **Step 2: Add the goal field spec**

In `src/ui/fields.ts`, add to the `FIELDS` object after `account`:

```ts
  goal: [
    { key: 'name', label: 'What you want', type: 'text', placeholder: 'e.g. RTX 5080', required: true },
    { key: 'price', label: 'Price', type: 'money', placeholder: 'Leave empty if you do not know yet' },
    { key: 'boughtDate', label: 'Bought on', type: 'date' },
    { key: 'notes', label: 'Notes', type: 'text', wide: true }
  ],
```

- [ ] **Step 3: Let `ScopeToggle` carry other labels**

The Goals tab reads two ways too — the next twelve months, or the whole horizon — but not as "this month / all time". Replace `src/ui/components/ScopeToggle.tsx` with:

```tsx
/* ui/components/ScopeToggle.tsx — this month, or everything.

   Every list can be read two ways: the month on screen, which is the working
   view, or the whole history, which is what you go looking for when you want to
   know when something last happened. The Goals tab reads its projection the
   same two ways — the near months or the whole horizon — which is what the
   labels are for. */

export function ScopeToggle({ allTime, onChange, labels, group }: {
  allTime: boolean;
  onChange: (allTime: boolean) => void;
  /** Defaults to “This month” / “All time”. */
  labels?: readonly [string, string];
  /** The group's accessible name. Defaults to “How much to show”. */
  group?: string;
}) {
  const [near, far] = labels ?? ['This month', 'All time'];

  const button = (label: string, wanted: boolean) => (
    <button
      class={`scope-btn${allTime === wanted ? ' is-on' : ''}`}
      aria-pressed={allTime === wanted ? 'true' : 'false'}
      onClick={() => onChange(wanted)}
    >{label}</button>
  );

  return (
    <div class="scope" role="group" aria-label={group ?? 'How much to show'}>
      {button(near, false)}
      {button(far, true)}
    </div>
  );
}
```

The five existing callers pass neither new prop and are unchanged.

- [ ] **Step 4: Add the one missing CSS rule**

`.is-negative` exists in `src/app.css` only as `.figure.is-negative .figure-value` and
`.account-balance.is-negative`. A negative surplus in the month-by-month table needs its
own rule. Add it directly under `.account-balance.is-negative`:

```css
td.is-negative { color: var(--ink-danger); }
```

- [ ] **Step 5: Write `src/ui/tabs/Goals.tsx`**

```tsx
/* ui/tabs/Goals.tsx — what you are saving for, and when you will have it.

   This tab deliberately ignores the month picker in the top bar. Every other
   tab shows the month you chose; a forecast from a month in the past is
   meaningless, so this one always projects from the real current month.

   The assumptions panel describes the *next* month, which is the first row of
   the projection. Bills of other frequencies make months differ, which is why
   that line carries a note and the month-by-month table below it is where the
   real figures are. */

import { useState } from 'preact/hooks';
import { formatMoney, parseMoney, plural, toMajor } from '../../domain/money.ts';
import { periodLabel, todayISO } from '../../domain/period.ts';
import {
  forecast, goalForecasts, goalQueue, HORIZON_MONTHS, SPENDING_WINDOW
} from '../../domain/forecast.ts';
import { moveGoal, remove, updateSettings, upsert } from '../../state/actions.ts';
import { app } from '../../state/app.ts';
import { goTab } from '../../state/route.ts';
import type { AppState, Cents, Goal, GoalForecast } from '../../domain/types.ts';
import { Editor } from '../components/Dialog.tsx';
import { Figure, TargetProgress } from '../components/Figure.tsx';
import { ScopeToggle } from '../components/ScopeToggle.tsx';
import { AddSection, Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { EmptyRow, RowActions, Table } from '../components/Table.tsx';
import { toast } from '../components/Toast.tsx';
import { confirmDelete } from '../feedback.ts';
import { FIELDS } from '../fields.ts';

/** How much of the projection is on screen before you ask for the rest. */
const NEAR_MONTHS = 12;
const HORIZON_YEARS = Math.round(HORIZON_MONTHS / 12);

const GOAL_COLUMNS = 7;
const GOAL_HEADERS = [
  { label: '', num: true }, { label: 'Goal' }, { label: 'Price', num: true },
  { label: 'Saved', num: true }, { label: 'Ready by' }, { label: 'Progress' },
  { label: '', actions: true }
];

const MONTH_HEADERS = [
  { label: 'Month' }, { label: 'In', num: true }, { label: 'Bills', num: true },
  { label: 'Spent', num: true }, { label: 'Surplus', num: true }, { label: 'Balance', num: true }
];

const BOUGHT_HEADERS = [
  { label: 'Goal' }, { label: 'Price', num: true }, { label: 'Bought' }, { label: '', actions: true }
];

/** A new goal joins the back of the queue. */
const nextPriority = (state: AppState): number =>
  state.goals.reduce((max, g) => Math.max(max, g.priority || 0), 0) + 1;

export function Goals() {
  const state = app.value;
  const [allMonths, setAllMonths] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);

  const money = (cents: Cents): string => formatMoney(cents, state.settings);
  const locale = state.settings.locale;

  const nothingSetUp = !state.accounts.length
    && !state.incomeTemplates.length
    && !state.billTemplates.length;

  const line = forecast(state);
  const goals = goalForecasts(state, line);
  const queue = goalQueue(state);
  const bought = state.goals.filter((g) => g.boughtDate);
  const next = line.months[0];
  const rows = allMonths ? line.months : line.months.slice(0, NEAR_MONTHS);
  const auto = state.settings.forecastSpendingAuto !== false;

  const readyBy = (g: GoalForecast): string => {
    if (!(g.goal.price || 0)) return 'add a price';
    if (g.reachedIn) return periodLabel(g.reachedIn, locale);
    return `not within ${HORIZON_YEARS} years at this rate`;
  };

  /* How far the projection ends up short, so an unreachable goal says something
     more useful than "no". */
  const shortfall = (g: GoalForecast): Cents => {
    const end = line.months[line.months.length - 1]?.balance ?? line.start;
    return Math.max(g.threshold - end, 0);
  };

  if (nothingSetUp) {
    return (
      <div class="stack">
        <Sheet>
          <SheetHead><h2>Goals</h2></SheetHead>
          <SheetBody>
            <div class="empty">
              <strong>Set your recurring money up first</strong>
              A goal answers “when will I have enough”, which needs to know what comes in
              and what goes out each month.
              <div class="btn-row" style="margin-top:16px">
                <button onClick={() => goTab('income')}>Set up income</button>
                <button onClick={() => goTab('bills')}>Set up bills</button>
                <button onClick={() => goTab('savings')}>Add an account</button>
              </div>
            </div>
          </SheetBody>
        </Sheet>
      </div>
    );
  }

  const goalRow = (g: GoalForecast, i: number) => {
    const price = g.goal.price || 0;
    const short = price && !g.reachedIn ? shortfall(g) : 0;
    return (
      <tr key={g.goal.id}>
        <td class="num muted">{i + 1}</td>
        <td>
          <div>{g.goal.name}</div>
          {g.goal.notes ? <span class="cell-sub">{g.goal.notes}</span> : null}
        </td>
        <td class="num">{price ? money(price) : '—'}</td>
        <td class="num">{money(g.saved)}</td>
        <td title={short ? `${money(short)} short of ${money(g.threshold)} at the end of the projection` : undefined}>
          {readyBy(g)}
        </td>
        <td><TargetProgress balance={g.saved} target={price} settings={state.settings} /></td>
        <td class="actions">
          <button
            class="quiet small" disabled={i === 0}
            aria-label={`Move ${g.goal.name} up`}
            onClick={() => moveGoal(g.goal.id, -1)}
          >↑</button>
          <button
            class="quiet small" disabled={i === goals.length - 1}
            aria-label={`Move ${g.goal.name} down`}
            onClick={() => moveGoal(g.goal.id, 1)}
          >↓</button>
          <button
            class="quiet small"
            onClick={() => { upsert('goals', { id: g.goal.id, boughtDate: todayISO() }); toast('Marked as bought'); }}
          >Bought</button>
          <button class="quiet small" onClick={() => setEditing(g.goal)}>Edit</button>
          <button
            class="quiet small danger"
            onClick={() => { if (confirmDelete('goal')) remove('goals', g.goal.id); }}
          >Delete</button>
        </td>
      </tr>
    );
  };

  return (
    <div class="stack">
      <div class="figures">
        <Figure
          label="Spare each month" value={money(next?.surplus ?? 0)}
          note={(next?.surplus ?? 0) >= 0 ? 'after bills and usual spending' : 'you are short every month'}
          negative={(next?.surplus ?? 0) < 0}
        />
        <Figure
          label="On hand now" value={money(line.start)}
          note={line.outstanding ? `after ${money(line.outstanding)} of unpaid bills` : 'across every account'}
        />
        <Figure
          label="Next goal" value={queue[0]?.name ?? 'None yet'}
          note={goals[0] ? readyBy(goals[0]) : 'add one below'}
        />
      </div>

      {(next?.surplus ?? 0) < 0 ? (
        <div class="notice danger">
          <strong>You are spending more than you earn. </strong>
          {`About ${money(-(next?.surplus ?? 0))} more each month, so nothing is being put aside `
            + 'and no goal has a date yet.'}
        </div>
      ) : null}

      <Sheet>
        <SheetHead>
          <h2>Your goals</h2>
          <span class="muted spacer">
            Funded in order — the second starts once the first is covered.
          </span>
        </SheetHead>
        <SheetBody flush>
          <Table headers={GOAL_HEADERS}>
            {goals.length
              ? goals.map(goalRow)
              : (
                <EmptyRow
                  colspan={GOAL_COLUMNS}
                  title="Nothing on the list yet"
                  hint="Add what you are saving for and this says when you will have it."
                />
              )}
          </Table>
        </SheetBody>
      </Sheet>

      <AddSection
        title="Add a goal"
        addLabel="Add a goal"
        fields={FIELDS.goal}
        state={state}
        forceOpen={!state.goals.length}
        onInvalid={() => toast('Fill in the required fields')}
        onSubmit={(data) => {
          upsert('goals', { ...data, priority: nextPriority(state) });
          toast('Goal added');
        }}
      />

      <Sheet>
        <SheetHead>
          <h2>What this assumes</h2>
          <span class="muted spacer">{next ? periodLabel(next.period, locale) : ''}</span>
        </SheetHead>
        <SheetBody>
          <div class="bar-row">
            <div class="bar-name">Recurring income</div>
            <div class="bar-value num">{`+${money(next?.income ?? 0)}`}</div>
          </div>
          <div class="bar-row">
            <div class="bar-name">Recurring bills</div>
            <div class="bar-value num">{`−${money(next?.bills ?? 0)}`}</div>
          </div>
          <div class="muted">
            Not every month is the same — a yearly premium lands in its own month. The table
            below has the real figures.
          </div>
          <div class="bar-row">
            <div class="bar-name">Usual purchases</div>
            <div class="bar-value num">{`−${money(next?.spending ?? 0)}`}</div>
          </div>
          <div class="field">
            <label>
              <input
                type="checkbox" name="forecastSpendingAuto" defaultChecked={auto}
                onChange={(e) => updateSettings({
                  forecastSpendingAuto: (e.target as HTMLInputElement).checked
                })}
              />
              {` Average the last ${SPENDING_WINDOW} complete months`}
            </label>
            <input
              type="text" name="forecastSpending" aria-label="Use my own figure"
              placeholder="Use my own figure" disabled={auto}
              defaultValue={state.settings.forecastSpending ? String(toMajor(state.settings.forecastSpending)) : ''}
              onChange={(e) => updateSettings({
                forecastSpending: parseMoney((e.target as HTMLInputElement).value)
              })}
            />
          </div>
          <div class="bar-row">
            <div class="bar-name"><strong>Left over each month</strong></div>
            <div class="bar-value num">{money(next?.surplus ?? 0)}</div>
          </div>
        </SheetBody>
      </Sheet>

      <Sheet>
        <SheetHead>
          <h2>Month by month</h2>
          <span class="muted">{plural(rows.length, 'month')}</span>
          <div class="spacer">
            <ScopeToggle
              allTime={allMonths} onChange={setAllMonths}
              labels={[`${NEAR_MONTHS} months`, `${HORIZON_YEARS} years`]}
              group="How far ahead to show"
            />
          </div>
        </SheetHead>
        <SheetBody flush>
          <Table headers={MONTH_HEADERS}>
            {rows.map((m) => (
              <tr
                key={m.period}
                title={m.other
                  ? `Includes ${money(m.other)} of gold and outside movements`
                  : undefined}
              >
                <td>{periodLabel(m.period, locale)}</td>
                <td class="num">{money(m.income)}</td>
                <td class="num">{money(m.bills)}</td>
                <td class="num">{money(m.spending)}</td>
                <td class={m.surplus < 0 ? 'num is-negative' : 'num'}>{money(m.surplus)}</td>
                <td class="num">{money(m.balance)}</td>
              </tr>
            ))}
          </Table>
        </SheetBody>
      </Sheet>

      {bought.length ? (
        <Sheet>
          <SheetHead>
            <h2>Bought</h2>
            <span class="muted spacer">{plural(bought.length, 'goal')}</span>
          </SheetHead>
          <SheetBody flush>
            <Table headers={BOUGHT_HEADERS}>
              {bought.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td class="num">{money(g.price || 0)}</td>
                  <td class="num">{g.boughtDate}</td>
                  <RowActions
                    onEdit={() => setEditing(g)}
                    onDelete={() => { if (confirmDelete('goal')) remove('goals', g.id); }}
                  />
                </tr>
              ))}
            </Table>
          </SheetBody>
        </Sheet>
      ) : null}

      {editing ? (
        <Editor
          title="Edit goal"
          fields={FIELDS.goal}
          record={editing}
          state={state}
          onInvalid={() => toast('Fill in the required fields')}
          onSave={(data) => { upsert('goals', data); toast('Saved'); }}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
```

There is no "new goal" `Editor`: adding goes through `AddSection`, so the editor is only ever
handed an existing record.

- [ ] **Step 6: Update the browser suite**

In `test/browser.mjs`:

1. The boot check counts tabs. Change `7` to `8`:

```js
  check('every tab renders',
    await tab.evaluate(() => document.querySelectorAll('.tab').length), 8);
```

2. Add `'goals'` to the render loop, between `'savings'` and `'gold'`:

```js
  for (const id of ['dashboard', 'income', 'bills', 'purchases', 'savings', 'goals', 'gold', 'settings']) {
```

3. Insert this block immediately **before** the `/* ---------------- leave nothing behind ---------------- */` comment near the end:

```js
  /* ---------------- goals: ordering, the form, and SQLite ---------------- */
  console.log('\nthe Goals tab:');
  await tab.evaluate(() => {
    const a = globalThis.__app;
    a.upsert('goals', { id: 'gol_1', name: 'First', price: 100000, priority: 1, boughtDate: '', notes: '' });
    a.upsert('goals', { id: 'gol_2', name: 'Second', price: 200000, priority: 2, boughtDate: '', notes: '' });
  });
  await tab.evaluate(() => globalThis.__app.goTab('goals'));
  await settle();

  // The goals table is the first table on the tab; column 1 is the name cell.
  const goalOrder = () => tab.evaluate(() => [...document.querySelectorAll('main table')[0]
    .querySelectorAll('tbody tr')].map((r) => r.children[1].textContent));

  check('the Goals tab renders the queue', await goalOrder(), ['First', 'Second']);

  await tab.evaluate(() => document
    .querySelector('button[aria-label="Move Second up"]').click());
  await settle();
  check('move up reorders the queue', await goalOrder(), ['Second', 'First']);

  await tab.evaluate(() => document
    .querySelector('button[aria-label="Move Second down"]').click());
  await settle();
  check('and move down puts it back', await goalOrder(), ['First', 'Second']);
  check('move up is disabled on the first goal', await tab.evaluate(() =>
    document.querySelector('button[aria-label="Move First up"]').disabled), true);

  /* The same trap the rest of the suite is arranged around: a field rendering
     `value={initial}` instead of `defaultValue` eats what was typed the moment
     anything else redraws the page. */
  await tab.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add a goal');
    btn.click();
  });
  await tab.waitForSelector('form input[name="name"]');
  await tab.evaluate(() => { document.querySelector('form input[name="name"]').value = 'half typed'; });
  await tab.evaluate(() => globalThis.__app.upsert('goals', {
    id: 'gol_3', name: 'Distraction', price: 0, priority: 3, boughtDate: '', notes: ''
  }));
  await tab.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  check('the open goal form really did redraw', (await goalOrder()).length, 3);
  check('and the half-typed name is still there',
    await tab.evaluate(() => document.querySelector('form input[name="name"]').value), 'half typed');

  console.log('\ngoals survive the SQLite round-trip:');
  await open();
  const storedGoal = await tab.evaluate(() =>
    globalThis.__app.state().goals.find((g) => g.id === 'gol_1'));
  check('the goal is still there after a reload', storedGoal?.name, 'First');
  check('price and priority come back as numbers',
    [typeof storedGoal?.price, typeof storedGoal?.priority], ['number', 'number']);
  check('and their values are unchanged', [storedGoal?.price, storedGoal?.priority], [100000, 1]);
```

- [ ] **Step 7: Run both suites**

Run: `pnpm test && pnpm test:browser`
Expected: PASS. If the browser suite prints "No Chrome or Edge found — skipping the browser suite", say so explicitly in your report — that is a skip, not a pass.

- [ ] **Step 8: Commit**

```bash
git add src/state/route.ts src/ui/Topbar.tsx src/ui/App.tsx src/ui/fields.ts src/ui/components/ScopeToggle.tsx src/app.css src/ui/tabs/Goals.tsx test/browser.mjs
git commit -m "feat: add the Goals tab with its projection and ordering"
```

---

### Task 6: The Dashboard panel and the README

The last two places the feature has to show up. Nothing else on the Dashboard changes.

**Files:**
- Modify: `src/ui/tabs/Dashboard.tsx` — a `GoalsPanel` in the right-hand column
- Modify: `README.md` — a row in the tab table and a prose section
- Test: `test/browser.mjs` (the existing `dashboard renders something` check already covers it; add one assertion)

**Interfaces:**
- Consumes: `forecast(state)` and `goalForecasts(state, f)` from `src/domain/forecast.ts`, returning `GoalForecast[]` with `{ goal, reserved, threshold, saved, progress, reachedIn, monthsAway }`; `TargetProgress` from `Figure.tsx`.
- Produces: nothing further.

- [ ] **Step 1: Add the panel to the Dashboard**

In `src/ui/tabs/Dashboard.tsx`, add the two imports:

```ts
import { forecast, goalForecasts } from '../../domain/forecast.ts';
```

and extend the existing `types.ts` type import with `GoalForecast`.

Add the component next to `AccountsPanel`:

```tsx
/* What you are saving for and when it lands. The forecast always projects from
   the real current month, not the month the Dashboard is showing — a forecast
   from a month in the past is meaningless. */
function GoalsPanel({ state }: { state: AppState }) {
  const goals: GoalForecast[] = goalForecasts(state, forecast(state));
  if (!goals.length) return null;

  return (
    <Sheet>
      <SheetHead>
        <h2>Goals</h2>
        <span class="muted spacer">funded in order</span>
      </SheetHead>
      <SheetBody>
        <div class="stack-tight">
          {goals.map((g) => (
            <div key={g.goal.id}>
              <div class="bar-row">
                <div class="bar-name">{g.goal.name}</div>
                <div class="bar-value">
                  {g.reachedIn
                    ? periodLabel(g.reachedIn, state.settings.locale)
                    : (g.goal.price ? 'not yet in sight' : 'no price yet')}
                </div>
              </div>
              <TargetProgress
                balance={g.saved} target={g.goal.price || 0} settings={state.settings}
              />
            </div>
          ))}
        </div>
      </SheetBody>
    </Sheet>
  );
}
```

Render it in the right-hand column, immediately after the closing `</Sheet>` of the **Accounts** panel and before the closing `</div>` of that column:

```tsx
          <GoalsPanel state={state} />
```

`GoalsPanel` returns `null` when there are no unbought goals, which is what hides it.

- [ ] **Step 2: Add the browser assertion**

In `test/browser.mjs`, inside the goals block added in Task 5 — immediately after the `move up is disabled on the first goal` check — add:

```js
  await tab.evaluate(() => globalThis.__app.goTab('dashboard'));
  await settle();
  check('the Dashboard shows a Goals panel once there are goals',
    await tab.evaluate(() => [...document.querySelectorAll('main .sheet h2')]
      .some((h) => h.textContent === 'Goals')), true);
  await tab.evaluate(() => globalThis.__app.goTab('goals'));
  await settle();
```

- [ ] **Step 3: Update the README's tab table**

In `README.md`, add this row to the `| Tab | What goes in it |` table, between the **Accounts** and **Gold** rows:

```markdown
| **Goals** | What you are saving up for, and the month you will be able to afford each one. Funded in order: the second goal starts once the first is covered. Also answers the other half of the question — how much you will have in any month over the next five years. |
```

- [ ] **Step 4: Add the prose section**

In `README.md`, add this section immediately after the `### Accounts hold the money` section and before the section that follows it:

```markdown
### Goals and when you can afford them

The Goals tab answers two questions off one projection: **when will I have
enough**, and **how much will I have** by a given month.

Each future month is worth:

```
surplus = recurring income − recurring bills − usual purchases (+ anything else recorded)
balance = the month before it + surplus
```

The line starts at every account added together as it stands today, less the
bills you have been sent and not yet paid — those are commitments the bank has
not taken yet, so a forecast that ignored them would flatter you by exactly that
amount.

Three things make the answer honest:

- **Bills are charged in the month they are really due.** A yearly insurance
  premium lands in one month and nowhere else; nothing is spread across twelve.
  It is why a goal can land in March rather than February.
- **Usual purchases** are the average of your last three complete months —
  the current month is still running, so counting it would drag the figure down.
  You can type your own figure instead.
- **Goals are funded in order.** The second goal's target is its own price plus
  the first one's, so its date accounts for buying the first. Move a goal up or
  down the list to change what you buy first. A goal with no price yet never
  blocks the ones behind it.

Nothing here writes anything: the forecast reads your recurring set-up and
returns numbers. Marking a goal as bought files it under **Bought** with the
date, and the queue closes up behind it.
```

- [ ] **Step 5: Run both suites**

Run: `pnpm test && pnpm test:browser`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/tabs/Dashboard.tsx test/browser.mjs README.md
git commit -m "feat: show goals on the Dashboard and document the forecast"
```
