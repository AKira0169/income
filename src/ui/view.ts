/* ui/view.ts — what the legacy screens think is on screen, and how they ask
   for a redraw.

   Everything here is on its way out. `view.tab` and `view.period` are now a
   mirror of the route signals, written by App.tsx before the tabs are built;
   `open` and `history` die with the tab that uses them, replaced by component
   state. What is left is `render()`, which no longer holds a registered
   callback — it bumps a signal the bridge reads, so a legacy handler asking for
   a redraw goes through exactly the same path as a data change. */

import { signal } from '@preact/signals';
import { el } from '../dom.ts';
import { currentPeriod } from '../domain/period.ts';
import type { Period } from '../domain/types.ts';
import type { TabId } from '../state/route.ts';

export type { TabId };

export interface ViewState {
  tab: TabId;
  period: Period;
  /** Which disclosure panels are unfolded, by key. */
  open: Record<string, boolean>;
  /** Which lists are showing all time rather than the month on screen. */
  history: Record<string, boolean>;
}

export const view: ViewState = {
  tab: 'dashboard',
  period: currentPeriod(),
  open: {},
  history: {}
};

/* Bumped by render(). The bridge reads it, so a legacy screen that changed
   something outside the state — unfolding a panel, switching to all-time —
   still redraws. */
export const legacyTick = signal(0);

export function render(): void { legacyTick.value++; }

export const isOpen = (key: string): boolean => !!view.open[key];

export function toggle(key: string): void {
  view.open[key] = !view.open[key];
  render();
}

/* Every list can be read two ways: the month on screen, which is the working
   view, or the whole history, which is what you go looking for when you want to
   know when something last happened. */
export const isAllTime = (key: string): boolean => !!view.history[key];

export function scopeToggle(key: string): HTMLDivElement {
  const all = isAllTime(key);
  const button = (label: string, wanted: boolean): HTMLButtonElement =>
    el('button', {
      class: `scope-btn${all === wanted ? ' is-on' : ''}`,
      'aria-pressed': all === wanted ? 'true' : 'false',
      text: label,
      onclick: () => { view.history[key] = wanted; render(); }
    });

  return el('div', { class: 'scope', role: 'group', 'aria-label': 'How much to show' }, [
    button('This month', false),
    button('All time', true)
  ]);
}
