/* server/gold-price.ts — the world gold price and the pound rate, fetched
   server-side once a day for everyone. Moved from the browser
   (src/data/gold-price.ts in the offline build) with the same two services and
   the same rule: a failure on one side never throws the other away. The shop
   premium and a typed-in price stay per-user settings, applied in the browser
   exactly as before. */

import type { GoldPrice } from '../src/domain/types.ts';

export type Fetch = typeof fetch;

const SPOT_URL = 'https://api.gold-api.com/price/XAU';
/* Tried in order; the second is the same provider's older endpoint, worth
   having when the first is rate-limited. */
const RATE_URLS = [
  'https://open.er-api.com/v6/latest/USD',
  'https://api.exchangerate-api.com/v4/latest/USD'
] as const;
const TIMEOUT_MS = 9000;

async function fetchJSON(fetchImpl: Fetch, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

async function fetchSpot(fetchImpl: Fetch): Promise<number> {
  const json = await fetchJSON(fetchImpl, SPOT_URL) as { price?: unknown } | null;
  const price = Number(json?.price);
  if (!Number.isFinite(price) || price <= 0) throw new Error('The gold price came back unreadable.');
  return price;
}

async function fetchRate(fetchImpl: Fetch): Promise<number> {
  for (const url of RATE_URLS) {
    try {
      const json = await fetchJSON(fetchImpl, url) as { rates?: { EGP?: unknown } } | null;
      const rate = Number(json?.rates?.EGP);
      if (Number.isFinite(rate) && rate > 0) return rate;
    } catch {
      // Try the next service; only the last failure is reported.
    }
  }
  throw new Error('Could not reach a currency service.');
}

export interface GoldReading {
  usdPerOz: number;
  egpPerUsd: number;
  source: string;
  partial: boolean;
  error: string | null;
}

export async function fetchGoldReading(previous: GoldPrice | null, fetchImpl: Fetch = fetch): Promise<GoldReading> {
  const [spot, rate] = await Promise.allSettled([fetchSpot(fetchImpl), fetchRate(fetchImpl)]);
  const usdPerOz = spot.status === 'fulfilled' ? spot.value : (previous?.usdPerOz ?? 0);
  const egpPerUsd = rate.status === 'fulfilled' ? rate.value : (previous?.egpPerUsd ?? 0);
  const failure = [spot, rate].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
  const error = failure ? String((failure.reason as Error)?.message ?? failure.reason) : null;
  if (!usdPerOz || !egpPerUsd) throw new Error(error ?? 'Could not reach the price service.');

  const reached: string[] = [];
  if (spot.status === 'fulfilled') reached.push('gold-api.com');
  if (rate.status === 'fulfilled') reached.push('exchangerate-api.com');
  const partial = reached.length < 2;
  return {
    usdPerOz, egpPerUsd, partial, error,
    source: partial ? `partial (${reached.join(', ')})` : 'world spot × USD/EGP'
  };
}
