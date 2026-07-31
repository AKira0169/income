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
import { withCollection } from './records.ts';
import { billCashDate, cashOnHand, purchasesIn, sum } from './selectors.ts';
import type {
  AppState, Cents, Forecast, ForecastMonth, ForecastOptions, Goal, GoalForecast, Id, Period
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

  /* From here down every flow is counted in total, unlike `cashOnHand` above,
     which sums per account and so drops a row whose accountId names no
     account or one since deleted. Both are deliberate: the projection is
     answering "how much cash moves", which an orphaned row still does, while
     cashOnHand is answering "what does the bank say", which it cannot.
     Filtering the projection down to known accounts would stop counting a
     purchase that arguably should still move a forecast. */
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
      /* Bucketed by cash date — the same reading cashOnHand takes — not by
         `period`, the due month, which can disagree with it once a bill is
         paid early or late. An unpaid bill's cash date is its due date, so the
         ordinary case is unchanged. `|| b.period` covers a bill with neither
         date: periodOf('') is '', which would otherwise match no month and
         drop the bill rather than land it in its own period. */
      const cashPeriod = periodOf(billCashDate(b)) || b.period;
      if (cashPeriod !== period) continue;
      bills += b.amount || 0;
    }
    for (const tpl of state.billTemplates) {
      if (!occursIn(tpl, period)) continue;
      // Suppressed by b.period, the month the occurrence belongs to, even
      // though its cash is charged above in the month it moved — deliberate.
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
  // to === from (delta 0) is a value no-op too: identity has to hold here as
  // much as at the ends, or the signal redraws and the database is rewritten
  // for nothing.
  if (to === from || to < 0 || to >= queue.length) return state;

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
