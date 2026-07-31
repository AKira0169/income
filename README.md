# Income Tracker

A personal money tracker that runs entirely in your browser, stores everything in
a real SQLite database, and exports a real Excel workbook. One file, no install,
no account, and nothing leaves your computer.

It works fully offline. The one exception is the gold price, which is fetched
once a day if you keep gold — two small public endpoints, no key, no account, and
nothing sent but the request itself. Switch it off under **Gold → Price settings**
and the app never touches the network at all.

## Running it

Double-click **`income-tracker.html`**. That is the whole app — about 1 MB, most
of which is the SQLite engine compiled to WebAssembly. There is no server to
start, nothing to install, and your records persist between sessions.

Use Chrome or Edge. If the browser blocks local storage, a red warning appears
on every screen and you should export your data before closing the tab.

It starts in Egyptian pounds (`E£` / `EGP`). Change that, and the number format,
under **Settings → Currency & goals**.

### As a desktop app

To get it out of a browser tab and into its own window — no address bar, no tabs,
its own taskbar button — run this once:

```
powershell -ExecutionPolicy Bypass -File make-shortcut.ps1
```

That puts an **Income Tracker** shortcut on your Desktop, with its own icon.
Still no install: the shortcut just starts Chrome (or Edge) in app mode against
the local file, so the app stays exactly as portable as it was. Right-click its
taskbar button and choose *Pin to taskbar* to keep it there. Re-run the script
if you move the folder — the shortcut stores absolute paths.

### What it tracks

| Tab | What goes in it |
| --- | --- |
| **Dashboard** | Month at a glance: income, bills, purchases, net, savings rate, a 6-month income-vs-spending chart, bills due soon, and progress against savings targets. |
| **Income** | Set your salary and any other regular payment up **once**; each new month it is entered for you. One-off money — freelance, refunds, gifts — you add as it arrives. |
| **Bills & Utilities** | Set up each recurring bill once (electricity, water, gas, internet, mobile, rent, council tax, insurance, subscriptions…) and every month fills itself in, pre-filled with the typical amount, ready for you to correct to what you were actually charged. |
| **Purchases** | One-off spending — groceries, fuel, clothes, electronics, travel. |
| **Accounts** | Every place money sits: the card the salary lands on, the one you save into, cash, pots with targets. Each card shows where its balance came from — income in, purchases and paid bills out, transfers between them. |
| **Goals** | What you are saving up for, and the month you will be able to afford each one. Funded in order: the second goal starts once the first is covered. Also answers the other half of the question — how much you will have in any month over the next five years. |
| **Gold** | Grams held by karat, valued against the live Egyptian price, with what you paid beside what it is worth now. |
| **Settings** | Currency, number format, savings goal, backup/restore, erase. |

### Every list has a history

Each list opens on the month in the picker, because that is the month you are
working on. The **All time** switch in its heading turns the same list into the
full history — every entry you have ever made, broken by month with a total on
each heading. It is there on income, bills, purchases, movements and gold.

An entry dated outside the month on screen is not lost, either: save it and the
app follows it to its own month rather than letting it disappear.

### The address bar remembers where you were

The tab and the month are in the URL — `…income-tracker.html#/bills/2026-07`.
Reload and you land back on the same screen in the same month; the back and
forward buttons step through the months you have looked at; and a particular
month of a particular tab can be bookmarked like any other page.

### Accounts hold the money

An account is not only a savings pot — it is anywhere money sits. Add the card
your salary is paid onto and the account you save into, then point each entry at
one:

- **Income** says which account it was *paid into*
- **Bills** and **purchases** say which account they were *paid from*
- **Movements** move money *between* two accounts, or in and out from elsewhere
- **Gold** comes out of the account that paid for it

A balance is then arithmetic you can check: opening, plus income, plus what was
moved in, less purchases, paid bills, gold and what was moved out. A bill that is
not yet paid does not come off the balance — it is a commitment, not a
withdrawal, and taking it off early would make the figure disagree with the bank.

Set the account once on a *recurring* income or bill and every month it generates
carries it too.

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

The plot draws those same numbers rather than restating them. Each goal is a
band as tall as its price, stacked in funding order, so the bands add up to the
whole queue and the height of one is the reason it is far off; the line is the
projected balance climbing through them. A goal is yours where the line clears
the top of its band, which is where its mark sits — numbered with its place in
the list underneath.

Nothing here writes anything: the forecast reads your recurring set-up and
returns numbers. Marking a goal as bought files it under **Bought** with the
date, and the queue closes up behind it.

### Gold

