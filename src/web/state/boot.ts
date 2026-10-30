/* state/boot.ts — from "signed in" to "ready".

   Load the state, then ask the server to fill in the months that have passed
   since the last visit (POST /api/recurring/catch-up). The read stays a pure
   read; the catch-up is a write like any other, and the unique keys plus the
   per-user lock make it harmless when two tabs boot at once. Throws nothing: a
   failure lands in bootError, which is a screen rather than a blank page. */

import { blankState } from '../../domain/records.ts';
import type { CatchUpResult } from '../../domain/types.ts';
import { catchUp } from './actions.ts';
import { forget, refresh } from './api.ts';
import { app, bootError, booting } from './app.ts';

export interface BootOutcome {
  added: CatchUpResult;
}

let started: Promise<BootOutcome | null> | null = null;

export function boot(): Promise<BootOutcome | null> {
  started ??= (async () => {
    booting.value = true;
    bootError.value = null;
    try {
      await refresh();
      const added = await catchUp();
      booting.value = false;
      return { added };
    } catch (err) {
      booting.value = false;
      bootError.value = err instanceof Error ? err.message : String(err);
      return null;
    }
  })();
  return started;
}

/** After signing out: the next person to sign in boots from nothing. */
export function resetApp(): void {
  started = null;
  forget();
  app.value = blankState();
  booting.value = true;
  bootError.value = null;
}
