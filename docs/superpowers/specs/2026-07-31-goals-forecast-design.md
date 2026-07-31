# Goals and the cash forecast

**Date:** 2026-07-31

## What this is for

You want to buy something — a graphics card — and you do not have the money yet.
Two questions follow: **when will I have enough**, and **how much will I have** by
a given month. Both must take your bills seriously, including the ones that are
not monthly.

Today the app has an account `target` (a threshold on one pot) and a
`savingsGoalRate` (a percentage of income). Neither answers a date. This adds a
`goals` collection and a forecast engine that does.

## Decisions taken

| Question | Decision |
| --- | --- |
| What is the monthly surplus? | Recurring income − recurring bills − usual one-off purchases |
| Where does the starting money come from? | Every account added together, not only savings pots |
| Non-monthly bills? | Charged in the month they are really due, never smoothed |
| Is a price required? | No. Without one you still get the balance projection |
| More than one goal? | Funded in order — goal 2 starts after goal 1 is covered |
| Where does it live? | A new **Goals** tab, plus a small panel on the Dashboard |

## Architecture

One pure function produces a month-by-month cash projection. "When can I afford
it" is the first month the line crosses a threshold; "how much will I have in
March" is a lookup on the same line; the on-screen table is the line itself. One
thing to build, one thing to test.

The engine lives in a new **`src/domain/forecast.ts`**. `selectors.ts` is already
210 lines and forecasting is a separate concern. Like the rest of `domain/` it is
pure: no DOM, no signals, state in as the first argument.

### Money on hand, as of a month

`accountFlows` currently applies every record whatever its date, so
`totalSavings(state)` means "the balance once everything recorded has settled",
not "the balance today". The forecast needs the dated version.

**Change:** give `accountFlows` and `accountBalance` an optional third argument.

```ts
export function accountFlows(state: AppState, accountId: Id, throughPeriod?: Period): AccountFlows
export function accountBalance(state: AppState, accountId: Id, throughPeriod?: Period): Cents
```

Omitted, behaviour is exactly as today, so no existing call site changes. Given
a period, each flow counts only if its **cash date** falls on or before the end
of that period:

| Flow | Cash date |
| --- | --- |
| `opening` | none — always counted |
| income | `date` |
| purchases | `date` |
| bills | `paidDate` — and only bills whose `status` is `paid` |
| gold | `date` (buy is cash out, sell is cash in) |
| movements | `date` |

Then:

```ts
/** Every account added together, as of the end of `throughPeriod`. */
export function cashOnHand(state: AppState, throughPeriod: Period): Cents
```

which is the sum of `accountBalance(state, a.id, throughPeriod)` over
`state.accounts`. Summing per account rather than over the raw tables matters:
transfers cancel out correctly, and a record pointing at a deleted account is
excluded — the same way `totalSavings` already excludes it.

**Invariant, and a test:** `cashOnHand(state, '9999-12') === totalSavings(state)`.

### The starting line

```
start = cashOnHand(state, startPeriod) − outstanding
```

where `startPeriod` is the current month and `outstanding` is the total of every
**unpaid** bill with `period <= startPeriod`. Those are commitments the bank has
not taken yet. The app deliberately keeps them out of a balance — a forecast that
also ignored them would flatter you by exactly that amount.

Starting at the *current* month, and projecting only months after it, avoids
every partial-month double count: this month's salary is already a recorded row
and therefore already inside `cashOnHand`, and this month's purchases so far are
too.

### Each future month

For period `p` (strictly after `startPeriod`):

**Income** — recorded income rows dated in `p`, plus `expected` for each active
income template where `occursIn(tpl, p)` **and** no recorded row already has that
`templateId` in `p`. The second clause is what stops a hand-filled month being
counted twice; it mirrors the `incomeExists` check the sweep already uses.

