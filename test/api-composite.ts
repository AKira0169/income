/* API composite test: every endpoint that is more than a single upsert
   produces the same state as calling the domain function directly, and two
   catch-ups at once cannot generate the same bill twice.

   Needs the test database:  pnpm db:test:up
   Run:  node test/api-composite.ts */

import { importJSON } from '../src/domain/backup.ts';
import { borrow, repay } from '../src/domain/debt.ts';
import { moveGoal, saveGoal } from '../src/domain/forecast.ts';
import { currentPeriod, shiftPeriod } from '../src/domain/period.ts';
import { blankState } from '../src/domain/records.ts';
import { reconcile } from '../src/domain/reconcile.ts';
import { catchUp, generateBills, generateIncome, linkGeneratedTo } from '../src/domain/recurring.ts';
import { accountBalance } from '../src/domain/selectors.ts';
import type { AppState, CatchUpResult } from '../src/domain/types.ts';
import type { ErrorBody, MutationResponse, StateResponse } from '../src/wire.ts';
import { createApp } from '../server/app.ts';
import { sameJson } from '../server/diff.ts';
import { upsertGoldPrice } from '../server/repo.ts';
import { normalizeState } from '../server/schema.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';
import { fixtureBackup } from './support/fixture.ts';
import { as, ORIGIN, stubWhoami, USER_A, USER_C } from './support/http.ts';
import { deterministicIds, markIds, rewindIds } from './support/ids.ts';

deterministicIds();
const db = await freshDatabase();
const app = createApp({ sql: db.sql, whoami: stubWhoami(), appOrigin: ORIGIN, log: () => {} });
const a = as(app, USER_A);
const stateOf = async (): Promise<AppState> => (await a.get<StateResponse>('/api/state')).body.state;

/** Calls the endpoint and the domain function on the same starting state, with
    the same ids, and checks they land in the same place. */
async function same<R>(
  label: string, call: () => Promise<{ status: number; body: unknown }>, direct: (s: AppState) => AppState
): Promise<MutationResponse<R>> {
  const before = await stateOf();
  const mark = markIds();
  const expected = direct(before);
  rewindIds(mark);
  const res = await call();
  check(`${label} answers 200`, res.status, 200);
  check(`${label} gives the same state as the domain call`, sameJson(comparable(await stateOf()), comparable(expected)), true);
  return res.body as MutationResponse<R>;
}

/** Stored form, minus the base currency the repository adds to settings. */
const comparable = (s: AppState) => ({ ...normalizeState(s), settings: { ...s.settings, baseCurrency: undefined } });

await upsertGoldPrice(db.sql, { id: 'gpr_2026-07-29', date: '2026-07-29', usdPerOz: 3110.34768, egpPerUsd: 10, egpPerGram24: 100000, source: 'test', fetchedAt: '' });

title('import');
const text = fixtureBackup();
const imported = await same<Record<string, number>>('import', () => a.raw('POST', '/api/backup/import', text),
  (s) => ({ ...importJSON(text).state, goldPrices: s.goldPrices }));
check('import says how many arrived', [imported.result['income'], imported.result['bills']], [3, 4]);
check('the shared gold prices are kept, not replaced by the file\'s', (await stateOf()).goldPrices.length, 1);
const junk = await a.raw<ErrorBody>('POST', '/api/backup/import', '{"hello":1}');
check('a file that is not a backup is refused with the domain\'s message',
  [junk.status, junk.body.error.message.startsWith('This file is not an Income Tracker backup')], [400, true]);

title('debts');
const taken = { name: 'Bank', amount: 250000, date: '2026-07-08', intoAccountId: 'acc_card' };
await same('borrow', () => a.post('/api/debts', taken), (s) => borrow(s, taken));
const debtId = (await stateOf()).accounts.find((x) => x.name === 'Brother')?.id ?? '';
const paid = { amount: 100000, date: '2026-07-20', fromAccountId: 'acc_card' };
await same('repay', () => a.post(`/api/debts/${debtId}/repay`, paid), (s) => repay(s, debtId, paid));
check('repaying something that is not a debt is 404',
  (await a.post<ErrorBody>('/api/debts/acc_pot/repay', paid)).status, 404);

title('reconcile');
const actual = accountBalance(await stateOf(), 'acc_card') - 12345;
const corrected = await same<number>('reconcile', () => a.post('/api/accounts/acc_card/reconcile', { actual, date: '2026-07-31' }),
  (s) => reconcile(s, 'acc_card', actual, '2026-07-31'));