Gold is quoted worldwide in dollars per troy ounce. Once a day the app fetches
that figure and the pound rate, divides by 31.1034768 and multiplies out — which
gives the **bourse** price, a little under what a shop quotes. A premium closes
that gap; it starts at 2%, which is what the Cairo boards were running over spot
when this was calibrated. If it ever drifts, type the shop's own price in and
nothing is fetched at all.

Karat is a fraction of pure: 21k is 21 parts in 24, so 87.5% of the 24k price.
Every reading is kept, so the price history is a series you can chart or export
even when you are offline.

### The date fields

The browser's own date input is not used anywhere. Type the date however you
write it — `5/8`, `5-8-26`, `5.8.2026`, `05082026`, `2026-08-05`, or just `5` for
the fifth of the month already in the box — or press the calendar and pick.
Arrow keys move a day, Page Up and Down move a month, Enter picks. The week
starts on Saturday.

### Set it once — the part worth understanding

The money that repeats is the money you should never have to retype. Income and
bills both work in two layers:

1. **The recurring definition** — set up once, under *Recurring income* on the
   Income tab or *Recurring bills* on the Bills tab. What it is, how often, which
   day of the month, the usual amount.
2. **The monthly entry** — the actual figure. Every time you open the app it
   brings the current month up to date automatically, so your salary is already
   there and each bill is waiting, pre-filled with the typical amount. When the
   real bill arrives, type the actual figure straight into the table and press
   **Mark paid**.

You are still in charge of what is on the page. Nothing is generated for a month
before you set the item up, nothing is generated ahead of today, and an entry you
delete stays deleted — each definition remembers how far it has been taken, so
revisiting a month never resurrects a row you removed on purpose. Miss a few
months and the next visit fills in every one you missed, up to two years back.

Generated rows are labelled **Recurring**, so you can always tell what the app
filled in from what you entered by hand. **Generate from recurring** is still
there on both tabs for filling a specific month on demand, and the whole thing
can be switched off under **Settings → Fill in recurring entries automatically**.

Electricity, water and gas also take a **units** reading (kWh or m³). Enter it
and the workbook works out your real cost per unit month over month — so you can
see whether a bigger bill means higher prices or higher usage.

Bills can be monthly, bi-monthly, quarterly, half-yearly, yearly or one-off, and
each only generates in the months it is actually due. Because a £600 yearly
insurance premium is not a £600 monthly cost, both the app and the workbook also
show a **cost per month** — each bill spread across the year — so you can see
what your recurring commitments really come to.

### Excel export

**Export to Excel** produces an `.xlsx` for the current month, the current year,
or everything. It contains twelve sheets:

- **Summary** — headline totals, your recurring set-up per month, savings rate,
  gold, and where the money went
- **Income**, **Recurring Income**, **Bills**, **Recurring Bills**, **Purchases** —
  each row saying which account it moved
- **Utilities & Meters** — consumption and implied cost per unit
- **Savings Accounts** — every balance broken into the flows that built it
- **Savings Transactions**
- **Gold** — what was bought and sold, what is held, and the daily price series
- **Monthly Breakdown** — month-by-month with totals and monthly averages
- **Category Breakdown** — every category with its share of the total

Totals are live Excel formulas, so the numbers still add up if you edit rows in
Excel. Amounts carry your currency format, dates are real dates, and the data
sheets have filters and frozen headers.

### Where your data is kept

In a real **SQLite database**, running inside the page via WebAssembly. Tables:
`income`, `incomeTemplates`, `bills`, `billTemplates`, `purchases`, `accounts`,
`savingsTx`, `gold`, `goldPrices`, `settings`. Money is stored as whole cents (`INTEGER`), so totals
never drift.

The database is held in the browser's IndexedDB — not as a file on disk you can
see. Opening the app from `file://` rules out SQLite's usual persistent storage
(OPFS is blocked there), so the whole database is written back to IndexedDB
after every change. At this data size that takes about a millisecond.

**Open it the same way every time.** IndexedDB is keyed to the origin, and
`file:///…/income-tracker.html` and `http://127.0.0.1:5500/income-tracker.html`
are two different origins with two separate databases. Data entered one way is
invisible the other way — it is not lost, just filed under the address you were
using.

If you have been opening it through a local server and want to switch to
double-clicking, carry the data across yourself:

1. On the server address, **Settings → Download backup (.json)**.
2. Open the app the new way, then **Settings → Restore from .json** and pick
   that file.

It has to be the `.json`. The `.db` download is a copy of the database for other
SQLite tools, and the `.xlsx` is a report — neither is what **Restore** reads.

