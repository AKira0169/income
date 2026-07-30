/* state/actions.ts — every write the screen can make.

   Each one is the same three steps: call the pure domain function with the
   current state, put the state it returns into the signal, and hand back
   whatever the caller needs. Nothing here decides anything; the rules all live
   in domain/. Keeping the shape uniform is the point — a write that forgot to
   commit would leave the screen showing the old figures. */

import * as Backup from '../domain/backup.ts';
import * as Gold from '../domain/gold.ts';
import * as Records from '../domain/records.ts';
import * as Recurring from '../domain/recurring.ts';
import { app, commit, snapshot } from './app.ts';
import type {
  CatchUpResult, CollectionKey, GoldPrice, Id, Period, RecordOf, Settings
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
