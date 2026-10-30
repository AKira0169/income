/* server/mutate.ts — the one path every write takes.

   Lock, load the whole state, hand it to the very domain function the offline
   app called, diff what came back, write the diff, bump the version — all in
   one transaction. The api owns no rules of its own: whatever the domain
   decides is what happens, which is why the browser and the server cannot
   disagree about what a write means.

   A domain function that throws has a message written for a person ("This
   file is not an Income Tracker backup…"), so it goes back as a 400 with that
   message. An HttpError thrown inside `run` (a 404 for a missing record) is
   already shaped and passes through untouched. */

import type { AppState, Settings } from '../src/domain/types.ts';
import type { MutationResponse } from '../src/wire.ts';
import { withUser } from './db.ts';
import type { Sql } from './db.ts';
import { diffState } from './diff.ts';
import { HttpError } from './errors.ts';
import { baseCurrencyOf, loadState, writeDiff } from './repo.ts';

export interface Mutation<R> {
  state: AppState;
  result: R;
}

export function mutate<R>(
  sql: Sql, userId: string, run: (state: AppState) => Mutation<R>
): Promise<MutationResponse<R>> {
  return withUser(sql, userId, async (tx) => {
    const { state: before } = await loadState(userId, tx);
    let out: Mutation<R>;
    try {
      out = run(before);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, 'domain', err instanceof Error ? err.message : String(err));
    }
    const diff = diffState(before, out.state);
    const version = await writeDiff(userId, tx, diff, baseCurrencyOf(out.state.settings));
    const response: MutationResponse<R> = { version, changes: diff.changes, result: out.result };
    // Sent as stored, base currency included, so the client matches the next read.
    if (diff.settings) {
      response.settings = { ...diff.settings, baseCurrency: baseCurrencyOf(diff.settings) } as Settings;
    }
    return response;
  }, { lock: true });
}
