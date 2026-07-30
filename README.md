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
| **Gold** | Grams held by karat, valued against the live Egyptian price, with what you paid beside what it is worth now. |
| **Settings** | Currency, number format, savings goal, backup/restore, erase. |

### Every list has a history

Each list opens on the month in the picker, because that is the month you are
working on. The **All time** switch in its heading turns the same list into the
full history — every entry you have ever made, broken by month with a total on
each heading. It is there on income, bills, purchases, movements and gold.

An entry dated outside the month on screen is not lost, either: save it and the
app follows it to its own month rather than letting it disappear.

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

`income-tracker.html` is generated. Edit the files in `src/` and rebuild:

```
node build.mjs
```

| File | Role |
| --- | --- |
| `src/xlsx.js` | Dependency-free `.xlsx` writer — ZIP container plus SpreadsheetML |
| `src/store.js` | Data model and all derived figures; persistence is injected |
| `src/sqlite.js` | SQLite schema, read/write, IndexedDB persistence, SQL console |
| `src/export.js` | Builds the workbook from the stored data |
| `src/ui.js` | Rendering and interaction |
| `src/app.css` | The Paper design system |
| `src/shell.html` | Page shell the build inlines everything into |
| `vendor/` | sql.js 1.13.0 (MIT) — SQLite compiled to WebAssembly |
| `make-icon.mjs` | Draws `income-tracker.ico` from the same mark as the favicon |
| `make-shortcut.ps1` | Puts the app-mode shortcut on the Desktop |

`income-tracker.ico` is committed, so `make-icon.mjs` only needs running if the
mark in `src/shell.html` changes. It rasterises the shape from its own geometry
and writes the ICO container by hand — same approach as the XLSX writer, and for
the same reason: no dependency is worth the install.

Keep `make-shortcut.ps1` pure ASCII. Windows PowerShell 5.1 reads a `.ps1`
without a BOM as ANSI, and a UTF-8 em dash decodes into a character PowerShell
treats as a quote — which breaks the parse a long way from the actual line.

`Store` holds the working copy in memory and takes a persistence adapter, so the
browser writes through to SQLite while the Node tests run the identical logic
against plain memory. Every save rewrites the tables in one transaction rather
than syncing row by row, which keeps the database exactly consistent with what
is on screen.

The column lists in `src/sqlite.js` are the schema. `CREATE TABLE IF NOT EXISTS`
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
npm run test:full
```

That installs SheetJS as a throwaway parser, writes real workbooks, and reads
them back to confirm the bytes are a valid `.xlsx` — including non-ASCII text,
emoji, XML metacharacters, negative amounts and pre-2000 dates, which are what
break hand-rolled ZIP writers. It also checks money parsing, monthly summaries,
account balances and recurring-bill generation.

`npm test` runs the same suite but skips the parser checks if SheetJS is not
installed.

The browser half is verified separately by driving the built file from a real
`file://` origin in headless Chrome: it boots, writes records, and the data is
read back out of SQLite after a reload. The exported `.db` is then opened with
Node's built-in SQLite — a different implementation from the one that wrote it —
and passes `PRAGMA integrity_check`.
