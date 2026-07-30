/* domain/backup.ts — the whole database as one JSON file, and back again.

   Restoring is the one operation that can destroy everything at once, so it
   checks the shape of what it was given before it replaces anything: migrate()
   is deliberately forgiving and would happily turn an unrelated file into an
   empty state. */

import { COLLECTION_KEYS } from './catalog.ts';
import { migrate } from './records.ts';
import type { AppState, CollectionKey } from './types.ts';

export function exportJSON(state: AppState): string { return JSON.stringify(state, null, 2); }

/** True only if this parsed object holds at least one of our collections. */
export function looksLikeBackup(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const source = parsed as Record<string, unknown>;
  return COLLECTION_KEYS.some((key) => Array.isArray(source[key]));
}

export interface ImportResult {
  state: AppState;
  /** How many records arrived in each collection, for the confirmation message. */
  counts: Record<CollectionKey, number>;
}

export function importJSON(text: string): ImportResult {
  const parsed: unknown = JSON.parse(text);
  if (!looksLikeBackup(parsed)) {
    throw new Error('This file is not an Income Tracker backup, so nothing was changed. ' +
      'Pick the .json file produced by "Download backup".');
  }
  const state = migrate(parsed);
  const counts = {} as Record<CollectionKey, number>;
  for (const key of COLLECTION_KEYS) counts[key] = state[key].length;
  return { state, counts };
}
