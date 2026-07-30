/* main.tsx — the bundle entry point.

   The build concatenates the sql.js loader, the wasm binary and this bundle
   into one <script> in one HTML file, so the app opens straight off the disk
   with nothing to install and nothing to fetch. */

import { render } from 'preact';
import { accountBalance } from './domain/selectors.ts';
import { isDue, refresh as refreshGoldPrice } from './data/gold-price.ts';
import { exportBytes, getBackend, query } from './data/sqlite.ts';
import { app, boot, snapshot } from './state/app.ts';
import { clearAll, upsert } from './state/actions.ts';
import { goTab, startRouting } from './state/route.ts';
import type { TabId } from './state/route.ts';
import { App } from './ui/App.tsx';
import { build as buildWorkbook, filename as workbookFilename } from './workbook/build.ts';

/* Supplied by the build: the wasm binary, base64'd into the page because a
   file:// document cannot fetch a sibling. */
declare const __SQL_WASM_B64__: string;

/* A handle on the running app, under `__app` in the console.

   It is the only way the browser suite can reach SQLite, IndexedDB and the Blob
   download path, none of which exist in Node — and it is genuinely useful for
   asking your own questions of your own data. Nothing is exposed that Settings
   does not already offer: the SQL console runs read-only queries, and the two
   download buttons hand over the whole database. There is no server and no
   second origin here for it to widen. */
Object.assign(globalThis, {
  __app: {
    /** The live state object. Replaced on every write, so read it each time. */
    state: snapshot,
    backend: getBackend,
    accountBalance: (id: string) => accountBalance(snapshot(), id),
    upsert,
    clearAll,
    query,
    exportDb: exportBytes,
    buildWorkbook,
    workbookFilename,
    goTab: (tab: TabId) => goTab(tab),
    /** Kept for the console: a write already redraws on its own. */
    render: () => { app.value = { ...app.peek() }; }
  }
});

function start(): void {
  startRouting();
  const host = document.getElementById('app');
  if (!host) return;

  // Started before the first render so the boot screen is already on its way
  // out by the time the engine is warm.
  const outcome = boot(__SQL_WASM_B64__);

  /* The price sync is the one thing in this app that reaches the network, so it
     waits until the app is usable and never blocks it. Nothing announces
     itself: a quiet update is the point of "once a day", and the signal redraws
     whatever is on screen when it lands. */
  void outcome.then((result) => { if (result && isDue()) void refreshGoldPrice(); });

  render(<App outcome={outcome} />, host);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
