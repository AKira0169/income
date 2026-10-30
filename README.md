# Income Tracker

A personal money tracker for income, bills, purchases, accounts, goals and
gold, with Excel export. It runs as a web app: sign up, and your records are
kept on the server under your account, separate from everyone else's.

The offline single-file version is retired. It is still available from the
`v1-offline` tag. Download a backup from it (**Settings → Download backup
(.json)**) and import that here under **Settings → Import backup (.json)**.

## Using it

Open the site, create an account with your email and a password, and you are
in. Under **Security** (top right) you can change your password, add an
authenticator app for two-factor sign-in, and get backup codes. The app sends
no email, so there is no "forgot your password" link: whoever runs the server
resets a forgotten password (see [deploy/README.md](deploy/README.md)).

It starts in Egyptian pounds (`E£` / `EGP`). Change that, and the number
format, under **Settings → Currency & goals**.

To run your own copy on a server, see [deploy/README.md](deploy/README.md).

### What it tracks

| Tab | What goes in it |
| --- | --- |
| **Dashboard** | Month at a glance: income, bills, purchases, net, savings rate, a 6-month income-vs-spending chart, bills due soon, and progress against savings targets. |
| **Income** | Set your salary and any other regular payment up **once**; each new month it is entered for you. One-off money — freelance, refunds, gifts — you add as it arrives. |
| **Bills & Utilities** | Set up each recurring bill once (electricity, water, gas, internet, mobile, rent, council tax, insurance, subscriptions…) and every month fills itself in, pre-filled with the typical amount, ready for you to correct to what you were actually charged. |
| **Purchases** | One-off spending — groceries, fuel, clothes, electronics, travel. |
| **Accounts** | Every place money sits: the card the salary lands on, the one you save into, cash, pots with targets. Each card shows where its balance came from — income in, purchases and paid bills out, transfers between them. Also what you owe, and a **Reconcile** button for when the app and the bank disagree. |
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

The tab and the month are in the address — `https://…/bills/2026-07`. Reload
and you land back on the same screen in the same month; back and forward step
through the months you have looked at; and a month of a tab can be bookmarked.

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

### Money you owe

Borrowed money is the one thing that breaks every figure above: it is in your
account, so the balance is right, but it is not yours, so the total, the savings
rate and every goal are wrong by exactly that much.

**Accounts → Money you owe → Record a debt.** Say who lent it to you, how much,
and which account it landed in. That account goes up by the full amount — it
really did — and the same sum is recorded as owed. What you are worth does not
move at all, which is the honest answer: you are no richer for having borrowed.

From then on it takes care of itself. The projection starts from what is yours
rather than what is in the bank, so a goal is never funded out of a loan and the
Goals tab never promises you a month it cannot deliver. It is not counted as
saving either, even when the money lands in a savings pot.

**Repay** takes the money out of whichever account you paid from and off what you
owe, in one step. Each card shows how deep it went, how much is behind you and
what is left, and reads *Settled* the moment it reaches zero. **Borrow more**
adds to the same debt rather than opening a second one.

A debt is an ordinary account, held with a negative balance — you can rename it,
add notes, and see every borrowing and repayment in the movements list below,
where they can be edited or deleted like anything else. Deleting the debt removes
its movements with it, and your balances go back up by what you still owed.

### When the app and the bank disagree

Small spending nobody enters — a coffee, a tip, a top-up, twenty card taps —
adds up, and after a few months the balance on the card is not the balance in the
bank. There is no entry that fixes that, which is where most trackers quietly
stop being true.

**Reconcile**, on any account card, is that entry. Read the real balance off your
bank and type it in. The dialog shows what the app says, what you say, and the
difference, before anything is written; saving records the one row that closes
the gap:

- **Money missing** — spending that was never entered. Filed as a purchase under
  *Adjustment*, which means your usual monthly spending starts including it. That
  is deliberate: if the app keeps finding you a few hundred short, a few hundred a
  month is what you actually spend, and a forecast built on the entered figure
  alone would keep promising money that never arrives.
- **Money over** — something that arrived and was never recorded. Filed as income
  under *Adjustment*.
- **Already agreed** — nothing is written at all.

It is a real record, not a hidden fudge on the account: it sits in its month's
history, totals under its own category, and can be edited or deleted if the
receipt it stood in for turns up later.

> **Record borrowed money first.** A loan you have not entered is already sitting
> in the bank's figure, so reconciling before recording it would absorb the whole
> sum as income you never earned. The dialog says so whenever the difference runs
> your way.

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
  A goal you bought is left out of that average: it is a purchase, but it is not
  a habit, and averaging one in would raise your supposed spending by a third of
  its price for three months and push every goal behind it out for no reason.
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

The forecast itself writes nothing: it reads your recurring set-up and returns
numbers. **Bought** does write, because buying something is not a status change
— it asks the date, what you actually paid and which account it came out of,
shows what you would have left before you commit, and then records a purchase.
The goal moves to the **Bought** list, the queue closes up behind it, and every
balance in the app drops by what you paid.

Clearing the "Bought on" date puts the money back by removing that purchase, so
a mistake is undoable. Deleting the goal does not: the purchase stays, orphaned,
because tidying a wishlist is not a refund.

### Gold

Gold is quoted worldwide in dollars per troy ounce. Once a day the server fetches
that figure and the pound rate, divides by 31.1034768 and multiplies out — which
gives the **bourse** price, a little under what a shop quotes. A premium closes
that gap; it starts at 2%, which is what the Cairo boards were running over spot
when this was calibrated. If it ever drifts, type the shop's own price in and
nothing is fetched at all.

Karat is a fraction of pure: 21k is 21 parts in 24, so 87.5% of the 24k price.
Every reading is kept, so the price history is a series you can chart or export.

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

In Postgres on the server, in tables named after the lists you see — income,
bills, purchases, accounts and so on — with every row tagged with your
account. Money is stored as whole minor units (`BIGINT`), so totals never
drift. Every query the server runs names your account, and the database
itself refuses to show one account's rows to another (row-level security).

### Back up your data

**Settings → Download backup (.json)** is your whole record set in one file,
and **Import backup (.json)** reads it back — replacing what is there. The
Excel file is a report, not a backup.

## Working on the code

```
pnpm install       # once
pnpm test          # typecheck + the Node suites (no database needed)
pnpm db:test:up    # a throwaway Postgres on 127.0.0.1:55439
pnpm test:db       # schema, repository, api and gold-price suites against it
pnpm build         # dist/web
pnpm stack:dev     # the whole stack at https://localhost
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
