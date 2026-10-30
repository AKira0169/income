/* API records test: the generic collection endpoints, and the isolation rule
   seen from outside — user B gets 404 for anything of user A's, and never sees
   a single row of it.

   Needs the test database:  pnpm db:test:up
   Run:  node test/api-records.ts */

import type { Bill, Purchase } from '../src/domain/types.ts';
import type { ErrorBody, MutationResponse, StateResponse } from '../src/wire.ts';
import { createApp } from '../server/app.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';
import { as, ORIGIN, stubWhoami, USER_A, USER_B } from './support/http.ts';

const db = await freshDatabase();
const app = createApp({ sql: db.sql, whoami: stubWhoami(), appOrigin: ORIGIN, log: () => {} });
const a = as(app, USER_A);
const b = as(app, USER_B);
const tea = { id: 'pur_1', goalId: null, date: '2026-07-02', item: 'Tea', category: 'Groceries', amount: 250, accountId: '', method: 'Cash', notes: '' };

title('create, read, update, delete');
const created = await a.post<MutationResponse<Purchase>>('/api/purchases', tea);
check('POST answers with the saved record', [created.status, created.body.result.item, created.body.result.amount], [200, 'Tea', 250]);
check('and the first version', created.body.version, 1);
check('and the change to apply', created.body.changes.purchases?.upserts.map((r) => r.id), ['pur_1']);
const fresh = await a.post<MutationResponse<Purchase>>('/api/purchases', { item: 'Bread', amount: 100 });
check('a record without an id gets one with its collection\'s prefix', fresh.body.result.id.startsWith('pur_'), true);
check('GET lists the collection', (await a.get<Purchase[]>('/api/purchases')).body.length, 2);
check('GET by id returns one', (await a.get<Purchase>('/api/purchases/pur_1')).body.amount, 250);
const edited = await a.put<MutationResponse<Purchase>>('/api/purchases/pur_1', { amount: 300 });
check('PUT merges into the record, as upsert always has',
  [edited.body.result.amount, edited.body.result.item], [300, 'Tea']);
check('PUT of a record that does not exist is 404',
  (await a.put<ErrorBody>('/api/purchases/pur_missing', { amount: 1 })).status, 404);
const unchanged = await a.post<MutationResponse<Purchase>>('/api/purchases', { ...tea, amount: 300 });
check('a write that changes nothing leaves the version alone', unchanged.body.version, edited.body.version);
const removed = await a.del<MutationResponse<null>>('/api/purchases/pur_1');
check('DELETE answers with the delete to apply', removed.body.changes.purchases?.deletes, ['pur_1']);
check('deleting it again is 404', (await a.del<ErrorBody>('/api/purchases/pur_1')).status, 404);

title('domain rules still apply');
const bill = await a.post<MutationResponse<Bill>>('/api/bills', { id: 'bil_1', name: 'Water', dueDate: '2026-08-09', amount: 1, paidDate: '' });
check('a bill\'s period and status are derived from its dates', [bill.body.result.period, bill.body.result.status], ['2026-08', 'unpaid']);
await a.post('/api/accounts', { id: 'acc_x', name: 'X', type: 'Savings', opening: 0, target: 0, notes: '' });
await a.post('/api/savingsTx', { id: 'sav_x', date: '2026-07-01', accountId: 'acc_x', fromAccountId: '', direction: 'in', amount: 5, notes: '' });
const cascade = await a.del<MutationResponse<null>>('/api/accounts/acc_x');
check('deleting an account takes its movements with it', cascade.body.changes.savingsTx?.deletes, ['sav_x']);

title('validation');
const bad = await a.post<ErrorBody>('/api/purchases', { amount: { nested: true } });
check('a field of the wrong shape is 400 invalid_body', [bad.status, bad.body.error.code], [400, 'invalid_body']);
check('gold prices cannot be written', (await a.post<ErrorBody>('/api/goldPrices', { id: 'gpr_x' })).body.error.code, 'unknown_collection');
check('nor can a collection that does not exist be read', (await a.get<ErrorBody>('/api/nonsense')).status, 404);
check('a body that is not JSON is 400 invalid_json',
  (await a.raw<ErrorBody>('POST', '/api/purchases', '{')).body.error.code, 'invalid_json');

title('settings');
const patched = await a.patch<MutationResponse<null>>('/api/settings', { savingsGoalRate: 30 });
check('PATCH answers with the settings it stored', patched.body.settings?.savingsGoalRate, 30);
check('and the state agrees', (await a.get<StateResponse>('/api/state')).body.state.settings.savingsGoalRate, 30);
check('an unknown setting is refused', (await a.patch<ErrorBody>('/api/settings', { savingsGoalRates: 1 })).status, 400);

title('isolation');
await a.post('/api/purchases', { ...tea, id: 'pur_secret', item: 'A\'s secret' });
check('B cannot GET A\'s record by id', (await b.get<ErrorBody>('/api/purchases/pur_secret')).status, 404);
check('B cannot PUT it', (await b.put<ErrorBody>('/api/purchases/pur_secret', { amount: 0 })).status, 404);
check('B cannot DELETE it', (await b.del<ErrorBody>('/api/purchases/pur_secret')).status, 404);
check('B\'s list is empty', (await b.get<Purchase[]>('/api/purchases')).body, []);
const bState = (await b.get<StateResponse>('/api/state')).body.state;
check('B\'s state holds none of A\'s rows',
  [bState.purchases.length, bState.bills.length, bState.settings.savingsGoalRate], [0, 0, 20]);
const own = await b.post<MutationResponse<Purchase>>('/api/purchases', { ...tea, id: 'pur_secret', item: 'B\'s own' });
check('B writing the same id makes B\'s own record', own.body.result.item, 'B\'s own');
check('and A\'s is untouched', (await a.get<Purchase>('/api/purchases/pur_secret')).body.item, 'A\'s secret');

await db.close();
finish();
