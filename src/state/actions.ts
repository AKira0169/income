/* state/actions.ts — every write the screen can make.

   Each one is the same three steps: call the pure domain function with the
   current state, put the state it returns into the signal, and hand back
   whatever the caller needs. Nothing here decides anything; the rules all live
   in domain/. Keeping the shape uniform is the point — a write that forgot to
   commit would leave the screen showing the old figures. */

import * as Backup from '../domain/backup.ts';
import * as Debt from '../domain/debt.ts';
import * as Forecast from '../domain/forecast.ts';
import * as Gold from '../domain/gold.ts';
import * as Records from '../domain/records.ts';
import * as Reconcile from '../domain/reconcile.ts';
import * as Recurring from '../domain/recurring.ts';
import { app, commit, snapshot } from './app.ts';
import type {
  CatchUpResult, Cents, CollectionKey, GoldPrice, Id, IsoDate, Period, RecordOf, Settings
} from '../domain/types.ts';

export function upsert<K extends CollectionKey>(
  collection: K, record: Records.Draft<K>
): RecordOf<K> {
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

/* ------------------------------------------------------------- generation */

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

/* The generatedThrough marks move even in a month where nothing was due, so a
   sweep that added no rows can still need persisting — which is exactly what
   "did the state object change" answers. */
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

/* Deleting a goal needs nothing here — remove is already generic over
   CollectionKey, and orphaning its purchase is a rule inside it. Saving one
   does not go through the generic upsert, because a goal carries a purchase
   with it once it is bought. */
export function saveGoal(
  draft: Records.Draft<'goals'>, paid: Forecast.GoalPayment = {}
): void {
  commit(Forecast.saveGoal(app.peek(), draft, paid));
}

export function moveGoal(id: Id, delta: number): void {
  const next = Forecast.moveGoal(app.peek(), id, delta);
  if (next !== app.peek()) commit(next);
}

/* ------------------------------------------------- debts and reconciling */

/* Borrowing writes an account and a movement together, so neither goes through
   the generic upsert: a debt with no movement is an obligation whose money
   never arrived, and a movement with no account has nowhere to come from. */
export function borrow(taken: Debt.Borrowing): void {
  commit(Debt.borrow(app.peek(), taken));
}

export function repay(debtId: Id, paid: Debt.Repayment): void {
  const next = Debt.repay(app.peek(), debtId, paid);
  if (next !== app.peek()) commit(next);
}

/** Writes the row that makes an account agree with its real balance, and says
    what it corrected by. Zero means it already agreed and nothing was written. */
export function reconcile(accountId: Id, actual: Cents, date: IsoDate): Cents {
  const state = app.peek();
  const { difference } = Reconcile.reconciliation(state, accountId, actual);
  if (difference) commit(Reconcile.reconcile(state, accountId, actual, date));
  return difference;
}
