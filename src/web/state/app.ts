/* state/app.ts — the one signal the whole screen is drawn from.

   IMPORTANT for anything written in JSX: read `app.value` and pass it to the
   domain function — `activePeriods(app.value)`. A component that reads a
   plain copy renders correctly once and then never updates again.

   The state is replaced, never edited, because a signal compares with ===.
   It is filled from the server (boot.ts) and moved forward one write at a
   time by the changes each write answers with (api.ts). */

import { signal } from '@preact/signals';
import { blankState, migrate } from '../../domain/records.ts';
import type { AppState } from '../../domain/types.ts';

export const app = signal<AppState>(blankState());

/** The current state without subscribing to it. */
export const snapshot = (): AppState => app.peek();

/** False when the last request could not reach the server at all. */
export const reachable = signal(true);

export const booting = signal(true);
export const bootError = signal<string | null>(null);

/** Adopt a whole state from the server. */
export function hydrate(loaded: unknown): AppState {
  app.value = migrate(loaded);
  return app.value;
}
