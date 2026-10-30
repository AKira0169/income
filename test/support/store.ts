/* test/support/store.ts — the offline build's in-memory store, kept for the
   Node suites.

   The web app's actions became API calls in phase 1, but export.ts and
   domain.ts were written against "call an action, read the signal" and are
   still the best coverage the domain and the workbook have. This is that
   contract, unchanged and synchronous, over plain memory: each action calls the
   pure domain function, replaces the state, and returns what the old action
   returned. Nothing here persists anything — there is nothing to persist to. */

import { signal } from '@preact/signals';
import * as Backup from '../../src/domain/backup.ts';
import * as Debt from '../../src/domain/debt.ts';
import * as Forecast from '../../src/domain/forecast.ts';
import * as Gold from '../../src/domain/gold.ts';
import * as Records from '../../src/domain/records.ts';
import * as Reconcile from '../../src/domain/reconcile.ts';
import * as Recurring from '../../src/domain/recurring.ts';
import type {
  AppState, CatchUpResult, Cents, CollectionKey, GoldPrice, Id, IsoDate, Period, RecordOf, Settings
} from '../../src/domain/types.ts';

export const app = signal<AppState>(Records.blankState());
export const snapshot = (): AppState => app.peek();

const commit = (next: AppState): void => { app.value = next; };

export function upsert<K extends CollectionKey>(collection: K, record: Records.Draft<K>): RecordOf<K> {
  const result = Records.upsert(app.peek(), collection, record);
  commit(result.state);
  return result.record;
}

export function remove(collection: CollectionKey, id: Id): void {
  commit(Records.remove(app.peek(), collection, id));
}

export function updateSettings(patch: Partial<Settings>): void {
  commit(Records.updateSettings(app.peek(), patch));
}

export function replaceState(next: unknown): void { commit(Records.migrate(next)); }

export function clearAll(): void { commit(Records.blankState()); }

export function importJSON(text: string): Record<CollectionKey, number> {
  const result = Backup.importJSON(text);
  commit(result.state);
  return result.counts;
}

export const exportJSON = (): string => Backup.exportJSON(snapshot());

export function generateBills(period: Period): number {
  const result = Recurring.generateBills(app.peek(), period);
  if (result.created) commit(result.state);
  return result.created;
}

export function generateIncome(period: Period): number {
  const result = Recurring.generateIncome(app.peek(), period);
  if (result.created) commit(result.state);
  return result.created;
}

export function catchUp(): CatchUpResult {
  const result = Recurring.catchUp(app.peek());
  if (result.state !== app.peek()) commit(result.state);
  return result.result;
}

export function linkGeneratedTo(
  collection: 'incomeTemplates' | 'billTemplates',
  template: { id?: Id; accountId?: Id | '' } | null | undefined
): number {
  const result = Recurring.linkGeneratedTo(app.peek(), collection, template);
  if (result.linked) commit(result.state);
  return result.linked;
}

export function recordGoldPrice(reading: Gold.GoldPriceReading): GoldPrice {
  const result = Gold.recordGoldPrice(app.peek(), reading);
  commit(result.state);
  return result.record;
}

export function saveGoal(draft: Records.Draft<'goals'>, paid: Forecast.GoalPayment = {}): void {
  commit(Forecast.saveGoal(app.peek(), draft, paid));
}

export function moveGoal(id: Id, delta: number): void {
  const next = Forecast.moveGoal(app.peek(), id, delta);
  if (next !== app.peek()) commit(next);
}

export function borrow(taken: Debt.Borrowing): void {
  commit(Debt.borrow(app.peek(), taken));
}

export function repay(debtId: Id, paid: Debt.Repayment): void {
  const next = Debt.repay(app.peek(), debtId, paid);
  if (next !== app.peek()) commit(next);
}

export function reconcile(accountId: Id, actual: Cents, date: IsoDate): Cents {
  const state = app.peek();
  const { difference } = Reconcile.reconciliation(state, accountId, actual);
  if (difference) commit(Reconcile.reconcile(state, accountId, actual, date));
  return difference;
}
