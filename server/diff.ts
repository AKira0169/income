/* server/diff.ts — what a domain call changed, by id.

   Domain functions return a new state and leave every untouched record (and
   every untouched collection) as the very same object, so most of the work is
   reference checks. A record that is a new object is compared in its stored
   form, so re-saving something with its own values writes nothing. */

import type { AppState, Id, Settings } from '../src/domain/types.ts';
import { USER_COLLECTIONS } from '../src/wire.ts';
import type { Changes, StateDiff, WireRecord } from '../src/wire.ts';
import { normalizeRecord } from './schema.ts';

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((k) => [k, sorted((value as Record<string, unknown>)[k])]));
  }
  return value;
};

/** Equal as JSON, whatever order the keys are in (jsonb reorders them). */
export const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

export function diffState(before: AppState, after: AppState): StateDiff {
  const changes: Changes = {};
  for (const key of USER_COLLECTIONS) {
    if (before[key] === after[key]) continue;
    const previous = new Map((before[key] as ReadonlyArray<{ id: Id }>).map((r) => [r.id, r]));
    /* Last copy wins for a repeated id: one INSERT … ON CONFLICT cannot touch
       the same row twice, and a hand-edited backup can repeat one. */
    const latest = new Map<Id, { id: Id }>();
    for (const r of after[key] as ReadonlyArray<{ id: Id }>) latest.set(r.id, r);

    const upserts: WireRecord[] = [];
    for (const [id, record] of latest) {
      const old = previous.get(id);
      if (old === record) continue;
      const stored = normalizeRecord(key, record) as unknown as WireRecord;
      if (old && sameJson(stored, normalizeRecord(key, old))) continue;
      upserts.push(stored);
    }
    const deletes = [...previous.keys()].filter((id) => !latest.has(id));
    if (upserts.length || deletes.length) changes[key] = { upserts, deletes };
  }

  const settings: Settings | null =
    before.settings === after.settings || sameJson(before.settings, after.settings) ? null : after.settings;
  return { changes, settings };
}

export const isEmptyDiff = (diff: StateDiff): boolean =>
  !diff.settings && Object.keys(diff.changes).length === 0;