**Bills** — recorded bills with `period === p` whose cash date
(`paidDate || dueDate`) is after `startPeriod`, plus `expected` for each active
bill template where `occursIn(tpl, p)` and no recorded bill already has that
`templateId` in `p`. The cash-date guard covers the rare bill filed under a
future month but already paid, which `cashOnHand` has taken off.

`occursIn` already encodes every frequency and its anchor, so a yearly premium
lands in one month and nowhere else. Nothing is smoothed.

**Spending** — the assumed monthly figure (below), plus any purchases actually
recorded in `p`. A future-dated purchase is something you know about on top of
your usual habits, so it adds rather than replaces.

**Other** — anything else recorded in `p`: gold bought or sold, and movements in
or out from outside your accounts. Signed, positive meaning cash in. Transfers
between your own accounts are ignored because they net to zero on the total.

```
surplus = income − bills − spending + other
balance = previous balance + surplus          (seeded from `start`)
```

**The forecast never generates rows.** It reads templates and returns numbers.
"Nothing is generated ahead of today" is a deliberate invariant of the recurring
model, and calling `generateBills`/`generateIncome` for a future month here would
write data the user never asked for.

### Assumed spending

```ts
/** Average one-off purchases over the last 3 complete months. */
export function assumedSpending(state: AppState, throughPeriod?: Period): Cents
```

Uses the three months **before** `throughPeriod` (default `currentPeriod()`); the
current month is still running and would drag the average down. Divides by the
number of those three months that fall at or after the earliest period holding
any record at all — so a database two months old is not averaged over three.
Returns 0 when there is nothing to average.

```ts
/** What the projection should actually use. */
export function forecastSpending(state: AppState): Cents
```

Returns `settings.forecastSpending` when `settings.forecastSpendingAuto` is
false, otherwise `assumedSpending(state)`.

### Types and entry point

```ts
export const HORIZON_MONTHS = 60;
export const SPENDING_WINDOW = 3;

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

export function forecast(state: AppState, opts?: ForecastOptions): Forecast;
```

### Funding goals in order

Goal *n* needs the prices of every goal ahead of it **plus** its own. That is
exactly "buy the first, then keep saving for the second", expressed as one
running line rather than a simulation:

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

/** Goals still being saved for, in funding order. */
export function goalQueue(state: AppState): Goal[];
export function goalForecasts(state: AppState, f?: Forecast): GoalForecast[];
```

`goalQueue` returns goals with an empty `boughtDate`, sorted by `priority` then
`id` so the order is stable.

Edge cases, all specified:

- **Already affordable** (`start >= threshold`) — `reachedIn` is `startPeriod`,
  `monthsAway` is 0.
- **No price** (`price === 0`) — contributes 0 to `reserved`, so it never blocks
  a goal behind it. `reachedIn` is `''`, `monthsAway` is `null`, `progress` is 0.
  The screen shows the projection and invites a price.
- **Not reachable** — surplus zero or negative, or the threshold is not crossed
  inside `HORIZON_MONTHS`. `reachedIn` is `''`. The screen says so and shows the
  shortfall rather than inventing a date.

### Worked example

July 2026. Salary 18,000; rent, electricity, internet and mobile totalling
5,700 a month; a 9,000 insurance premium every January; usual purchases 3,300.
Accounts hold 12,000 with 1,400 of bills unpaid.

```
Now (Jul 2026)   12,000 − 1,400 outstanding            →  10,600

           in       bills     spend    surplus     balance
