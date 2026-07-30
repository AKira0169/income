# Income Tracker

A personal money tracker that runs entirely in your browser, stores everything in
a real SQLite database, and exports a real Excel workbook. One file, no install,
no account, no internet connection, and nothing leaves your computer.

## Using it

Double-click **`income-tracker.html`**. That is the whole app — about 1 MB,
most of which is the SQLite engine compiled to WebAssembly.

Use Chrome or Edge. If the browser blocks local storage, a red warning appears
on every screen and you should export your data before closing the tab.

### What it tracks

| Tab | What goes in it |
| --- | --- |
| **Dashboard** | Month at a glance: income, bills, purchases, net, savings rate, a 6-month income-vs-spending chart, bills due soon, and progress against savings targets. |
| **Income** | Salary, freelance, rental, interest, bonuses, refunds — date, source, category, amount, how it arrived. |
| **Bills & Utilities** | Set up each recurring bill once (electricity, water, gas, internet, mobile, rent, council tax, insurance, subscriptions…), then generate that month's bills with one click and fill in what you were actually charged. |
| **Purchases** | One-off spending — groceries, fuel, clothes, electronics, travel. |
| **Savings** | Accounts and pots with optional targets, plus every deposit and withdrawal. Balances update automatically. |
| **Settings** | Currency, number format, savings goal, backup/restore, erase. |

### Bills are the part worth understanding

Utility costs change every month, so bills work in two layers:

1. **Recurring bill** — the standing definition: name, provider, how often,
   which day it is due, the typical amount.
2. **Monthly bill** — the actual charge. Press **Generate from recurring** at
   the start of each month and every due bill appears, pre-filled with the
   typical amount. When the real bill arrives, type the actual figure straight
   into the table and press **Mark paid**.

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
or everything. It contains ten sheets:

- **Summary** — headline totals, savings rate, and where the money went
- **Income**, **Bills**, **Recurring Bills**, **Purchases**
- **Utilities & Meters** — consumption and implied cost per unit
- **Savings Accounts**, **Savings Transactions**
- **Monthly Breakdown** — month-by-month with totals and monthly averages
- **Category Breakdown** — every category with its share of the total

Totals are live Excel formulas, so the numbers still add up if you edit rows in
Excel. Amounts carry your currency format, dates are real dates, and the data
sheets have filters and frozen headers.

### Where your data is kept

In a real **SQLite database**, running inside the page via WebAssembly. Tables:
`income`, `bills`, `billTemplates`, `purchases`, `accounts`, `savingsTx`,
`settings`. Money is stored as whole cents (`INTEGER`), so totals never drift.

The database is held in the browser's IndexedDB — not as a file on disk you can
see. Opening the app from `file://` rules out SQLite's usual persistent storage
(OPFS is blocked there), so the whole database is written back to IndexedDB
after every change. At this data size that takes about a millisecond.

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

`Store` holds the working copy in memory and takes a persistence adapter, so the
browser writes through to SQLite while the Node tests run the identical logic
against plain memory. Every save rewrites the tables in one transaction rather
than syncing row by row, which keeps the database exactly consistent with what
is on screen.

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
