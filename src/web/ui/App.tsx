/* ui/App.tsx — the whole page: the session gate, boot, frame, and whichever
   tab is on.

   Sign-in screens render on their own. Anything else needs a session: while
   Kratos is being asked there is a splash, with no session it is the login
   screen, and with one the state is loaded (once) and the tab is drawn. */

import { useEffect, useRef } from 'preact/hooks';
import { plural } from '../../domain/money.ts';
import { AuthScreen } from '../auth/screens.tsx';
import { session } from '../auth/session.ts';
import { app, bootError, booting, reachable } from '../state/app.ts';
import { boot } from '../state/boot.ts';
import type { BootOutcome } from '../state/boot.ts';
import { authRoute, navigate, tab as routeTab } from '../state/route.ts';
import type { TabId } from '../state/route.ts';
import { Toast, toast } from './components/Toast.tsx';
import { Topbar } from './Topbar.tsx';

import { Accounts } from './tabs/Accounts.tsx';
import { Bills } from './tabs/Bills.tsx';
import { Dashboard } from './tabs/Dashboard.tsx';
import { Gold } from './tabs/Gold.tsx';
import { Goals } from './tabs/Goals.tsx';
import { Income } from './tabs/Income.tsx';
import { Purchases } from './tabs/Purchases.tsx';
import { Settings } from './tabs/Settings.tsx';

const TABS: Readonly<Record<TabId, () => preact.JSX.Element>> = {
  dashboard: Dashboard,
  income: Income,
  bills: Bills,
  purchases: Purchases,
  savings: Accounts,
  goals: Goals,
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

function OfflineNotice() {
  if (reachable.value) return null;
  return (
    <div class="notice danger" style="margin-bottom:24px">
      <strong>Can't reach the server. </strong>
      Your last change may not have been saved. Check your connection — the app carries on as soon
      as the server answers again.
    </div>
  );
}
export function App() {
  const auth = authRoute.value;
  const who = session.value;
  const tabId = routeTab.value;
  const announced = useRef<Promise<BootOutcome | null> | null>(null);

  /* Booted once per sign-in (boot() remembers), and announced once. A quiet
     catch-up that moved a balance is alarming when it is not explained. */
  useEffect(() => {
    if (!who || auth) return;
    const outcome = boot();
    if (announced.current === outcome) return;
    announced.current = outcome;
    void outcome.then((result) => {
      if (!result?.added.total) return;
      const parts: string[] = [];
      if (result.added.income) parts.push(plural(result.added.income, 'income entry', 'income entries'));
      if (result.added.bills) parts.push(plural(result.added.bills, 'bill'));
      toast(`Added ${parts.join(' and ')} from your recurring set-up`);
    });
  }, [who, auth]);

  useEffect(() => {
    if (who === null && !auth) navigate('/login', { replace: true });
  }, [who, auth]);

  useEffect(() => { window.scrollTo(0, 0); }, [tabId]);

  if (auth) return <AuthScreen route={auth} />;
  if (who === undefined) return <Splash title="Income Tracker" lines={['Checking your session…']} />;
  if (who === null) return null;
  if (bootError.value) {
    return <Splash title="Could not start" lines={[bootError.value, 'Reload the page to try again.']} />;
  }
  if (booting.value) return <Splash title="Income Tracker" lines={['Loading your data…']} />;

  // Read so the frame redraws with the data, not only with the route.
  app.value;

  const Tab = TABS[tabId];
  return (
    <>
      <Topbar />
      <main>
        <OfflineNotice />
        <Tab key={tabId} />
      </main>
      <Toast />
    </>
  );
}