Aug 26   18,000    −5,700    −3,300     +9,000      19,600
Sep 26   18,000    −5,700    −3,300     +9,000      28,600
Oct 26   18,000    −5,700    −3,300     +9,000      37,600
Nov 26   18,000    −5,700    −3,300     +9,000      46,600   ← RTX 5080 (45,000)
Dec 26   18,000    −5,700    −3,300     +9,000      55,600
Jan 27   18,000   −14,700    −3,300         +0      55,600   ← insurance month
Feb 27   18,000    −5,700    −3,300     +9,000      64,600
Mar 27   18,000    −5,700    −3,300     +9,000      73,600   ← phone (needs 65,000)
```

The card lands in **November 2026**. The phone's threshold is 45,000 + 20,000 =
65,000, so it lands in **March 2027** — the January premium is why it is March
and not February. That is the point of charging bills in their real month.

## Data model

```ts
export interface Goal {
  id: Id;
  name: string;
  /** 0 when you do not know the price yet. */
  price: Cents;
  /** Funding order, ascending. */
  priority: number;
  /** Set when you actually bought it; empty means still saving. */
  boughtDate: IsoDate | '';
  notes: string;
}
```

Two naming choices are deliberate:

- **`priority`, not `order`.** `order` is a SQL keyword. The schema quotes every
  identifier so it would in fact work, but the trap is not worth leaving.
- **`boughtDate`, not a `bought` boolean.** `readAll()` in `sqlite.ts` coerces
  only the literal column `active` back into a boolean, so a new boolean field
  would come back as `0`/`1` and contradict its own type. A date also matches how
  `Bill` derives `status` from `paidDate`, and records *when* you bought it.

New goals take `priority = max(existing) + 1`. Move up and move down swap
`priority` with the neighbour in the queue.

### Storage

Every persistence path is generic, so adding a collection is four small edits:

| File | Change |
| --- | --- |
| `src/domain/types.ts` | `Goal`; `goals: Goal[]` on `Collections`; `ForecastMonth`, `Forecast`, `ForecastOptions`, `GoalForecast` |
| `src/domain/catalog.ts` | `COLLECTION_KEYS` gains `'goals'`; `ID_PREFIX.goals = 'gol'` |
| `src/domain/records.ts` | `blankState()` gains `goals: []` — `migrate()` then loops it for free |
| `src/data/sqlite.ts` | `TABLES.goals = ['id', 'name', 'price', 'priority', 'boughtDate', 'notes']`; `TYPES` gains `price: 'INTEGER'` and `priority: 'INTEGER'` |

No change is needed in `backup.ts` (it iterates `COLLECTION_KEYS`) or in
`state/actions.ts` (`upsert` and `remove` are generic over `CollectionKey`). An
existing database picks the new table up because `applySchema()` runs
`CREATE TABLE IF NOT EXISTS` on every open. No index: goals are few and are never
filtered by date.

Two new settings. The settings table is key/value, so there is no migration:

- `forecastSpendingAuto: boolean` — default `true`, use the 3-month average
- `forecastSpending: Cents` — default 0, used when auto is off

## Screens

### The Goals tab

A new tab between **Accounts** and **Gold**: one entry in the `TabId` union and
`TAB_IDS` in `route.ts`, one in `TABS` in `Topbar.tsx`, one branch in `App.tsx`,
and a new `src/ui/tabs/Goals.tsx`.

```
Spare each month    On hand now      Next goal
    +9,000            10,600      RTX 5080 · Nov 2026

--- Your goals ------------------------------------------
   Goal          Price     Saved    Ready by
1  RTX 5080     45,000    10,600    Nov 2026   [==--------] 24%   ^ v  edit
2  New phone    20,000         0    Mar 2027   [----------]  0%   ^ v  edit
                                    + Add a goal

--- What this assumes -----------------------------------
   Recurring income               +18,000
   Recurring bills                 -5,700   not every month is the same
   Usual purchases                 -3,300   [x] average of last 3 months
                                            [    ] use my own figure
   ------------------------------------------------------
   Left over each month            +9,000

--- Month by month ------------------  [ 12 months | all ]
   period, in, bills, spend, surplus, balance — one row per month

--- Bought ----------------------------------------------
   Old GPU        12,000    bought 14 Feb 2026
