/* store.ts — the mutable binding the screens still read, over a pure domain.

   Everything that used to live here now lives in domain/, where each function
   takes the state it works on and returns the next one. This file is what is
   left: one mutable `state`, the persistence seam, and a thin wrapper per
   function that supplies `state` and puts the result back.

   It is a shim, not a barrel. A barrel would preserve the names but not the
   arity, and the legacy UI depends on both — `purchasesIn(period)` with the old
   signature, and `state.accounts` read as a live binding. Keeping it here is
   what lets the domain be split and the tabs be ported one at a time with both
   test suites green at every commit. It is deleted with the last legacy tab. */

import * as Backup from './domain/backup.ts';
import * as Gold from './domain/gold.ts';
import * as Period from './domain/period.ts';
import * as Records from './domain/records.ts';
import * as Recurring from './domain/recurring.ts';
import * as Selectors from './domain/selectors.ts';
import { formatMoney as formatMoneyPure } from './domain/money.ts';
import type { FormatMoneyOptions } from './domain/money.ts';
import type {
  AccountFlows, AppState, Bill, Cents, CollectionKey, Collections, GoldEntry,
  GoldHolding, GoldPrice, GoldSummary, Id, IncomeEntry, MonthSummary,
  Period as PeriodId, PersistenceAdapter, Purchase, RecordOf, SavingsMovement,
  SavingsTx, Settings, UpcomingBill
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

/* --------------------------------------------------------- mutable state */

/* Exported as a live binding: importers see reassignments made by hydrate(),
   importJSON() and clearAll() without going through a getter. */
export let state: AppState = Records.blankState();
export let storageAvailable = true;

let persistence: PersistenceAdapter = { save: () => false };

export function attachPersistence(adapter: PersistenceAdapter): void { persistence = adapter; }

/** Adopt a state object read out of the database at boot. */
export function hydrate(loaded: unknown, available?: boolean): AppState {
  state = Records.migrate(loaded);
  storageAvailable = available !== false;
  return state;
}

export function save(): void {
  pendingSave = false;
  try {
    const result = persistence.save(state);
    if (typeof result === 'object' && typeof result.then === 'function') {
      result.then((ok) => { storageAvailable = ok !== false; })
        .catch(() => { storageAvailable = false; });
    } else {
      storageAvailable = result !== false;
    }
  } catch {
    storageAvailable = false;
  }
}

/* Every save rewrites the whole database, so a run of writes in one turn — save
   a recurring bill, back-link its past entries, then catch up the months since
   — should cost one write, not three. A microtask always runs before the
   browser can paint or the tab can close, so nothing is at risk in the gap. */
let pendingSave = false;

export function scheduleSave(): void {
  if (pendingSave) return;
  pendingSave = true;
  queueMicrotask(() => { if (pendingSave) save(); });
}

/** Adopt a new state and write it through. The one place `state` is replaced. */
function commit(next: AppState): void {
  state = next;
  scheduleSave();
}

/* ------------------------------------------------------- writes (old arity) */

export function upsert<K extends CollectionKey>(
  collection: K, record: Records.Draft<K>
): RecordOf<K> {
  const result = Records.upsert(state, collection, record);
  commit(result.state);
  return result.record;
}

export function remove(collection: CollectionKey, id: Id): void {
  commit(Records.remove(state, collection, id));
}

export function updateSettings(patch: Partial<Settings>): void {
  commit(Records.updateSettings(state, patch));
}

export function replaceState(next: unknown): void { commit(Records.migrate(next)); }

export function clearAll(): void { commit(Records.blankState()); }

export function importJSON(text: string): Record<CollectionKey, number> {
  const result = Backup.importJSON(text);
  commit(result.state);
  return result.counts;
}

export function exportJSON(): string { return Backup.exportJSON(state); }

/* ------------------------------------------------------------- generation */

export function generateBills(period: PeriodId): number {
  const result = Recurring.generateBills(state, period);
  if (result.created) commit(result.state);
  return result.created;
}

export function generateIncome(period: PeriodId): number {
  const result = Recurring.generateIncome(state, period);
  if (result.created) commit(result.state);
  return result.created;
}

export function catchUp(): { income: number; bills: number; total: number } {
  const result = Recurring.catchUp(state);
  // The generatedThrough marks move even in a month where nothing was due, so a
  // sweep that added no rows can still need persisting.
  if (result.state !== state) commit(result.state);
  return result.result;
}

export function linkGeneratedTo(
  collection: 'incomeTemplates' | 'billTemplates',
  template: { id?: Id; accountId?: Id | '' } | null | undefined
): number {
  const result = Recurring.linkGeneratedTo(state, collection, template);
  if (result.linked) commit(result.state);
  return result.linked;
}

export function recordGoldPrice(reading: Gold.GoldPriceReading): GoldPrice {
  const result = Gold.recordGoldPrice(state, reading);
  commit(result.state);
  return result.record;
}

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