check('it answers with the difference it corrected', corrected.result, -12345);
check('reconciling an account that does not exist is 404',
  (await a.post<ErrorBody>('/api/accounts/acc_nope/reconcile', { actual: 0, date: '2026-07-31' })).status, 404);

title('goals');
await a.post('/api/goals', { id: 'gol_x', name: 'Bike', price: 100000, priority: 3, boughtDate: '', notes: '' });
await a.post('/api/goals', { id: 'gol_y', name: 'Lamp', price: 5000, priority: 4, boughtDate: '', notes: '' });
await same('moveGoal', () => a.post('/api/goals/gol_y/move', { delta: -1 }), (s) => moveGoal(s, 'gol_y', -1));
const buy = { draft: { boughtDate: '2026-07-30' }, paid: { accountId: 'acc_card', method: 'Card' } };
await same('saveGoal (buying)', () => a.put('/api/goals/gol_x', buy),
  (s) => saveGoal(s, { ...buy.draft, id: 'gol_x' }, buy.paid));
await same('saveGoal (a new goal)', () => a.put('/api/goals/gol_new', { draft: { name: 'Chair', price: 1, priority: 9, boughtDate: '', notes: '' } }),
  (s) => saveGoal(s, { name: 'Chair', price: 1, priority: 9, boughtDate: '', notes: '', id: 'gol_new' }));

title('recurring');
await same<number>('generate bills', () => a.post('/api/recurring/generate', { collection: 'bills', period: '2026-09' }),
  (s) => generateBills(s, '2026-09').state);
await same<number>('generate income', () => a.post('/api/recurring/generate', { collection: 'income', period: '2026-09' }),
  (s) => generateIncome(s, '2026-09').state);
await a.post('/api/bills', { id: 'bil_orphan', templateId: 'tpl_rent', name: 'Rent', dueDate: '2030-01-01', amount: 5, accountId: '', paidDate: '' });
const link = { collection: 'billTemplates', template: { id: 'tpl_rent', accountId: 'acc_pot' } } as const;
const linked = await same<number>('link', () => a.post('/api/recurring/link', link),
  (s) => linkGeneratedTo(s, link.collection, link.template).state);
check('link answers with how many it linked', linked.result, 1);
const swept = await same<CatchUpResult>('catch-up', () => a.post('/api/recurring/catch-up'), (s) => catchUp(s).state);
check('catch-up answers with its counts', swept.result.total, swept.result.income + swept.result.bills);
check('a second catch-up adds nothing', (await a.post<MutationResponse<CatchUpResult>>('/api/recurring/catch-up')).body.result.total, 0);

title('two catch-ups at once');
const c = as(app, USER_C);
await c.post('/api/billTemplates', {
  id: 'tpl_c', name: 'Gym', category: 'Subscriptions', provider: '', frequency: 'Monthly', dueDay: 3,
  expected: 500, accountId: '', method: '', active: true, anchor: shiftPeriod(currentPeriod(), -2), generatedThrough: '', notes: ''
});
const [one, two] = await Promise.all([
  c.post<MutationResponse<CatchUpResult>>('/api/recurring/catch-up'),
  c.post<MutationResponse<CatchUpResult>>('/api/recurring/catch-up')
]);
check('both succeed', [one.status, two.status], [200, 200]);
check('between them they made three bills, once', [one.body.result.bills, two.body.result.bills].sort(), [0, 3]);
const [counted] = await db.admin<{ n: number }[]>`select count(*)::int as n from bills where user_id = ${USER_C}::uuid`;
check('and the table holds exactly three', counted?.n, 3);

title('backup and erase');
const backup = await app.request('/api/backup', { headers: { cookie: `ory_kratos_session=${USER_A}` } });
const backupText = await backup.text();
check('the backup is a JSON download', [backup.headers.get('content-type')?.startsWith('application/json'),
  /attachment; filename="income-tracker-backup-\d{4}-\d{2}-\d{2}\.json"/.test(backup.headers.get('content-disposition') ?? '')], [true, true]);
check('and is a backup the domain accepts', importJSON(backupText).counts.accounts, (await stateOf()).accounts.length);
await same('erase', () => a.del('/api/data'), (s) => ({ ...blankState(), goldPrices: s.goldPrices }));
check('nothing of A\'s is left', (await stateOf()).income.length, 0);

await db.close();
finish();
