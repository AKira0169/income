/* state/app.ts — the one signal the whole screen is drawn from.

   IMPORTANT for anything written in JSX: read `app.value` and pass it to the
   domain function — `activePeriods(app.value)`, not the old-arity wrapper in
   store.ts. Those wrappers read a plain `let`, so a component that calls one
   renders correctly once and then never updates again. No error, no warning,
   just a screen that quietly disagrees with the data. The wrappers exist for
   the legacy .ts modules and go with them.

   Writes replace the state object rather than editing it, because a signal
   compares with ===. domain/ already guarantees that; this file is what turns
   it into a redraw. */

import { signal } from '@preact/signals';
import { catchUp } from '../domain/recurring.ts';
import { blankState, migrate } from '../domain/records.ts';
import { init as initSqlite, save as saveSqlite } from '../data/sqlite.ts';
import type { AppState, CatchUpResult, PersistenceAdapter } from '../domain/types.ts';

export const app = signal<AppState>(blankState());

/** The current state without subscribing to it. For persistence, export and
    anything else that reads on its way out rather than to draw. */
export const snapshot = (): AppState => app.peek();

/** False when the browser is refusing to store anything, so the screen can say
    so rather than losing the data silently. */
export const storageOk = signal(true);

export const booting = signal(true);
export const bootError = signal<string | null>(null);

/* ------------------------------------------------------------ persistence */

let persistence: PersistenceAdapter = { save: () => false };

export function attachPersistence(adapter: PersistenceAdapter): void { persistence = adapter; }

let pendingSave = false;

export function save(): void {
  pendingSave = false;
  try {
    const result = persistence.save(app.peek());
    if (typeof result === 'object' && typeof result.then === 'function') {
      result.then((ok) => { storageOk.value = ok !== false; })
        .catch(() => { storageOk.value = false; });
    } else {
      storageOk.value = result !== false;
    }
  } catch {
    storageOk.value = false;
  }
}

/* Every save rewrites the whole database, so a run of writes in one turn —
   save a recurring bill, back-link its past entries, then catch up the months
   since — should cost one write, not three. A microtask always runs before the
   browser can paint or the tab can close, so nothing is at risk in the gap. */
export function scheduleSave(): void {
  if (pendingSave) return;
  pendingSave = true;
  queueMicrotask(() => { if (pendingSave) save(); });
}

/** Adopt a new state and write it through. Together with hydrate() below, the
    only place the state is replaced. */
export function commit(next: AppState): void {
  app.value = next;
  scheduleSave();
}

/** Adopt a state read out of the database at boot. Does not write it back. */
export function hydrate(loaded: unknown, available?: boolean): AppState {
  app.value = migrate(loaded);
  storageOk.value = available !== false;
  return app.value;
}

/* ------------------------------------------------------------------- boot */

export interface BootOutcome {
  /** The state came from the old localStorage format and has just been moved. */
  migrated: boolean;
  added: CatchUpResult;
}

/* Opens the database, adopts what is in it, and fills in the months that have
   passed since the app was last opened. Throws nothing: a failure lands in
   bootError, which is a screen rather than a blank page. */
export async function boot(wasmBase64: string): Promise<BootOutcome | null> {
  try {
    const result = await initSqlite(wasmBase64);
    attachPersistence({
      save: (state) => saveSqlite(state).then(() => true).catch(() => false)
    });
    hydrate(result.state, result.backend !== 'memory');

    // Before the first real render, so the month opens already filled in.
    const swept = catchUp(app.peek());
    if (swept.state !== app.peek()) commit(swept.state);
    else if (result.migrated) scheduleSave();

    booting.value = false;
    return { migrated: result.migrated, added: swept.result };
  } catch (err) {
    booting.value = false;
    bootError.value = err instanceof Error ? err.message : String(err);
    return null;
  }
}
