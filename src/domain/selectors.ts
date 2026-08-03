/* domain/selectors.ts — every derived figure the screens and the workbook read.

   All read-only, and all take the state as their first argument rather than
   reaching for a module-level one. That is what makes them unit-testable
   without a browser, and what lets the UI hold the state in a signal without
   these knowing anything about it. */

import { DEBT_TYPE, SAVINGS_TYPES } from './catalog.ts';
import { byId } from './records.ts';
import { billIsOverdue } from './recurring.ts';
import { currentPeriod, isoOf, periodOf, shiftPeriod } from './period.ts';
import type {
  Account, AccountFlows, AppState, Bill, Category, CategoryTotal, Cents,
  CollectionKey, DebtSummary, Id, IncomeEntry, IsoDate, MonthSummary, Period,
  Purchase, SavingsMovement, SavingsTx, UpcomingBill
} from './types.ts';

export function sum<T>(list: readonly T[], pick: (item: T) => number): Cents;
export function sum(list: readonly number[]): Cents;
export function sum<T>(list: readonly T[], pick?: (item: T) => number): Cents {
  return list.reduce<number>((acc, item) => acc + (pick ? pick(item) : Number(item)), 0);
}

/* ---------------------------------------------------- one month at a time */

export const incomeIn = (state: AppState, period: Period): IncomeEntry[] =>
  state.income.filter((r) => periodOf(r.date) === period);

export const purchasesIn = (state: AppState, period: Period): Purchase[] =>
  state.purchases.filter((r) => periodOf(r.date) === period);

export const billsIn = (state: AppState, period: Period): Bill[] =>
  state.bills.filter((r) => r.period === period);

export const savingsTxIn = (state: AppState, period: Period): SavingsTx[] =>
  state.savingsTx.filter((r) => periodOf(r.date) === period);

/* --------------------------------------------------------------- accounts */

export function isSavingsAccount(account: Account | null | undefined): boolean {
  return !!account && SAVINGS_TYPES.includes(account.type);
}

/** Money you owe rather than money you have. Its balance runs negative. */
export function isDebtAccount(account: Account | null | undefined): boolean {
  return !!account && account.type === DEBT_TYPE;
}

/** The ones holding money, in the order they were added. */
export const heldAccounts = (state: AppState): Account[] =>
  state.accounts.filter((a) => !isDebtAccount(a));

export const debtAccounts = (state: AppState): Account[] =>
  state.accounts.filter(isDebtAccount);

/** The account's own name, or '' when it has been deleted. Used by both the
    screens and the workbook, which is why it lives here rather than in either. */
export function accountName(state: AppState, id: Id | '' | null | undefined): string {
  return byId(state, 'accounts', id)?.name ?? '';
}

/* Debts are skipped by both defaults below. A debt account can legitimately be
   chosen — spending the lender's money straight out of it is a real thing that
   correctly deepens what you owe — but it must never be what a blank form
   proposes, or an ordinary purchase would quietly land on the loan. */

/** The account you last used for this kind of record. Nearly every entry goes
    to the same place as the one before it, so this is the right default. */
export function lastAccountFor(state: AppState, collection: CollectionKey): Id | '' {
  const list = state[collection] as ReadonlyArray<{ accountId?: Id | '' }>;
  for (let i = list.length - 1; i >= 0; i--) {
    const id = list[i]?.accountId;
    const account = id ? byId(state, 'accounts', id) : null;
    if (account && !isDebtAccount(account)) return id as Id;
  }
  return heldAccounts(state)[0]?.id ?? '';
}

/** Where money put aside tends to go: the first savings-type account. */
export function defaultSavingsAccount(state: AppState): Id | '' {
  const held = heldAccounts(state);
  const pot = held.find(isSavingsAccount) ?? held[0];
  return pot?.id ?? '';
}

/* When a bill actually moves money. `paidDate || dueDate` rather than
   `paidDate` alone because a paid bill can carry an empty paid date, and
   periodOf('') is '', which sorts before every real period — such a bill would
   otherwise count as paid in the distant past. One helper rather than the
   expression twice, so the balance and the projection cannot drift apart. */
export const billCashDate = (
  bill: { paidDate?: IsoDate | ''; dueDate?: IsoDate | '' }
): IsoDate => bill.paidDate || bill.dueDate || '';

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

/* Every account added together, debts included — so this is what you are worth
   across them, not what you could spend. A debt's balance is negative, which is
   the whole reason it can be an ordinary account: it takes itself off here
   without a rule written to say so. `accountsHeld` is the other half of the
   question, and the two differ by exactly `debtOwed`. */
export function totalSavings(state: AppState): Cents {
  return sum(state.accounts, (a) => accountBalance(state, a.id));
}

/** What is actually sitting in your accounts, before anything owed is taken
    off. */
export function accountsHeld(state: AppState): Cents {
  return sum(heldAccounts(state), (a) => accountBalance(state, a.id));
}

/** What you still owe, as a positive figure. Zero when you owe nothing. */
export function debtOwed(state: AppState, throughPeriod?: Period): Cents {
  return -sum(debtAccounts(state), (a) => accountBalance(state, a.id, throughPeriod));
}

/* One debt broken into the two things you want to see: how deep it went and how
   much of it you have paid back. Both are read off the same flows the balance
   is, so `borrowed − repaid` is the balance by construction and the card cannot
   show a total its own lines disagree with.

   Which flow lands on which side is decided by direction, not by name: money
   out of the lender's account deepens the debt whether it went to your card or
   straight to a shop, and money into it pays the debt down. */
