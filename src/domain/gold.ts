/* domain/gold.ts — what the metal is worth, and what it cost.

   Gold is quoted worldwide in US dollars per troy ounce, so the Egyptian price
   per gram is that figure divided by 31.1034768 and multiplied by the pound
   rate. The arithmetic lives here so the fetcher, the screen and the tests all
   agree on the sum; fetching itself is in data/gold-price.ts. */

import { GRAMS_PER_OZ } from './catalog.ts';
import { periodOf, todayISO } from './period.ts';
import { withCollection } from './records.ts';
import { sum } from './selectors.ts';
import type {
  AppState, Cents, GoldEntry, GoldHolding, GoldPrice, GoldSummary, IsoDate, Period
} from './types.ts';

export const goldIn = (state: AppState, period: Period): GoldEntry[] =>
  state.gold.filter((r) => periodOf(r.date) === period);

/** What fraction of a gram is actually gold. 21k is 21 parts in 24. */
export function goldPurity(karat: number | string): number {
  const k = Number(karat);
  return (Number.isFinite(k) && k > 0 ? k : 24) / 24;
}

/** The most recent daily snapshot, or null if the price has never synced. */
export function latestGoldPrice(state: AppState): GoldPrice | null {
  let latest: GoldPrice | null = null;
  for (const p of state.goldPrices) {
    if (!latest || String(p.date) > String(latest.date)) latest = p;
  }
  return latest;
}

/* Price of one gram, in minor units.
   A price you typed in yourself is taken exactly as given — you read it off a
   shop's board, so it already includes their margin. A synced price is the
   world spot rate, which is the bourse figure rather than the counter figure,
   so the premium setting is added to it. */
export function goldPricePerGram(state: AppState, karat: number | string): Cents {
  const manual = Number(state.settings.goldManualPrice) || 0;
  let base: number;
  let premium: number;
  if (manual > 0) {
    base = manual;
    premium = 1;
  } else {
    const snapshot = latestGoldPrice(state);
    if (!snapshot) return 0;
    base = snapshot.egpPerGram24 || 0;
    premium = 1 + ((Number(state.settings.goldPremium) || 0) / 100);
  }
  return Math.round(base * premium * goldPurity(karat));
}

/* Spot price per gram of pure gold, in minor units, from usd/oz and the pound
   rate. Kept here so the fetcher and the tests agree on the sum. */
export function goldGramFromSpot(usdPerOz: number, egpPerUsd: number): Cents {
  const perGram = (Number(usdPerOz) / GRAMS_PER_OZ) * Number(egpPerUsd);
  return Number.isFinite(perGram) ? Math.round(perGram * 100) : 0;
}

export interface GoldPriceReading {
  date?: IsoDate;
  usdPerOz: number;
  egpPerUsd: number;
  source?: string;
}

/** Two years of daily readings is plenty to chart against; older ones only grow
    the database. */
const MAX_GOLD_PRICES = 800;

/* One snapshot a day: same-day refreshes replace, so the history is a clean
   daily series rather than one row per app launch. */
export function recordGoldPrice(
  state: AppState, reading: GoldPriceReading
): { state: AppState; record: GoldPrice } {
  const date = reading.date || todayISO();
  const record: GoldPrice = {
    id: `gpr_${date}`,
    date,
    usdPerOz: Number(reading.usdPerOz) || 0,
    egpPerUsd: Number(reading.egpPerUsd) || 0,
    egpPerGram24: goldGramFromSpot(reading.usdPerOz, reading.egpPerUsd),
    source: reading.source || '',
    fetchedAt: new Date().toISOString()
  };

  const idx = state.goldPrices.findIndex((p) => p.id === record.id);
  let prices = state.goldPrices.slice();
  if (idx === -1) prices.push(record);
  else prices[idx] = record;

  if (prices.length > MAX_GOLD_PRICES) {
    prices = prices
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-MAX_GOLD_PRICES);
  }
  return { state: withCollection(state, 'goldPrices', prices), record };
}

/** Grams held per karat, with what each pile is worth today. */
export function goldHoldings(state: AppState): GoldHolding[] {
  const byKarat = new Map<number, number>();
  for (const r of state.gold) {
    const karat = Number(r.karat) || 24;
    const grams = Number(r.grams) || 0;
    byKarat.set(karat, (byKarat.get(karat) ?? 0) + (r.direction === 'sell' ? -grams : grams));
  }
  return [...byKarat.entries()]
    .sort(([a], [b]) => b - a)
    .map(([karat, grams]) => ({
      karat,
      grams,
      value: Math.round(grams * goldPricePerGram(state, karat))
    }))
    // Floating-point grams never land exactly on zero once you have sold some.
    .filter((h) => Math.abs(h.grams) > 1e-9);
}

export function goldValue(state: AppState): Cents {
  return sum(goldHoldings(state), (h) => h.value);
}

/** Money actually put into gold: what you paid, less what selling gave back.
    Against goldValue() this is the gain or loss. */
export function goldInvested(state: AppState): Cents {
  return state.gold.reduce((total, r) => {
    const amount = r.amount || 0;
    return total + (r.direction === 'sell' ? -amount : amount);
  }, 0);
}

export function goldSummary(state: AppState): GoldSummary {
  const holdings = goldHoldings(state);
  const value = sum(holdings, (h) => h.value);
  const invested = goldInvested(state);
  return {
    value,
    invested,
    gain: value - invested,
    gainRate: invested > 0 ? (value - invested) / invested : 0,
    grams: sum(holdings, (h) => h.grams),
    pure: sum(holdings, (h) => h.grams * goldPurity(h.karat)),
    price: latestGoldPrice(state),
    manual: (Number(state.settings.goldManualPrice) || 0) > 0
  };
}
