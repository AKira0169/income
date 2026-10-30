/* state/route.ts — which screen, which tab and which month, kept in the path.

   `/bills/2026-07`, `/login`, `/settings/security`. Real paths rather than the
   hash the file:// build needed: Caddy answers every path with index.html
   (try_files), so a reload lands where you were and a month of a tab can be
   bookmarked. Back and forward arrive as popstate.

   Signals are written straight away rather than waiting for any event: a click
   must take effect in the same turn it happened. */

import { signal } from '@preact/signals';
import { currentPeriod } from '../../domain/period.ts';
import type { Period } from '../../domain/types.ts';

export type TabId = 'dashboard' | 'income' | 'bills' | 'purchases' | 'savings' | 'goals' | 'gold' | 'settings';

export const TAB_IDS: readonly TabId[] = [
  'dashboard', 'income', 'bills', 'purchases', 'savings', 'goals', 'gold', 'settings'
];

export type AuthRoute = 'login' | 'registration' | 'recovery' | 'verification' | 'settings/security' | 'error';

const AUTH_ROUTES: readonly AuthRoute[] = [
  'login', 'registration', 'recovery', 'verification', 'settings/security', 'error'
];

const isTab = (value: string): value is TabId => (TAB_IDS as readonly string[]).includes(value);
const isPeriod = (value: string): boolean => /^\d{4}-\d{2}$/.test(value);

export const tab = signal<TabId>('dashboard');
export const period = signal<Period>(currentPeriod());
/** Set while a sign-in screen is showing; null for the app itself. */
export const authRoute = signal<AuthRoute | null>(null);
/** The query string, which the sign-in screens read (?flow=…, ?aal=…). */
export const search = signal('');

export interface ParsedPath {
  auth: AuthRoute | null;
  tab: TabId | null;
  period: Period | null;
}

/** Auth screens first: /settings/security must not read as the Settings tab. */
export function parsePath(pathname: string): ParsedPath {
  const clean = pathname.replace(/^\/+|\/+$/g, '');
  if ((AUTH_ROUTES as readonly string[]).includes(clean)) {
    return { auth: clean as AuthRoute, tab: null, period: null };
  }
  const [rawTab = '', rawPeriod = ''] = clean.split('/');
  return {
    auth: null,
    tab: isTab(rawTab) ? rawTab : null,
    period: isTab(rawTab) && isPeriod(rawPeriod) ? rawPeriod : null
  };
}

export const pathFor = (t: TabId, p: Period): string => `/${t}/${p}`;

/** Unreadable parts keep whatever is on screen. */
function apply(pathname: string, query: string): void {
  const parsed = parsePath(pathname);
  authRoute.value = parsed.auth;
  search.value = query;
  if (parsed.tab) tab.value = parsed.tab;
  if (parsed.period) period.value = parsed.period;
}

export function go(next: { tab?: TabId; period?: Period }): void {
  if (next.tab) tab.value = next.tab;
  if (next.period) period.value = next.period;
  authRoute.value = null;
  search.value = '';
  const target = pathFor(tab.peek(), period.peek());
  if (globalThis.location?.pathname !== target || globalThis.location?.search) {
    history.pushState(null, '', target);
  }
}

export const goTab = (id: TabId): void => go({ tab: id });
export const goPeriod = (p: Period): void => go({ period: p });

/** Any address inside the app, including the sign-in screens. */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const url = new URL(to, location.origin);
  const target = url.pathname + url.search;
  if (options.replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  apply(url.pathname, url.search);
}

/** Called once at start-up. A bare / is written out as the tab and month it
    shows, so the first tab change is not the entry the back button returns to. */
export function startRouting(): void {
  apply(location.pathname, location.search);
  window.addEventListener('popstate', () => apply(location.pathname, location.search));
  if (!authRoute.peek()) {
    const target = pathFor(tab.peek(), period.peek());
    if (location.pathname !== target) history.replaceState(null, '', target);
  }
}
