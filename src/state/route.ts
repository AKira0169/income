/* state/route.ts — which tab and which month, kept in the address bar.

   `#/bills/2026-07`. Putting it in the hash rather than in a variable is what
   makes reload land where you were and makes back and forward step through the
   months you looked at — on a file:// page, where the hash is the only part of
   the URL that can be changed without a navigation.

   Signals are written straight away rather than waiting for the hashchange
   event, which fires a task later: a click must take effect in the same turn it
   happened. The hash is then brought into line, and the hashchange listener is
   what makes the back button work. Both directions land in `apply`. */

import { signal } from '@preact/signals';
import { currentPeriod } from '../domain/period.ts';
import type { Period } from '../domain/types.ts';

export type TabId = 'dashboard' | 'income' | 'bills' | 'purchases' | 'savings' | 'gold' | 'settings';

export const TAB_IDS: readonly TabId[] = [
  'dashboard', 'income', 'bills', 'purchases', 'savings', 'gold', 'settings'
];

const isTab = (value: string): value is TabId => (TAB_IDS as readonly string[]).includes(value);
const isPeriod = (value: string): boolean => /^\d{4}-\d{2}$/.test(value);

export const tab = signal<TabId>('dashboard');
export const period = signal<Period>(currentPeriod());

const hashFor = (t: TabId, p: Period): string => `#/${t}/${p}`;

/** Adopt a hash. Unreadable parts keep whatever is on screen, so a mistyped
    URL moves what it can rather than throwing you back to the dashboard. */
function apply(hash: string): void {
  const [rawTab = '', rawPeriod = ''] = hash.replace(/^#\/?/, '').split('/');
  if (isTab(rawTab)) tab.value = rawTab;
  if (isPeriod(rawPeriod)) period.value = rawPeriod;
}

export function go(next: { tab?: TabId; period?: Period }): void {
  if (next.tab) tab.value = next.tab;
  if (next.period) period.value = next.period;
  const target = hashFor(tab.peek(), period.peek());
  // Assigning an unchanged hash adds nothing to the history, but checking first
  // keeps the intent obvious.
  if (globalThis.location?.hash !== target) globalThis.location.hash = target;
}

export const goTab = (id: TabId): void => go({ tab: id });
export const goPeriod = (p: Period): void => go({ period: p });

/** Called once at start-up. Opening the file with no hash writes one, so the
    first tab change is not the entry the back button returns to. */
export function startRouting(): void {
  const initial = globalThis.location?.hash ?? '';
  if (initial) apply(initial);
  window.addEventListener('hashchange', () => apply(globalThis.location.hash));
  const target = hashFor(tab.peek(), period.peek());
  if (globalThis.location.hash !== target) globalThis.location.replace(target);
}
