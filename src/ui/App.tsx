/* ui/App.tsx — the whole page: boot screen, frame, and whichever tab is on.

   Tabs still built by hand go through <LegacyTab/>; ported ones are components.
   The list below is the only place that knows which is which, so a port is one
   line changed here plus the new component. */

import { useEffect } from 'preact/hooks';
import { plural } from '../domain/money.ts';
import { app, bootError, booting, storageOk } from '../state/app.ts';
import { period as routePeriod, tab as routeTab } from '../state/route.ts';
import type { TabId } from '../state/route.ts';
import { Toast, toast } from './components/Toast.tsx';
import { LegacyTab } from './LegacyTab.tsx';
import { Topbar } from './Topbar.tsx';
import { view } from './view.ts';
import type { BootOutcome } from '../state/app.ts';

import { Income } from './tabs/Income.tsx';
import { Purchases } from './tabs/Purchases.tsx';
import { renderAccounts } from './tabs/accounts.ts';
import { renderBills } from './tabs/bills.ts';
import { renderDashboard } from './tabs/dashboard.ts';
import { renderGold } from './tabs/gold.ts';
import { renderSettings } from './tabs/settings.ts';

/** Tabs that are components. Anything not here is still hand-built and goes
    through <LegacyTab/>; this list is the whole record of how far the port is. */
const PORTED: Partial<Record<TabId, () => preact.JSX.Element>> = {
  income: Income,
  purchases: Purchases
};

const LEGACY: Partial<Record<TabId, () => HTMLElement>> = {
  dashboard: renderDashboard,
  bills: renderBills,
  savings: renderAccounts,
  gold: renderGold,
  settings: renderSettings
};

function Splash({ title, lines }: { title: string; lines: readonly string[] }) {
  return (
    <main>
      <div class="boot">
        <h1>{title}</h1>
        {lines.map((text) => <p class="muted" key={text}>{text}</p>)}
      </div>
    </main>
  );
}

function StorageNotice() {
  if (storageOk.value) return null;
  return (
    <div class="notice danger" style="margin-bottom:24px">
      <strong>Nothing is being saved. </strong>
      This browser is blocking local storage, so anything you enter will be lost when you close
      the tab. Download a copy of your data from Settings before you leave.
    </div>
  );
}

export function App({ outcome }: { outcome: Promise<BootOutcome | null> }) {
  const tabId = routeTab.value;
  const period = routePeriod.value;

  /* The legacy tab modules read view.tab and view.period directly rather than
     taking them as arguments. Mirrored here, during App's own render, because
     App renders before its children and so before any tab is built. One site,
     and it disappears with the last legacy tab. */
  view.tab = tabId;
  view.period = period;

  /* Announced once the database is open, not on every render. A quiet catch-up
     that moved a balance is alarming when it is not explained. */
  useEffect(() => {
    void outcome.then((result) => {
      if (!result) return;
      if (result.migrated) {
        toast('Moved your existing records into the database');
      } else if (result.added.total) {
        const parts: string[] = [];
        if (result.added.income) parts.push(plural(result.added.income, 'income entry', 'income entries'));
        if (result.added.bills) parts.push(plural(result.added.bills, 'bill'));
        toast(`Added ${parts.join(' and ')} from your recurring set-up`);
      }
    });
  }, [outcome]);

  /* Moving to another tab starts at the top; re-rendering in place — saving a
     row, opening a form — leaves the scroll exactly where it was, which is what
     Preact diffing gives for free and the old teardown had to rescue by hand. */
  useEffect(() => { window.scrollTo(0, 0); }, [tabId]);

  if (bootError.value) {
    return <Splash title="Could not start" lines={[bootError.value, 'Try opening this file in Chrome or Edge.']} />;
  }
  if (booting.value) {
    return <Splash title="Income Tracker" lines={['Opening your database…']} />;
  }

  // Read so the frame redraws with the data, not only with the route.
  app.value;

  const Ported = PORTED[tabId];
  const legacy = LEGACY[tabId];

  return (
    <>
      <Topbar />
      <main>
        <StorageNotice />
        {Ported
          ? <Ported key={tabId} />
          : legacy ? <LegacyTab key={tabId} render={legacy} /> : null}
      </main>
      <Toast />
    </>
  );
}
