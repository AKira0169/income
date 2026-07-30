/* main.ts — the bundle entry point.

   The build concatenates the sql.js loader, the wasm binary and this bundle
   into one <script> in one HTML file, so the app opens straight off the disk
   with nothing to install and nothing to fetch. */

import { build as buildWorkbook, filename as workbookFilename } from './workbook/build.ts';
import { exportBytes, getBackend, query } from './data/sqlite.ts';
import { accountBalance, clearAll, state, upsert } from './store.ts';
import { init } from './ui/shell.ts';
import { render, view } from './ui/view.ts';
import type { TabId } from './ui/view.ts';

/* A handle on the running app, under `__app` in the console.

   It is the only way the browser suite can reach SQLite, IndexedDB and the Blob
   download path, none of which exist in Node — and it is genuinely useful for
   asking your own questions of your own data. Nothing is exposed that Settings
   does not already offer: the SQL console runs read-only queries, and the two
   download buttons hand over the whole database. There is no server and no
   second origin here for it to widen. */
Object.assign(globalThis, {
  __app: {
    /** The live state object. Reassigned by hydrate(), so read it each time. */
    state: () => state,
    backend: getBackend,
    accountBalance,
    upsert,
    clearAll,
    query,
    exportDb: exportBytes,
    buildWorkbook,
    workbookFilename,
    goTab: (tab: TabId) => { view.tab = tab; render(); },
    render
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init());
} else {
  void init();
}
