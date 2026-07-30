/* store.ts — the old shape of the store, over the signal and the pure domain.

   Nothing decides anything here. The rules live in domain/, the state lives in
   the signal in state/app.ts, and the writes live in state/actions.ts. This
   file is the adapter the legacy .ts screens still speak to: a plain `state`
   binding they can read, and one old-arity wrapper per function.

   It is a shim, not a barrel. A barrel would preserve the names but not the
   arity, and the legacy UI depends on both — `purchasesIn(period)` with the old
   signature, and `state.accounts` read as a live binding. It is what lets the
   tabs port one at a time with both suites green at every commit, and it goes
   with the last legacy tab.

   Anything written in JSX must NOT use these. They read a plain `let`, so a
   component calling one subscribes to nothing and silently stops updating.
   Components read `app.value` and call the domain function themselves. */

import * as Gold from './domain/gold.ts';
import * as Period from './domain/period.ts';
import * as Records from './domain/records.ts';
import * as Selectors from './domain/selectors.ts';
import { formatMoney as formatMoneyPure } from './domain/money.ts';
import type { FormatMoneyOptions } from './domain/money.ts';
import { app } from './state/app.ts';
import type {
  AccountFlows, AppState, Bill, Cents, CollectionKey, Collections, GoldEntry,
  GoldHolding, GoldPrice, GoldSummary, Id, IncomeEntry, MonthSummary,
  Period as PeriodId, Purchase, RecordOf, SavingsMovement, SavingsTx, Settings,
  UpcomingBill
} from './domain/types.ts';

/* ------------------------------------------------- re-exported vocabulary */

export {
  ACCOUNT_TYPES, BILL_CATEGORIES, COLLECTION_KEYS, FREQUENCIES, GOLD_KARATS,
  GRAMS_PER_OZ, INCOME_CATEGORIES, METERED, PAYMENT_METHODS, PURCHASE_CATEGORIES,
  SAVINGS_TYPES, STORAGE_KEY
} from './domain/catalog.ts';

export { parseMoney, plural, toMajor } from './domain/money.ts';
export type { FormatMoneyOptions } from './domain/money.ts';

export {
  currentPeriod, daysInPeriod, dueDateFor, monthlyEquivalent, occursIn, periodOf,
  shiftPeriod, todayISO
} from './domain/period.ts';
export type { MonthlyEquivalentInput, OccurrenceRule } from './domain/period.ts';

export { blankState, normalizeBill, sortByDateDesc, uid } from './domain/records.ts';
export type { Draft } from './domain/records.ts';

export { billIsOverdue } from './domain/recurring.ts';
export { goldGramFromSpot, goldPurity } from './domain/gold.ts';
export type { GoldPriceReading } from './domain/gold.ts';

export { groupByCategory, isSavingsAccount, sum } from './domain/selectors.ts';
export { looksLikeBackup } from './domain/backup.ts';

export type { Collections };

/* ------------------------------------------------------ the state binding */

/* A plain mirror of the signal, exported as a live binding so the legacy
   screens keep reading `state.accounts` unchanged. One assignment site, driven
   by the signal itself, so the two cannot drift apart: subscribe() runs the
   callback once immediately and then on every write. */
export let state: AppState = app.peek();
app.subscribe((next) => { state = next; });

export { attachPersistence, hydrate, save, scheduleSave } from './state/app.ts';

export {
  catchUp, clearAll, exportJSON, generateBills, generateIncome, importJSON,
  linkGeneratedTo, recordGoldPrice, remove, replaceState, updateSettings, upsert
} from './state/actions.ts';

/* --------------------------------------------------- reads (old arity) */

export const byId = <K extends CollectionKey>(collection: K, id: Id | null | undefined): RecordOf<K> | null =>
  Records.byId(state, collection, id);

export const periodLabel = (period: PeriodId): string =>
  Period.periodLabel(period, state.settings.locale);

export const formatMoney = (cents: Cents, settings?: Settings, opts?: FormatMoneyOptions): string =>
  formatMoneyPure(cents, settings ?? state.settings, opts);

export const incomeIn = (p: PeriodId): IncomeEntry[] => Selectors.incomeIn(state, p);
export const purchasesIn = (p: PeriodId): Purchase[] => Selectors.purchasesIn(state, p);
export const billsIn = (p: PeriodId): Bill[] => Selectors.billsIn(state, p);
export const savingsTxIn = (p: PeriodId): SavingsTx[] => Selectors.savingsTxIn(state, p);

export const accountName = (id: Id | '' | null | undefined): string =>
  Selectors.accountName(state, id);
export const accountFlows = (id: Id): AccountFlows => Selectors.accountFlows(state, id);
export const accountBalance = (id: Id): Cents => Selectors.accountBalance(state, id);
export const totalSavings = (): Cents => Selectors.totalSavings(state);
export const savingsBalance = (): Cents => Selectors.savingsBalance(state);
export const savingsMovement = (tx: SavingsTx): SavingsMovement => Selectors.savingsMovement(state, tx);

export const summary = (p: PeriodId): MonthSummary => Selectors.summary(state, p);
export const activePeriods = (): PeriodId[] => Selectors.activePeriods(state);
export const trend = (end: PeriodId, months: number): MonthSummary[] => Selectors.trend(state, end, months);
export const upcomingBills = (withinDays?: number): UpcomingBill[] =>
  Selectors.upcomingBills(state, withinDays);

export const goldIn = (p: PeriodId): GoldEntry[] => Gold.goldIn(state, p);
export const latestGoldPrice = (): GoldPrice | null => Gold.latestGoldPrice(state);
export const goldPricePerGram = (karat: number | string): Cents => Gold.goldPricePerGram(state, karat);
export const goldHoldings = (): GoldHolding[] => Gold.goldHoldings(state);
export const goldValue = (): Cents => Gold.goldValue(state);
export const goldInvested = (): Cents => Gold.goldInvested(state);
export const goldSummary = (): GoldSummary => Gold.goldSummary(state);
