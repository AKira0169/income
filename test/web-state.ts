/* Web state test: the browser's half of the wire, against a fake server.
   Boot loads then catches up; a write applies exactly the change it was sent;
   a version that skips ahead means another device wrote, so the whole state is
   fetched again; writes go one at a time; failures are errors with the
   server's own words.

   Run:  node test/web-state.ts */

import { blankState, upsert as domainUpsert } from '../src/domain/records.ts';
import type { AppState } from '../src/domain/types.ts';
import { reconcile, remove, upsert } from '../src/web/state/actions.ts';
import { ApiError, currentVersion, inFlight, onUnauthorized } from '../src/web/state/api.ts';
import { app, booting, reachable } from '../src/web/state/app.ts';
import { boot, resetApp } from '../src/web/state/boot.ts';
import { check, finish, title } from './support/check.ts';

type Reply = { status: number; body: unknown };
let route: (method: string, path: string, body: string | undefined) => Reply | Promise<Reply>;
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${String(input)}`);
  const reply = await route(method, String(input), init?.body as string | undefined);
  return new Response(JSON.stringify(reply.body), { status: reply.status });
}) as typeof fetch;

const serverState: AppState = domainUpsert(blankState(), 'accounts',
  { id: 'acc_1', name: 'Card', type: 'Current Account', opening: 100, target: 0, notes: '' }).state;
const none = { income: 0, bills: 0, total: 0 };
const tea = { id: 'pur_1', goalId: null, date: '2026-07-02', item: 'Tea', category: 'Groceries', amount: 250, accountId: 'acc_1', method: 'Cash', notes: '' };

title('boot');
route = (_method, path) => path === '/api/state'
  ? { status: 200, body: { version: 4, state: serverState } }
  : { status: 200, body: { version: 4, changes: {}, result: none } };
const outcome = await boot();
check('loads the state, then asks for the catch-up', calls, ['GET /api/state', 'POST /api/recurring/catch-up']);
check('and reports what the catch-up added', outcome, { added: none });
check('the signal holds the server\'s state', app.peek().accounts.map((a) => a.id), ['acc_1']);
check('boot is over', booting.peek(), false);
check('the version is the server\'s', currentVersion(), 4);
check('booting twice does not load twice', [await boot(), calls.length], [{ added: none }, 2]);

title('a write');
route = () => ({ status: 200, body: { version: 5, changes: { purchases: { upserts: [tea], deletes: [] } }, result: tea } });
const saved = await upsert('purchases', { item: 'Tea', amount: 250 });
check('returns the saved record, as it always has', saved.item, 'Tea');
check('applies the change to the signal', app.peek().purchases.map((p) => p.id), ['pur_1']);
check('and moves the version on by one', currentVersion(), 5);
check('nothing is left in flight', inFlight.peek(), 0);

title('another device wrote in between');
calls.length = 0;
const both = { ...serverState, purchases: [tea, { ...tea, id: 'pur_2' }] };
route = (_method, path) => path === '/api/state'
  ? { status: 200, body: { version: 7, state: both } }
  : { status: 200, body: { version: 7, changes: { purchases: { upserts: [], deletes: [] } }, result: null } };
await remove('purchases', 'pur_9');
check('a version two ahead means the state is fetched again', calls, ['DELETE /api/purchases/pur_9', 'GET /api/state']);
check('and the other device\'s record appears', app.peek().purchases.length, 2);
check('at the server\'s version', currentVersion(), 7);

title('a write that changed nothing');
calls.length = 0;
route = () => ({ status: 200, body: { version: 7, changes: {}, result: 0 } });
check('answers with its result', await reconcile('acc_1', 100, '2026-07-31'), 0);
check('and fetches nothing more', calls, ['POST /api/accounts/acc_1/reconcile']);

title('failures');
route = () => ({ status: 400, body: { error: { code: 'domain', message: 'This file is not an Income Tracker backup.' } } });
let failed: unknown = null;
try { await upsert('purchases', { item: 'x' }); } catch (err) { failed = err; }
check('a refused write is an ApiError with the server\'s message',
  [failed instanceof ApiError, (failed as ApiError).status, (failed as Error).message],
  [true, 400, 'This file is not an Income Tracker backup.']);
check('and the state is untouched', app.peek().purchases.length, 2);
route = () => { throw new TypeError('fetch failed'); };
failed = null;
try { await upsert('purchases', { item: 'x' }); } catch (err) { failed = err; }
check('no server at all is code "offline"', (failed as ApiError).code, 'offline');
check('and the page knows it is offline', reachable.peek(), false);
route = () => ({ status: 200, body: { version: 7, changes: {}, result: tea } });
await upsert('purchases', tea);
check('the next answer brings it back', reachable.peek(), true);
let signedOut = 0;
onUnauthorized(() => { signedOut++; });
route = () => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in to continue.' } } });
try { await upsert('purchases', tea); } catch { /* expected */ }
check('a 401 hands over to the sign-in screen', signedOut, 1);

title('writes go one at a time');
let active = 0;
let most = 0;
let next = 7;
route = async () => {
  active++; most = Math.max(most, active);
  await new Promise((r) => setTimeout(r, 20));
  active--;
  next++;
  return { status: 200, body: { version: next, changes: {}, result: tea } };
};
await Promise.all([upsert('purchases', tea), upsert('purchases', tea), upsert('purchases', tea)]);
check('never more than one in flight', most, 1);
check('and every version was applied in order', currentVersion(), 10);

title('signing out');
resetApp();
check('forgets the state and the version', [app.peek().purchases.length, currentVersion()], [0, 0]);

finish();
