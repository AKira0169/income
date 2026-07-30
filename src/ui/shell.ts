/* ui/shell.ts — the frame around the tabs, and the draw loop itself.

   render() rebuilds #app wholesale. At personal-finance row counts that is a
   few milliseconds and it removes a whole class of stale-DOM bug, so the only
   things carried across a redraw are the ones a person would notice: the scroll
   position, and closing a calendar that is about to outlive its field. */

import { append, clear, el } from '../dom.ts';
import { close as closeDatePicker } from '../datepicker.ts';
import { isDue, refresh } from '../data/gold-price.ts';
import { init as initSqlite } from '../data/sqlite.ts';
import {
  activePeriods, attachPersistence, catchUp, currentPeriod, hydrate, periodLabel,
  plural, save as saveStore, shiftPeriod, storageAvailable
} from '../store.ts';
import { save as saveSqlite } from '../data/sqlite.ts';
import type { Period } from '../domain/types.ts';
import { openExportDialog } from './export-dialog.ts';
import { toast } from './feedback.ts';
import { renderAccounts } from './tabs/accounts.ts';
import { renderBills } from './tabs/bills.ts';
import { renderDashboard } from './tabs/dashboard.ts';
import { renderGold } from './tabs/gold.ts';
import { renderIncome } from './tabs/income.ts';
import { renderPurchases } from './tabs/purchases.ts';
import { renderSettings } from './tabs/settings.ts';
import { onRender, render, view } from './view.ts';
import type { TabId } from './view.ts';

/* Supplied by the build: the wasm binary, and a stamp of when the page was
   made. A browser holding an old copy of a file:// page is otherwise
   indistinguishable from a build that did not happen. */
declare const __SQL_WASM_B64__: string;
declare const __BUILD__: string | undefined;

interface Tab {
  id: TabId;
  label: string;
  render: () => HTMLElement;
}

const TABS: readonly Tab[] = [
  { id: 'dashboard', label: 'Dashboard', render: renderDashboard },
  { id: 'income', label: 'Income', render: renderIncome },
  { id: 'bills', label: 'Bills', render: renderBills },
  { id: 'purchases', label: 'Purchases', render: renderPurchases },
  { id: 'savings', label: 'Accounts', render: renderAccounts },
  { id: 'gold', label: 'Gold', render: renderGold },
  { id: 'settings', label: 'Settings', render: renderSettings }
];

/** Months either side of today that are always offered, whether or not they
    hold anything — you should be able to look ahead and behind. */
const PERIOD_RANGE = 13;

function periodOptions(): Period[] {
  const periods = new Set(activePeriods());
  const current = currentPeriod();
  for (let i = -PERIOD_RANGE; i <= PERIOD_RANGE; i++) periods.add(shiftPeriod(current, i));
  periods.add(view.period);
  return [...periods].sort().reverse();
}

function goTo(period: Period): void {
  view.period = period;
  render();
}

function renderTopbar(): HTMLElement {
  const select = el('select', {
    'aria-label': 'Month',
    onchange: (e: Event) => goTo((e.target as HTMLSelectElement).value)
  }, periodOptions().map((p) => el('option', { value: p, text: periodLabel(p) })));
  select.value = view.period;

  return el('header', { class: 'topbar' }, [
    el('div', { class: 'topbar-inner' }, [
      el('div', { class: 'brand' }, [
        el('b', { text: 'Income Tracker' }),
        typeof __BUILD__ === 'string'
          ? el('span', { title: 'The build you are running', text: __BUILD__ })
          : null
      ]),
      el('div', { class: 'period-nav' }, [
        el('button', {
          class: 'quiet', 'aria-label': 'Previous month', text: '‹',
          onclick: () => goTo(shiftPeriod(view.period, -1))
        }),
        select,
        el('button', {
          class: 'quiet', 'aria-label': 'Next month', text: '›',
          onclick: () => goTo(shiftPeriod(view.period, 1))
        }),
        el('button', { class: 'quiet', text: 'Today', onclick: () => goTo(currentPeriod()) })
      ]),
      el('button', { class: 'primary', text: 'Export to Excel', onclick: openExportDialog })
    ]),
    el('nav', { class: 'tabs', role: 'tablist' }, TABS.map((t) => el('button', {
      class: 'tab', role: 'tab',
      'aria-selected': view.tab === t.id ? 'true' : 'false',
      text: t.label,
      onclick: () => { view.tab = t.id; render(); }
    })))
  ]);
}

function storageNotice(): HTMLElement | null {
  if (storageAvailable) return null;
  return el('div', { class: 'notice danger', style: 'margin-bottom:24px' }, [
    el('strong', { text: 'Nothing is being saved. ' }),
    'This browser is blocking local storage, so anything you enter will be lost when you close ' +
    'the tab. Download a copy of your data from Settings before you leave.'
  ]);
}

function splash(title: string, ...lines: string[]): HTMLElement {
  return el('main', {}, [el('div', { class: 'boot' }, [
    el('h1', { text: title }),
    ...lines.map((text) => el('p', { class: 'muted', text }))
  ])]);
}

/* Which tab the page currently shows. Re-rendering in place — saving a row,
   opening a form — must not throw you back to the top; moving to another tab
   must not drop you halfway down it. Those are different situations and the
   scroll position is only worth keeping in the first. */
let rendered: TabId | null = null;

function draw(): void {
  const app = document.getElementById('app');
  if (!app) return;

  const sameTab = rendered === view.tab;
  const scroll = window.scrollY;
  /* The calendar hangs outside #app, so it would outlive the field it belongs
     to if a render happened while it was open. */
  closeDatePicker();
  clear(app);

  if (view.bootError) {
    append(app, splash('Could not start', view.bootError, 'Try opening this file in Chrome or Edge.'));
    return;
  }
  if (view.booting) {
    append(app, splash('Income Tracker', 'Opening your database…'));
    return;
  }

  const tab = TABS.find((t) => t.id === view.tab) ?? TABS[0]!;
  append(app, [renderTopbar(), el('main', {}, [storageNotice(), tab.render()])]);
  rendered = view.tab;
  window.scrollTo(0, sameTab ? scroll : 0);
}

export async function init(): Promise<void> {
  onRender(draw);
  draw(); // boot screen while the engine warms up

  try {
    const result = await initSqlite(__SQL_WASM_B64__);
    attachPersistence({
      save: (state) => saveSqlite(state).then(() => true).catch(() => false)
    });
    hydrate(result.state, result.backend !== 'memory');
    // Before the first render, so the month opens already filled in.
    const added = catchUp();
    view.booting = false;
    if (result.migrated) saveStore();
    draw();

    /* The price sync is the one thing here that reaches the network, so it
       happens after the app is already usable and never blocks it. Nothing
       announces itself: a quiet update is the point of "once a day". */
    if (isDue()) {
      void refresh().then((outcome) => { if (outcome.ok) draw(); });
    }

    if (result.migrated) {
      toast('Moved your existing records into the database');
    } else if (added.total) {
      const parts: string[] = [];
      if (added.income) parts.push(plural(added.income, 'income entry', 'income entries'));
      if (added.bills) parts.push(plural(added.bills, 'bill'));
      toast(`Added ${parts.join(' and ')} from your recurring set-up`);
    }
  } catch (err) {
    view.booting = false;
    view.bootError = err instanceof Error ? err.message : String(err);
    draw();
  }
}