**Settings → Query your data** opens a read-only SQL console, so you can ask
things the app doesn't have a screen for:

```sql
SELECT strftime('%Y', date) AS year, category, SUM(amount)/100.0 AS total
FROM purchases GROUP BY year, category ORDER BY total DESC;
```

### Back up your data

Clearing browsing data, switching browser, or moving to another machine will
lose everything. Back up regularly, from **Settings → Your data**:

- **Download database (.db)** — the whole SQLite file. Opens in DB Browser for
  SQLite, Python, R, Node, Datasette, or anything else that reads SQLite.
- **Download backup (.json)** — the format **Restore** reads back.

Restore only works from the JSON. The Excel file is a report, not a backup.

## Working on the code

`income-tracker.html` is generated and not committed. The source is TypeScript
under `src/`, bundled by esbuild into the single page:

```
pnpm install     # once — Preact, esbuild, typescript, and the test tooling
pnpm build
pnpm dev         # watch mode on http://localhost:5173, with live reload
```

The **shipped page has nothing to install**: nothing is fetched at run time, and
the only third-party code in it is Preact and the SQLite engine in `vendor/`,
both bundled in. The toolchain is a build-time dependency — esbuild is required
to build at all, which is a deliberate trade for real modules and real types.

`pnpm dev` serves exactly what `pnpm build` writes, including the base64 wasm
inlined into the page, so `initSqlite()` — the hardest part of the app to test —
takes the same route in development as in the file you actually open. Note that
`http://localhost` is a different storage origin from `file://`, so anything you
enter in dev is a separate database from your real data.

| File | Role |
| --- | --- |
| `src/domain/` | The whole rule set, pure: no DOM, no browser APIs, no signals |
| `src/data/sqlite.ts` | SQLite schema, read/write, IndexedDB persistence, SQL console |
| `src/data/gold-price.ts` | The daily price fetch — the only code here that uses the network |
| `src/workbook/xlsx.ts` | Dependency-free `.xlsx` writer — ZIP container plus SpreadsheetML |
| `src/workbook/build.ts` | Builds the workbook from a state object |
| `src/state/` | The signal, the writes, and hash routing |
| `src/ui/` | `App.tsx`, `Topbar.tsx`, shared `components/`, and one component per tab |
| `src/main.tsx` | Bundle entry point; also publishes the `__app` console handle |
| `src/app.css` | The Paper design system |
| `src/shell.html` | Page shell the build inlines everything into |
| `vendor/` | sql.js 1.13.0 (MIT) — SQLite compiled to WebAssembly |
| `make-icon.mjs` | Draws `income-tracker.ico` from the same mark as the favicon |
| `make-shortcut.ps1` | Puts the app-mode shortcut on the Desktop |

#### How a change reaches the screen

`src/domain/` holds every rule and knows nothing about how it is displayed.
Selectors take the state as their first argument and return figures; writes take
the state and return the **next** state rather than editing the one they were
given. Nothing in there imports anything above it, which is why the Node suite
can test the whole rule set without a browser.

`src/state/app.ts` holds that state in one signal. `src/state/actions.ts` is the
only thing that writes it: call the domain function, put the result in the
signal, and let the save batch itself into a microtask. Everything reading
`app.value` re-renders, and the DOM is diffed rather than rebuilt — which is what
keeps focus, the caret, the scroll position and an open dialog exactly where they
were while you are typing into a table.

That is also why the domain returns new objects rather than editing in place. A
signal compares with `===`; a write that edited the state it was handed would
notify nobody, and the screen would quietly disagree with the data. `test/domain.ts`
asserts that property directly.

**Forms are uncontrolled, and that is load-bearing.** Initial values go in as
`defaultValue` / `defaultChecked` / a `selected` option — never `value` — and are
read back off `form.elements` on submit. Preact rewrites a `value` prop on every
render, so a form that renders `value={initial}` while reading the DOM on submit
eats what the user typed the moment anything else redraws the page. Something
always does: the gold price arrives from the network a second after boot. The
full reasoning is at the top of `src/ui/components/Form.tsx`, and the browser
suite has a check that fails if it is undone.

Two typecheck projects, because the two halves run in different places:
`tsconfig.json` covers `src/` with the DOM but **without** Node's globals, so a
stray `node:fs` import fails at the type level rather than inside the built page;
`tsconfig.test.json` covers the tests and the build scripts, which are Node.
Node's type-stripping does not handle JSX at all, so `test/` stays JSX-free and
the components are covered by the browser suite instead.

