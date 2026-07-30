/* ui/view.ts — what is on screen, and the one way to ask for a redraw.

   This module imports nothing from the tab modules, and they all import from
   it. That is deliberate: the tabs need render(), and the shell needs the tabs,
   so anything holding both would close a cycle. The shell registers the real
   renderer here at start-up instead. */

import { el } from '../dom.ts';
import { currentPeriod } from '../store.ts';
import type { Period } from '../types.ts';

export type TabId = 'dashboard' | 'income' | 'bills' | 'purchases' | 'savings' | 'gold' | 'settings';

export interface ViewState {
  tab: TabId;
  period: Period;
  /** Which disclosure panels are unfolded, by key. */
  open: Record<string, boolean>;
  /** Which lists are showing all time rather than the month on screen. */
  history: Record<string, boolean>;
  booting: boolean;
  bootError: string | null;
}

export const view: ViewState = {
  tab: 'dashboard',
  period: currentPeriod(),
  open: {},
  history: {},
  booting: true,
  bootError: null
};

let renderer: (() => void) | null = null;

/** The shell calls this once with the real draw function. */
export function onRender(fn: () => void): void { renderer = fn; }

export function render(): void { renderer?.(); }

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