```

- **Reordering is Move up / Move down buttons, not drag.** The app has no
  drag-and-drop anywhere, buttons are keyboard-accessible, and it is far less
  code. Move up is disabled on the first goal in the queue, move down on the last.
- **Marking a goal bought** sets `boughtDate` to today, drops it from the funding
  queue, and leaves it listed under **Bought**. The date is editable afterwards in
  the goal's own form, so a purchase entered late can be dated correctly.
- **The assumptions panel describes the next month**, which is the first row of
  the projection. Because bills of other frequencies make months differ, the
  bills line carries the note *not every month is the same* and the
  month-by-month table below is where the real figures are.
- The month-by-month table shows the next 12 months by default; the toggle
  switches to the full `HORIZON_MONTHS` horizon. This follows the `ScopeToggle`
  pattern the other tabs use for **All time**.
- The table has no **other** column. `other` is rare, so it is folded into the
  surplus figure, and the row carries it in its `title` when it is not zero.
- **This tab ignores the month picker in the top bar.** A forecast from a month
  in the past is meaningless; it always projects from the real current month.
  Every other tab follows the picker, so this exception is worth a comment in the
  file.
- Reuses `TargetProgress` from `Figure.tsx` for the progress bars, and the
  existing `Sheet` / `Table` / `Form` components throughout.

**The goal form is uncontrolled**, like every other form in the app: initial
values as `defaultValue`, read back off `form.elements` on submit, never `value`.
The browser suite fails if this is undone.

### The Dashboard

A **Goals** panel in the right-hand column under **Accounts**: each unbought
goal's name, its ready-by month, and a progress bar. Nothing else on the
Dashboard changes. The panel is hidden when there are no goals.

### The README

A **Goals** section in the tab table and a prose section next to **Accounts
hold the money**, explaining the surplus formula, that bills are charged in their
real month, and that goals are funded in order.

## Testing

**`test/domain.ts`** — the engine, without a browser:

- `cashOnHand(state, '9999-12')` equals `totalSavings(state)`
- `cashOnHand` respects the cut-off: a future-dated income row is excluded, and
  a bill paid late counts in the month it was *paid*, not the month it was due
- the starting line subtracts unpaid bills dated in or before the current month
- a yearly bill appears in its own month and in no other
- a hand-entered future bill is not also projected from its template
- a bill filed in a future month but already paid is not deducted twice
- assumed spending averages the last three complete months and ignores the
  current one, and divides by fewer months when the database is younger
- cumulative thresholds: goal 2's date accounts for goal 1's price
- a goal with no price never blocks a goal behind it
- a zero or negative surplus yields `reachedIn: ''`, not a date
- a goal already affordable reports `monthsAway: 0`
- writes return a new state object rather than editing the one passed in

**`test/roundtrip.ts`** — goals survive a JSON backup and restore, and the
SQLite write/read cycle, with `price` and `priority` coming back as numbers.

**`test/browser.mjs`** — the Goals tab renders, the add-goal form is uncontrolled
(typing survives an unrelated re-render), and move up/down changes the order.

## Error handling and empty states

- **No accounts and no templates** — the tab explains that goals need recurring
  income and bills set up first, and links to those tabs.
- **No goals yet** — the assumptions and the month-by-month table still render,
  because "how much will I have" is useful on its own.
- **Negative surplus** — a notice saying you are spending more than you earn, the
  monthly shortfall, and no dates on any goal.
- **Beyond the horizon** — "not within 5 years at this rate" instead of a date.
- A price or an override typed as something other than a number is treated as 0,
  matching how the other money fields already behave.

## Deliberately out of scope

Each of these is a decision, not an oversight:

- **No Goals sheet in the Excel export.** Everything in the workbook is recorded
  fact; a forecast is an assumption and would go stale inside the file.
- **No "want it by" date** on a goal. The app answers *when*; you do not tell it.
- **No per-goal account.** Goals draw on every account, as chosen above.
- **No automatic transfer into a pot.** A goal is a plan, not a movement of money.
- **Gold is not counted** toward goals. It is metal, not cash; selling it is a
  decision, not a forecast.
- **`savingsGoalRate` is left alone.** It is a rate target and a different idea.
- **No inflation or price-rise modelling.** Today's prices, today's bills.
