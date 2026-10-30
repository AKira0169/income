/* main.tsx — the bundle entry point. */

import { render } from 'preact';
import { accountBalance } from '../domain/selectors.ts';
import { isDue, refresh as refreshGoldPrice } from './state/gold-price.ts';
import { app, boot, snapshot } from './state/app.ts';
import { clearAll, upsert } from './state/actions.ts';
import { goPeriod, goTab, startRouting } from './state/route.ts';
import type { TabId } from './state/route.ts';
import { App } from './ui/App.tsx';
import { build as buildWorkbook, filename as workbookFilename } from '../workbook/build.ts';
import type { Scope } from '../workbook/build.ts';

/* A handle on the running app, under `__app` in the console. The browser suite
   drives the app through it. Nothing here goes further than the screen does. */
Object.assign(globalThis, {
  __app: {
    /** The live state object. Replaced on every write, so read it each time. */
    state: snapshot,
    accountBalance: (id: string) => accountBalance(snapshot(), id),
    upsert,
    clearAll,
    buildWorkbook: (scope: Scope) => buildWorkbook(snapshot(), scope),
    workbookFilename,
    goTab: (tab: TabId) => goTab(tab),
    goPeriod: (period: string) => goPeriod(period),
    /** Kept for the console: a write already redraws on its own. */
    render: () => { app.value = { ...app.peek() }; }
  }
});

function start(): void {
  startRouting();
  const host = document.getElementById('app');
  if (!host) return;
  const outcome = boot();
  void outcome.then((result) => { if (result && isDue()) void refreshGoldPrice(); });
  render(<App outcome={outcome} />, host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