export function debtSummary(state: AppState, account: Account): DebtSummary {
  const f = accountFlows(state, account.id);
  const borrowed = f.savedOut + f.purchases + f.bills + f.gold + Math.max(0, -f.opening);
  const repaid = f.savedIn + f.income + Math.max(0, f.opening);
  const owed = borrowed - repaid;
  return { account, borrowed, repaid, owed, settled: owed <= 0 };
}

export const debtSummaries = (state: AppState): DebtSummary[] =>
  debtAccounts(state).map((a) => debtSummary(state, a));

/* Every account added together, as of the end of `throughPeriod`. Summed per
   account rather than over the raw tables so that transfers cancel out and a
   record pointing at a deleted account is excluded — the same way totalSavings
   already excludes it. */
export function cashOnHand(state: AppState, throughPeriod: Period): Cents {
  return sum(state.accounts, (a) => accountBalance(state, a.id, throughPeriod));
}

/* Only the pots. The current account holding this month's salary is a balance,
   not savings, and mixing the two flatters the figure. */
export function savingsBalance(state: AppState): Cents {
  return sum(state.accounts.filter(isSavingsAccount), (a) => accountBalance(state, a.id));
}

/* Which way a movement pushes money relative to your savings. A transfer
   between two pots, or between two spending accounts, is neither. */
export function savingsMovement(state: AppState, tx: SavingsTx): SavingsMovement {
  const amount = tx.amount || 0;
  const to = byId(state, 'accounts', tx.accountId);
  const from = byId(state, 'accounts', tx.fromAccountId);

  /* A debt on either leg is neither. Borrowing is not saving even when the
     money lands in a pot — left in, a loan paid into an emergency fund would
     report a month where you put the whole sum aside, on money that is not
     yours. Paying it back is not raiding the pot either: both legs move what
     you own against what you owe, which is not what you did with this month's
     pay, and the savings rate is only ever asking the second question. */
  if (isDebtAccount(to) || isDebtAccount(from)) return { in: 0, out: 0 };

  if (tx.direction === 'transfer') {
    const into = isSavingsAccount(to);
    const outOf = isSavingsAccount(from);
    if (into && !outOf) return { in: amount, out: 0 };
    if (outOf && !into) return { in: 0, out: amount };
    return { in: 0, out: 0 };
  }
  if (!isSavingsAccount(to)) return { in: 0, out: 0 };
  return tx.direction === 'out' ? { in: 0, out: amount } : { in: amount, out: 0 };
}

/* ---------------------------------------------------------------- rollups */

export function summary(state: AppState, period: Period): MonthSummary {
  const income = sum(incomeIn(state, period), (r) => r.amount);
  const bills = billsIn(state, period);
  const billsTotal = sum(bills, (r) => r.amount);
  const billsPaid = sum(bills.filter((b) => b.status === 'paid'), (r) => r.amount);
  const purchases = sum(purchasesIn(state, period), (r) => r.amount);
  const tx = savingsTxIn(state, period);
  const savedIn = sum(tx, (t) => savingsMovement(state, t).in);
  const savedOut = sum(tx, (t) => savingsMovement(state, t).out);
  const spent = billsTotal + purchases;

  return {
    period,
    income,
    bills: billsTotal,
    billsPaid,
    billsOutstanding: billsTotal - billsPaid,
    billCount: bills.length,
    overdueCount: bills.filter((b) => billIsOverdue(b)).length,
    purchases,
    spent,
    net: income - spent,
    savedIn,
    savedOut,
    savedNet: savedIn - savedOut,
    savingsRate: income > 0 ? (savedIn - savedOut) / income : 0
  };
}

export function groupByCategory(
  records: ReadonlyArray<{ category?: Category; amount?: Cents }>
): CategoryTotal[] {
  const totals = new Map<Category, Cents>();
  for (const r of records) {
    const key = r.category || 'Uncategorised';
    totals.set(key, (totals.get(key) ?? 0) + (r.amount ?? 0));
  }
  return [...totals.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/** Periods that hold any record at all, newest first. */
export function activePeriods(state: AppState): Period[] {
  const periods = new Set<Period>();
  for (const r of state.income) if (r.date) periods.add(periodOf(r.date));
  for (const r of state.purchases) if (r.date) periods.add(periodOf(r.date));
  for (const r of state.savingsTx) if (r.date) periods.add(periodOf(r.date));
  for (const r of state.gold) if (r.date) periods.add(periodOf(r.date));
  for (const r of state.bills) if (r.period) periods.add(r.period);
  periods.add(currentPeriod());
  return [...periods].sort().reverse();
}

export function trend(state: AppState, endPeriod: Period, months: number): MonthSummary[] {
  const out: MonthSummary[] = [];
  for (let i = months - 1; i >= 0; i--) out.push(summary(state, shiftPeriod(endPeriod, -i)));
  return out;
}

export function upcomingBills(state: AppState, withinDays = 30): UpcomingBill[] {
  const today: IsoDate = isoOf(new Date());
  const limit = new Date();
  limit.setDate(limit.getDate() + withinDays);
  const limitISO = isoOf(limit);
  return state.bills
    .filter((b) => b.status !== 'paid' && b.dueDate && b.dueDate <= limitISO)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .map((b) => ({ ...b, overdue: b.dueDate < today }));
}
