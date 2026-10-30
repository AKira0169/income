/* Repository test: a state written to Postgres reads back as the same state,
   writes are exactly the diff, and one user's rows are invisible to another —
   through the repository, and through RLS with the repository bypassed.

   Needs the test database:  pnpm db:test:up
   Run:  node test/repo.ts */

import { blankState, remove, upsert } from '../src/domain/records.ts';
import type { AppState } from '../src/domain/types.ts';
import { withUser } from '../server/db.ts';
import type { Tx } from '../server/db.ts';
import { diffState, sameJson } from '../server/diff.ts';
import {
  ensureUser, getRecord, listRecords, loadGoldPrices, loadState, readVersion, saveState,
  upsertGoldPrice, writeDiff
} from '../server/repo.ts';
import { normalizeState } from '../server/schema.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';
import { fixtureState } from './support/fixture.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const db = await freshDatabase();
const as = <T>(user: string, work: (tx: Tx) => Promise<T>): Promise<T> => withUser(db.sql, user, work);

await as(A, (tx) => ensureUser(A, tx));
await as(B, (tx) => ensureUser(B, tx));

title('round trip');
const fixture = fixtureState();
const v1 = await as(A, (tx) => saveState(A, tx, fixture));
const loaded = await as(A, (tx) => loadState(A, tx));
check('the version moved once', [v1, loaded.version], [1, 1]);
const comparable = (s: AppState) => ({ ...normalizeState(s), settings: { ...s.settings, baseCurrency: 'EGP' } });
check('every collection and setting reads back exactly', sameJson(comparable(loaded.state), comparable(fixture)), true);
check('money is a number, not a string', typeof loaded.state.income[0]?.amount, 'number');
check('a fractional meter reading survives', loaded.state.bills.find((b) => b.id === 'bil_elec')?.units, 412.5);
check('an empty date stays empty', loaded.state.bills.find((b) => b.id === 'bil_2026-07')?.paidDate, '');
check('rows come back in the order they were written',
  loaded.state.accounts.map((a) => a.id), fixture.accounts.map((a) => a.id));
check('settings gain a base currency from the currency code',
  (loaded.state.settings as unknown as { baseCurrency?: string }).baseCurrency, 'EGP');
const [currency] = await db.admin<{ currency: string }[]>`select currency from accounts where user_id = ${A}::uuid limit 1`;
check('accounts are written in the base currency', currency?.currency, 'EGP');

title('writes are the diff');
check('saving an unchanged state writes nothing', await as(A, (tx) => saveState(A, tx, loaded.state)), 1);
const next = remove(upsert(loaded.state, 'purchases', { id: 'pur_food', amount: 1 }).state, 'goals', 'gol_gpu');
const v3 = await as(A, (tx) => writeDiff(A, tx, diffState(loaded.state, next), 'EGP'));
const after = await as(A, (tx) => loadState(A, tx));
check('one write, one version', v3, 2);
check('the update landed', after.state.purchases.find((p) => p.id === 'pur_food')?.amount, 1);
check('the delete landed', after.state.goals.some((g) => g.id === 'gol_gpu'), false);

title('isolation through the repository');
check('B sees none of A\'s rows', (await as(B, (tx) => loadState(B, tx))).state.income.length, 0);
check('B cannot fetch A\'s record by id', await as(B, (tx) => getRecord(B, tx, 'purchases', 'pur_food')), null);
await as(B, (tx) => saveState(B, tx, upsert(blankState(), 'purchases', { id: 'pur_food', item: 'B\'s own', amount: 7 }).state));
check('B may use the same id for its own record',
  (await as(B, (tx) => listRecords(B, tx, 'purchases'))).map((p) => p.item), ['B\'s own']);
check('and A\'s record is untouched', (await as(A, (tx) => getRecord(A, tx, 'purchases', 'pur_food')))?.amount, 1);
check('versions are per user',
  [await as(A, (tx) => readVersion(A, tx)), await as(B, (tx) => readVersion(B, tx))], [2, 1]);

title('isolation by RLS alone (repository bypassed)');
const raw = await as(B, async (tx) => ({
  read: (await tx`select id from income where user_id = ${A}::uuid`).length,
  updated: (await tx`update purchases set amount = 0 where user_id = ${A}::uuid`).count,
  deleted: (await tx`delete from accounts where user_id = ${A}::uuid`).count,
  users: (await tx`select id from users`).length
}));
check('B reads none of A\'s rows even when it asks for them by user_id', raw.read, 0);
check('B updates none of them', raw.updated, 0);
check('B deletes none of them', raw.deleted, 0);
check('B sees only its own users row', raw.users, 1);
let refused = '';
try {
  await as(B, async (tx) => { await tx`insert into purchases (user_id, id) values (${A}::uuid, 'planted')`; });
} catch (err) { refused = (err as { code?: string }).code ?? ''; }
check('B cannot write a row into A\'s data', refused, '42501');
const outside = await db.sql<{ n: number }[]>`select count(*)::int as n from income`;
check('with no user set, nothing is visible at all', outside[0]?.n, 0);
check('A\'s data is all still there',
  (await as(A, (tx) => listRecords(A, tx, 'accounts'))).length, fixture.accounts.length);

title('shared gold prices');
await upsertGoldPrice(db.sql, { id: 'gpr_2026-07-29', date: '2026-07-29', usdPerOz: 3110.34768, egpPerUsd: 10, egpPerGram24: 100000, source: 'test', fetchedAt: '2026-07-29T08:00:00.000Z' });
await upsertGoldPrice(db.sql, { id: 'gpr_2026-07-29', date: '2026-07-29', usdPerOz: 3200, egpPerUsd: 10, egpPerGram24: 102890, source: 'test', fetchedAt: '2026-07-29T09:00:00.000Z' });
check('a same-day reading replaces the earlier one',
  (await loadGoldPrices(db.sql)).map((p) => [p.id, p.egpPerGram24]), [['gpr_2026-07-29', 102890]]);
check('every user\'s state carries them', (await as(B, (tx) => loadState(B, tx))).state.goldPrices.length, 1);

await db.close();
finish();