`income-tracker.ico` is committed, so `make-icon.mjs` only needs running if the
mark in `src/shell.html` changes. It rasterises the shape from its own geometry
and writes the ICO container by hand — same approach as the XLSX writer, and for
the same reason: no dependency is worth the install.

Keep `make-shortcut.ps1` pure ASCII. Windows PowerShell 5.1 reads a `.ps1`
without a BOM as ANSI, and a UTF-8 em dash decodes into a character PowerShell
treats as a quote — which breaks the parse a long way from the actual line.

Persistence is injected, so the browser writes through to SQLite while the Node
tests run the identical logic against plain memory. Every save rewrites the
tables in one transaction rather than syncing row by row, which keeps the
database exactly consistent with what is on screen — and writes made in one turn
are coalesced into a single save, so bringing two years of recurring entries up
to date costs one rewrite rather than dozens.

The column lists in `src/data/sqlite.ts` are the schema. `CREATE TABLE IF NOT EXISTS`
does not widen a table that already exists, so on start-up `migrateColumns()`
compares each list against `PRAGMA table_info` and `ALTER TABLE … ADD COLUMN`s
whatever is missing. Adding a field is therefore one edit to a column list —
without that step, `readAll()` names a column that is not there yet and an
existing database refuses to open.

Money is stored everywhere as an integer number of cents, so totals never drift
by a penny.

### Design

`src/app.css` implements the **Paper** design system: paper ground, ink text,
hairline rules, no boxes inside boxes. Type scale 14/16/18/24/32/40; spacing
4/8/12/16/24/32; money and dates set in a monospace face so columns line up like
a ledger. Colour carries meaning only — status, and nothing else.

Two deliberate deviations, both noted in the CSS:

- The fonts are stacks (`Roboto`, `Montserrat`, `PT Mono` first, system faces
  after). Embedding three families would add several hundred KB on top of the
  SQLite engine, and the page must work with no network.
- The raw `success`, `warning` and `secondary` tokens fail WCAG AA as text on
  white (3.0–3.6:1), so text uses darker `--ink-*` variants and the raw tokens
  are kept for dots and fills. Accessibility over exact token reuse.

### Tests

```
pnpm test:full
```

That runs everything: the typecheck, the Node suites, and the browser suite.

`pnpm test` is the fast half — typecheck plus the Node suites.

- `test/domain.ts` covers the rules that used to be a caller's job to remember:
  that a bill derives its month and its paid status from its own dates, that a
  settings write replaces the settings object, that saves batch, and that every
  write returns a new state object rather than editing one. It also covers the
  six date formats and the two-digit-year rule.
- `test/roundtrip.ts` and `test/export.ts` write real workbooks and read them
  back with SheetJS as an oracle, confirming the bytes are a valid `.xlsx` —
  including non-ASCII text, emoji, XML metacharacters, negative amounts and
  pre-2000 dates, which are what break hand-rolled ZIP writers. They also check
  money parsing, monthly summaries, account balances and recurring generation.

`pnpm test:browser` builds the page and drives it from a real `file://` origin in
headless Chrome, which is the half Node cannot reach: SQLite compiled to WASM,
IndexedDB, the DOM, and the `Blob` path the download buttons use. It enters a
record through the actual form, reloads, and reads it back out of SQLite; it
checks hash routing across a reload and the back button, the date field's
keyboard behaviour, that every tab draws with data in it, that the exported `.db`
carries a real SQLite header, that the SQL console refuses a write, and that
nothing logged an error. It needs Chrome or Edge installed — set `CHROME_PATH` to
choose one — and skips itself with a message if neither is found.

Two of its checks are there for regressions that are otherwise invisible:

- **Editing a bill amount in place** asserts the input is the *same DOM node*
  afterwards, still focused, with the scroll unmoved. Node identity, because only
  identity tells a diff from a lucky rebuild.
- **A half-typed form surviving a write from elsewhere** is the `value`-vs-
  `defaultValue` trap above. It types into an open form, makes a write from
  outside it, and checks the text is still there — and separately checks the form
  really did redraw, so it cannot pass by nothing having happened.

Open `file://` rather than a local server for this: they are different origins
with different databases, and the app is only ever opened the first way.

### The `__app` console handle

The built page exposes `__app` in the browser console — the live state, the
account balances, the SQL console, and the workbook builder. It is what makes
the browser suite possible, and it is useful for asking questions of your own
data. It widens nothing: Settings already offers a read-only SQL console and
hands over the whole database on request, and there is no server and no second
origin here for it to expose anything to.
