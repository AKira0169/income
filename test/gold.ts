/* Gold price job test: once a day, shared by everyone, and as forgiving of an
   unreachable service as the browser fetcher was — a missing exchange rate
   still records today's gold price at yesterday's rate.

   Needs the test database:  pnpm db:test:up
   Run:  node test/gold.ts */

import { syncGoldPrice } from '../server/jobs.ts';
import { loadGoldPrices, upsertGoldPrice } from '../server/repo.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';

const db = await freshDatabase();

/** A fake network: each URL fragment maps to a body, or to a status code. */
const network = (routes: Record<string, unknown>): typeof fetch => async (input) => {
  const url = String(input);
  const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
  if (!hit || typeof hit[1] === 'number') return new Response('', { status: typeof hit?.[1] === 'number' ? hit[1] : 503 });
  return new Response(JSON.stringify(hit[1]), { status: 200 });
};
const healthy = network({ 'gold-api.com': { price: 3110.34768 }, 'open.er-api.com': { rates: { EGP: 10 } } });

title('nothing reachable, nothing before');
check('fails quietly and records nothing',
  [await syncGoldPrice(db.sql, { fetchImpl: network({}), today: () => '2026-07-28' }), (await loadGoldPrices(db.sql)).length],
  ['failed', 0]);

title('one reading a day');
check('the first sync of the day records one', await syncGoldPrice(db.sql, { fetchImpl: healthy, today: () => '2026-07-29' }), 'updated');
const first = await loadGoldPrices(db.sql);
check('priced per gram of pure gold, in minor units',
  first.map((p) => [p.id, p.egpPerGram24, p.source]), [['gpr_2026-07-29', 100000, 'world spot × USD/EGP']]);
check('a second sync the same day does nothing', await syncGoldPrice(db.sql, { fetchImpl: healthy, today: () => '2026-07-29' }), 'skipped');
check('forcing it replaces the day\'s reading rather than adding one',
  [await syncGoldPrice(db.sql, { fetchImpl: healthy, today: () => '2026-07-29', force: true }), (await loadGoldPrices(db.sql)).length],
  ['updated', 1]);

title('services failing');
const noRates = network({ 'gold-api.com': { price: 3200 }, 'er-api.com': 503, 'exchangerate-api.com': 503 });
check('without a rate it still records, at the previous rate',
  await syncGoldPrice(db.sql, { fetchImpl: noRates, today: () => '2026-07-30' }), 'updated');
const partial = (await loadGoldPrices(db.sql)).find((p) => p.date === '2026-07-30');
check('and says it is partial', [partial?.egpPerUsd, partial?.source], [10, 'partial (gold-api.com)']);
const fallback = network({ 'gold-api.com': { price: 3110.34768 }, 'open.er-api.com': 503, 'exchangerate-api.com': { rates: { EGP: 20 } } });
await syncGoldPrice(db.sql, { fetchImpl: fallback, today: () => '2026-07-31' });
check('the second rate service is tried when the first is down',
  (await loadGoldPrices(db.sql)).find((p) => p.date === '2026-07-31')?.egpPerGram24, 200000);

title('the table stays bounded');
for (let i = 0; i < 805; i++) {
  const date = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
  await upsertGoldPrice(db.sql, { id: `gpr_${date}`, date, usdPerOz: 1, egpPerUsd: 1, egpPerGram24: 1, source: 'old', fetchedAt: '' });
}
await syncGoldPrice(db.sql, { fetchImpl: healthy, today: () => '2026-08-02' });
check('a sync prunes to the newest 800 days', (await loadGoldPrices(db.sql)).length, 800);

await db.close();
finish();
