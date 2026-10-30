/* main.tsx — the bundle entry point. */

import { effect } from '@preact/signals';
import { render } from 'preact';
import { accountBalance } from '../domain/selectors.ts';
import { checkSession } from './auth/session.ts';
import { clearAll, upsert } from './state/actions.ts';
import { idle, inFlight, refresh } from './state/api.ts';
import { app, snapshot } from './state/app.ts';
import { goPeriod, goTab, startRouting } from './state/route.ts';
import type { TabId } from './state/route.ts';
import { App } from './ui/App.tsx';
import { build as buildWorkbook, filename as workbookFilename } from '../workbook/build.ts';
import type { Scope } from '../workbook/build.ts';

/* A handle on the running app, under `__app` in the console. The browser suite
   drives the app through it. Everything here is something the signed-in person
   can already do from the screen, against their own data only. */
Object.assign(globalThis, {
  __app: {
    /** The live state object. Replaced on every write, so read it each time. */
    state: snapshot,
    accountBalance: (id: string) => accountBalance(snapshot(), id),
    upsert,
    clearAll,
    /** Fetch the whole state again, e.g. after the gold price changed. */
    reload: refresh,
    /** Resolves when every write so far has answered. */
    idle,
    buildWorkbook: (scope: Scope) => buildWorkbook(snapshot(), scope),
    workbookFilename,
    goTab: (tab: TabId) => goTab(tab),
    goPeriod: (period: string) => goPeriod(period),
    render: () => { app.value = { ...app.peek() }; }
  }
});

function start(): void {
  startRouting();
  const host = document.getElementById('app');
  if (!host) return;
  // Outside any component, so a request starting or ending redraws nothing.
  effect(() => { document.body.classList.toggle('is-busy', inFlight.value > 0); });
  render(<App />, host);
  void checkSession();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
