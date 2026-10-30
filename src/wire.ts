/* wire.ts — what travels between the browser and the api, shared by both.

   A write answers with a diff rather than the whole state: the collections it
   touched, as records to put in place and ids to take out, plus the settings
   object if that changed. applyChanges() is the client's half of that, and is
   pure for the same reason the domain is — a signal only redraws when it is
   handed a new object. */

import type { AppState, CollectionKey, Id, Settings } from './domain/types.ts';

/** Every collection a user owns. Gold prices are shared and read-only. */
export type UserCollection = Exclude<CollectionKey, 'goldPrices'>;

export const USER_COLLECTIONS: readonly UserCollection[] = [
  'income', 'incomeTemplates', 'billTemplates', 'bills', 'purchases',
  'accounts', 'goals', 'savingsTx', 'gold'
];

export const isUserCollection = (name: string): name is UserCollection =>
  (USER_COLLECTIONS as readonly string[]).includes(name);

export type WireRecord = { id: Id } & Record<string, unknown>;

export interface CollectionChange {
  upserts: WireRecord[];
  deletes: Id[];
}

export type Changes = Partial<Record<UserCollection, CollectionChange>>;

export interface StateDiff {
  changes: Changes;
  settings: Settings | null;
}

export interface MutationResponse<R = unknown> {
  /** users.state_version after this write; unchanged when nothing was written. */
  version: number;
  changes: Changes;
  settings?: Settings;
  /** Whatever the action returns: the saved record, a count, a difference. */
  result: R;
}

export interface StateResponse { version: number; state: AppState }

export interface MeResponse { email: string; verified: boolean; version: number }

export interface ErrorBody { error: { code: string; message: string } }

export function applyChanges(
  state: AppState, update: { changes: Changes; settings?: Settings | null }
): AppState {
  let next = state;
  for (const key of USER_COLLECTIONS) {
    const change = update.changes[key];
    if (!change) continue;
    const gone = new Set(change.deletes);
    const incoming = new Map(change.upserts.map((r) => [r.id, r]));
    const list: { id: Id }[] = (state[key] as ReadonlyArray<{ id: Id }>)
      .filter((r) => !gone.has(r.id))
      .map((r) => incoming.get(r.id) ?? r);
    const present = new Set(list.map((r) => r.id));
    for (const r of change.upserts) if (!present.has(r.id)) list.push(r);
    next = { ...next, [key]: list } as AppState;
  }
  if (update.settings) next = { ...next, settings: update.settings };
  return next;
}
