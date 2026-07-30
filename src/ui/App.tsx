/* ui/App.tsx — the whole page: boot screen, frame, and whichever tab is on. */

import { useEffect } from 'preact/hooks';
import { plural } from '../domain/money.ts';
import { app, bootError, booting, storageOk } from '../state/app.ts';
import { tab as routeTab } from '../state/route.ts';
import type { TabId } from '../state/route.ts';
import type { BootOutcome } from '../state/app.ts';
import { Toast, toast } from './components/Toast.tsx';
import { Topbar } from './Topbar.tsx';

import { Accounts } from './tabs/Accounts.tsx';
import { Bills } from './tabs/Bills.tsx';
import { Dashboard } from './tabs/Dashboard.tsx';
import { Gold } from './tabs/Gold.tsx';
import { Income } from './tabs/Income.tsx';
import { Purchases } from './tabs/Purchases.tsx';
import { Settings } from './tabs/Settings.tsx';

const TABS: Readonly<Record<TabId, () => preact.JSX.Element>> = {
  dashboard: Dashboard,
  income: Income,
  bills: Bills,
  purchases: Purchases,
  savings: Accounts,
  gold: Gold,
  settings: Settings
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
     the diffing gives for free and the old teardown had to rescue by hand. */
  useEffect(() => { window.scrollTo(0, 0); }, [tabId]);

  if (bootError.value) {
    return <Splash title="Could not start" lines={[bootError.value, 'Try opening this file in Chrome or Edge.']} />;
  }
  if (booting.value) {
    return <Splash title="Income Tracker" lines={['Opening your database…']} />;
  }

  // Read so the frame redraws with the data, not only with the route.
  app.value;

  const Tab = TABS[tabId];

  return (
    <>
      <Topbar />
      <main>
        <StorageNotice />
        <Tab key={tabId} />
      </main>
      <Toast />
    </>
  );
}
