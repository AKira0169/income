/* domain/selectors.ts — every derived figure the screens and the workbook read.

   All read-only, and all take the state as their first argument rather than
   reaching for a module-level one. That is what makes them unit-testable
   without a browser, and what lets the UI hold the state in a signal without
   these knowing anything about it. */

import { SAVINGS_TYPES } from './catalog.ts';
import { byId } from './records.ts';
import { billIsOverdue } from './recurring.ts';
import { currentPeriod, isoOf, periodOf, shiftPeriod } from './period.ts';
import type {
  Account, AccountFlows, AppState, Bill, Category, CategoryTotal, Cents, Id,
  IncomeEntry, IsoDate, MonthSummary, Period, Purchase, SavingsMovement,
  SavingsTx, UpcomingBill
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

/** The account's own name, or '' when it has been deleted. Used by both the
    screens and the workbook, which is why it lives here rather than in either. */
export function accountName(state: AppState, id: Id | '' | null | undefined): string {
  return byId(state, 'accounts', id)?.name ?? '';
}

/* Every flow that touches an account, in the order money actually moves. A bill
   only leaves the account when it is paid — an unpaid bill is a commitment, not
   a withdrawal, and deducting it would make the balance disagree with the bank. */
export function accountFlows(state: AppState, accountId: Id): AccountFlows {
  const flows: AccountFlows = {
    opening: 0, income: 0, purchases: 0, bills: 0, savedIn: 0, savedOut: 0, gold: 0
  };
  const account = byId(state, 'accounts', accountId);
  if (!account) return flows;
  flows.opening = account.opening || 0;

  for (const r of state.income) {
    if (r.accountId === accountId) flows.income += r.amount || 0;
  }
  for (const r of state.purchases) {
    if (r.accountId === accountId) flows.purchases += r.amount || 0;
  }
  for (const b of state.bills) {
    if (b.accountId === accountId && b.status === 'paid') flows.bills += b.amount || 0;
  }
  // Buying gold takes money out of an account and turns it into metal; selling
  // puts it back. Net, so a positive figure means gold has cost this account.
  for (const r of state.gold) {
    if (r.accountId !== accountId) continue;
    flows.gold += r.direction === 'sell' ? -(r.amount || 0) : (r.amount || 0);
  }
  for (const tx of state.savingsTx) {
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

export function accountBalance(state: AppState, accountId: Id): Cents {
  const f = accountFlows(state, accountId);
  return f.opening + f.income + f.savedIn - f.purchases - f.bills - f.savedOut - f.gold;
}

export function totalSavings(state: AppState): Cents {
  return sum(state.accounts, (a) => accountBalance(state, a.id));
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
  if (tx.direction === 'transfer') {
    const from = byId(state, 'accounts', tx.fromAccountId);
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
