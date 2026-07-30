/* gold.ts — the one thing in this app that touches the network.

   Gold is quoted worldwide in US dollars per troy ounce, so the Egyptian price
   per gram is that figure divided by 31.1034768 and multiplied by the pound
   rate. Two small public endpoints supply the two numbers; both send
   Access-Control-Allow-Origin: *, which is what makes this work from a file://
   page at all — verified against the live services, not assumed.

   Everything here is optional and failure is quiet. No reading is ever thrown
   away because a later fetch failed: the last good snapshot stays on screen with
   the date it was taken, and a price you type in yourself always wins. */

import { latestGoldPrice, recordGoldPrice, state, todayISO } from '../store.ts';
import type { GoldPrice } from '../domain/types.ts';

const SPOT_URL = 'https://api.gold-api.com/price/XAU';

/* Two rate services, tried in order. The second is the same provider's older
   endpoint, which is worth having when the first is rate-limited. */
const RATE_URLS = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.exchangerate-api.com/v4/latest/USD'
] as const;

const TIMEOUT_MS = 9000;

/* One automatic attempt per session. Without this, a machine that is offline
   re-tries on every render that asks whether a sync is due. */
let attempted = false;
let busy = false;
let lastError: string | null = null;

export const isBusy = (): boolean => busy;
export const getLastError = (): string | null => lastError;

async function fetchJSON(url: string): Promise<unknown> {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('This browser cannot fetch prices.');
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller?.signal
    });
    if (!res.ok) throw new Error(`The price service answered ${res.status}.`);
    return await res.json();
  } catch (err) {
    throw new Error(err instanceof Error && err.name === 'AbortError'
      ? 'The price service did not answer in time.'
      : 'Could not reach the price service.');
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSpot(): Promise<number> {
  const json = await fetchJSON(SPOT_URL) as { price?: unknown } | null;
  const price = Number(json?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('The gold price came back unreadable.');
  return price;
}

/** Walks the rate services until one answers with a pound rate. */
async function fetchRate(): Promise<number> {
  for (const url of RATE_URLS) {
    try {
      const json = await fetchJSON(url) as { rates?: { EGP?: unknown } } | null;
      const rate = Number(json?.rates?.EGP);
      if (Number.isFinite(rate) && rate > 0) return rate;
    } catch {
      // Try the next service; only the last failure is reported.
    }
  }
  throw new Error('Could not reach a currency service.');
}

/* True when today has no reading yet. "Once a day is enough" is the whole
   specification, so anything newer than midnight counts as current. */
export function isDue(): boolean {
  if (state.settings.goldSync === false) return false;
  const latest = latestGoldPrice();
  return !latest || String(latest.date) < todayISO();
}

export interface RefreshResult {
  ok: boolean;
  /** A refresh was already running. */
  busy?: boolean;
  /** Nothing was attempted: not due, or already tried this session. */
  skipped?: boolean;
  /** One of the two figures is carried over from the previous reading. */
  partial?: boolean;
  record?: GoldPrice;
  error?: string | null;
}

export interface RefreshOptions {
  /** A manual refresh always goes out; an automatic one gives up for the
      session after a miss. */
  manual?: boolean;
}

type Attempt = { ok: true; value: number } | { ok: false; error: Error };

const attempt = (p: Promise<number>): Promise<Attempt> =>
  p.then((value): Attempt => ({ ok: true, value }),
    (error: Error): Attempt => ({ ok: false, error }));

/** The message from whichever side failed, for reporting a partial or total miss. */
const errorOf = (a: Attempt): string | null => (a.ok ? null : a.error.message);

export async function refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
  if (busy) return { ok: false, busy: true };
  if (!options.manual) {
    if (attempted || !isDue()) return { ok: false, skipped: true };
    attempted = true;
  }
  busy = true;
  lastError = null;

  try {
    /* Both go out together, but a failure on one side must not discard the
       other: an unreachable currency service should still leave the gold price
       fresh, valued at yesterday's rate. */
    const [spot, rate] = await Promise.all([attempt(fetchSpot()), attempt(fetchRate())]);
    const previous = latestGoldPrice();

    const usdPerOz = spot.ok ? spot.value : (previous?.usdPerOz ?? 0);
    const egpPerUsd = rate.ok ? rate.value : (previous?.egpPerUsd ?? 0);

    if (!usdPerOz || !egpPerUsd) {
      lastError = errorOf(spot.ok ? rate : spot) ?? 'Could not reach the price service.';
      return { ok: false, error: lastError };
    }

    const reached: string[] = [];
    if (spot.ok) reached.push('gold-api.com');
    if (rate.ok) reached.push('exchangerate-api.com');

    const record = recordGoldPrice({
      usdPerOz,
      egpPerUsd,
      source: reached.length === 2 ? 'world spot × USD/EGP' : `partial (${reached.join(', ')})`
    });

    const partial = !spot.ok || !rate.ok;
    if (partial) lastError = errorOf(spot.ok ? rate : spot);
    return { ok: true, partial, record, error: lastError };
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    return { ok: false, error: lastError };
  } finally {
    busy = false;
  }
}
