/* server/jobs.ts — work the api does on its own, in-process.

   Only one job: the daily gold price. It checks on start and then hourly, and
   does anything only when today has no reading yet — "once a day" is the whole
   specification, and an hourly check means a restart or a failed morning fetch
   is retried the same day rather than the next. The recurring catch-up is not
   a job: the browser asks for it after loading (POST /api/recurring/catch-up). */

import { goldGramFromSpot, latestGoldPrice } from '../src/domain/gold.ts';
import { todayISO } from '../src/domain/period.ts';
import { blankState } from '../src/domain/records.ts';
import type { IsoDate } from '../src/domain/types.ts';
import type { Sql } from './db.ts';
import { fetchGoldReading } from './gold-price.ts';
import type { Fetch } from './gold-price.ts';
import { loadGoldPrices, pruneGoldPrices, upsertGoldPrice } from './repo.ts';

export type SyncOutcome = 'skipped' | 'updated' | 'failed';

export interface SyncOptions {
  fetchImpl?: Fetch;
  today?: () => IsoDate;
  force?: boolean;
}

export async function syncGoldPrice(sql: Sql, options: SyncOptions = {}): Promise<SyncOutcome> {
  const today = (options.today ?? todayISO)();
  const latest = latestGoldPrice({ ...blankState(), goldPrices: await loadGoldPrices(sql) });
  if (!options.force && latest && latest.date >= today) return 'skipped';
  try {
    const reading = await fetchGoldReading(latest, options.fetchImpl);
    await upsertGoldPrice(sql, {
      id: `gpr_${today}`,
      date: today,
      usdPerOz: reading.usdPerOz,
      egpPerUsd: reading.egpPerUsd,
      egpPerGram24: goldGramFromSpot(reading.usdPerOz, reading.egpPerUsd),
      source: reading.source,
      fetchedAt: new Date().toISOString()
    });
    await pruneGoldPrices(sql);
    return 'updated';
  } catch {
    return 'failed';
  }
}

export interface JobOptions {
  intervalMs?: number;
  fetchImpl?: Fetch;
  log?: (entry: Record<string, unknown>) => void;
}

export function startJobs(sql: Sql, options: JobOptions = {}): { stop(): void } {
  const log = options.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const tick = (): void => {
    syncGoldPrice(sql, { fetchImpl: options.fetchImpl })
      .then((outcome) => { if (outcome !== 'skipped') log({ job: 'gold-price', outcome }); })
      .catch((err: unknown) => log({ job: 'gold-price', outcome: 'error', error: String(err) }));
  };
  tick();
  const timer = setInterval(tick, options.intervalMs ?? 60 * 60 * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
