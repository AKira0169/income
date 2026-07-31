/* ui/Topbar.tsx — the frame: which month, which tab, and the way out to Excel.

   Reads app.value and the route signals directly and passes them into the
   domain functions. Calling the old-arity wrappers in store.ts here would
   render once and then never update — they read a plain binding, not a signal. */

import { useState } from 'preact/hooks';
import { currentPeriod, periodLabel, shiftPeriod } from '../domain/period.ts';
import { activePeriods } from '../domain/selectors.ts';
import { app } from '../state/app.ts';
import { go, period as routePeriod, tab as routeTab } from '../state/route.ts';
import type { TabId } from '../state/route.ts';
import type { AppState, Period } from '../domain/types.ts';
import { ExportDialog } from './components/ExportDialog.tsx';

declare const __BUILD__: string | undefined;

interface Tab { id: TabId; label: string }

const TABS: readonly Tab[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'income', label: 'Income' },
  { id: 'bills', label: 'Bills' },
  { id: 'purchases', label: 'Purchases' },
  { id: 'savings', label: 'Accounts' },
  { id: 'goals', label: 'Goals' },
  { id: 'gold', label: 'Gold' },
  { id: 'settings', label: 'Settings' }
];

/** Months either side of today that are always offered, whether or not they
    hold anything — you should be able to look ahead and behind. */
const PERIOD_RANGE = 13;

function periodOptions(state: AppState, showing: Period): Period[] {
  const periods = new Set(activePeriods(state));
  const current = currentPeriod();
  for (let i = -PERIOD_RANGE; i <= PERIOD_RANGE; i++) periods.add(shiftPeriod(current, i));
  periods.add(showing);
  return [...periods].sort().reverse();
}

export function Topbar() {
  const state = app.value;
  const showing = routePeriod.value;
  const active = routeTab.value;
  const locale = state.settings.locale;
  const [exporting, setExporting] = useState(false);

  return (
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand">
          <b>Income Tracker</b>
          {typeof __BUILD__ === 'string'
            ? <span title="The build you are running">{__BUILD__}</span>
            : null}
        </div>
        <div class="period-nav">
          <button
            class="quiet"
            aria-label="Previous month"
            onClick={() => go({ period: shiftPeriod(showing, -1) })}
          >‹</button>
          <select
            aria-label="Month"
            value={showing}
            onChange={(e) => go({ period: (e.target as HTMLSelectElement).value })}
          >
            {periodOptions(state, showing).map((p) => (
              <option key={p} value={p}>{periodLabel(p, locale)}</option>
            ))}
          </select>
          <button
            class="quiet"
            aria-label="Next month"
            onClick={() => go({ period: shiftPeriod(showing, 1) })}
          >›</button>
          <button class="quiet" onClick={() => go({ period: currentPeriod() })}>Today</button>
        </div>
        <button class="primary" onClick={() => setExporting(true)}>Export to Excel</button>
      </div>
      <nav class="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            class="tab"
            role="tab"
            aria-selected={active === t.id ? 'true' : 'false'}
            onClick={() => go({ tab: t.id })}
          >{t.label}</button>
        ))}
      </nav>
      {exporting ? (
        <ExportDialog period={showing} settings={state.settings} onClose={() => setExporting(false)} />
      ) : null}
    </header>
  );
}
