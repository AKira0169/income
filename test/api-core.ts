/* API core test: who may call the api, from where, how often, and what an
   error looks like. Everything a route relies on before it runs.

   Needs the test database:  pnpm db:test:up
   Run:  node test/api-core.ts */

import { z } from 'zod';
import type { ErrorBody, MeResponse, StateResponse } from '../src/wire.ts';
import { createApp } from '../server/app.ts';
import { HttpError, toErrorResponse } from '../server/errors.ts';
import { kratosWhoami } from '../server/kratos.ts';
import { tokenBucket } from '../server/ratelimit.ts';
import { cachedWhoami, sessionToken } from '../server/session.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';
import { as, ORIGIN, stubWhoami, USER_A } from './support/http.ts';

const db = await freshDatabase();
const logs: Record<string, unknown>[] = [];
const app = createApp({ sql: db.sql, whoami: stubWhoami(), appOrigin: ORIGIN, log: (e) => logs.push(e) });
const a = as(app, USER_A);

title('health');
const health = await as(app, null).get<string>('/healthz');
check('/healthz needs no session', [health.status, health.body], [200, 'ok']);

title('authentication');
const anon = await as(app, null).get<ErrorBody>('/api/me');
check('no session is 401', [anon.status, anon.body.error.code], [401, 'unauthenticated']);
const forged = await as(app, 'not-a-session').get<ErrorBody>('/api/state');
check('a session Kratos does not know is 401', forged.status, 401);
const me = await a.get<MeResponse>('/api/me');
check('/api/me answers with the identity', [me.status, me.body.email, me.body.verified, me.body.version],
  [200, 'a1@example.test', false, 0]);
const [row] = await db.admin<{ n: number }[]>`select count(*)::int as n from users where id = ${USER_A}::uuid`;
check('the users row is created on first sight', row?.n, 1);
const state = await a.get<StateResponse>('/api/state');
check('a new user starts from a blank state at version 0',
  [state.status, state.body.version, state.body.state.income, state.body.state.settings.currencyCode],
  [200, 0, [], 'EGP']);

title('CSRF');
const foreign = await as(app, USER_A, 'https://evil.test').post<ErrorBody>('/api/recurring/catch-up');
check('a write from another origin is 403', [foreign.status, foreign.body.error.code], [403, 'bad_origin']);
const noOrigin = await as(app, USER_A, null).post<ErrorBody>('/api/recurring/catch-up');
check('a write with no Origin at all is 403', noOrigin.status, 403);
check('a read from another origin is allowed', (await as(app, USER_A, 'https://evil.test').get('/api/me')).status, 200);
const nowhere = await a.post<ErrorBody>('/api/no/such/endpoint/here');
check('an unknown endpoint is a JSON 404', [nowhere.status, nowhere.body.error.code], [404, 'not_found']);

title('request ids');
const id = me.headers.get('x-request-id') ?? '';
check('every response carries a request id', /^[0-9a-f]{16}$/.test(id), true);
check('and the log line names it', logs.some((l) => l['requestId'] === id && l['status'] === 200), true);

title('request size');
const huge = await a.raw<ErrorBody>('POST', '/api/purchases', JSON.stringify({ item: 'x'.repeat(300 * 1024) }));
check('a body over 256 KB is refused before it is read', [huge.status, huge.body.error.code], [413, 'too_large']);
const longText = await a.post<ErrorBody>('/api/purchases', { item: 'x'.repeat(20_001) });
check('a text field over 20 000 characters is refused', [longText.status, longText.body.error.code], [400, 'invalid_body']);
const overflow = await a.post<ErrorBody>('/api/purchases', { item: 'x', amount: 1e30 });
check('a number too big for its column is a 400, not a 500', [overflow.status, overflow.body.error.code], [400, 'invalid_value']);

title('rate limit');
const tight = createApp({ sql: db.sql, whoami: stubWhoami(), appOrigin: ORIGIN, rateLimit: { capacity: 2, perSecond: 0 }, log: () => {} });
const t = as(tight, USER_A);
const statuses = [(await t.get('/api/me')).status, (await t.get('/api/me')).status];
const limited = await t.get<ErrorBody>('/api/me');
check('within the bucket', statuses, [200, 200]);
check('past it, 429', [limited.status, limited.body.error.code], [429, 'rate_limited']);
let clock = 0;
const bucket = tokenBucket({ capacity: 1, perSecond: 2, now: () => clock });
check('a bucket refills with time', [bucket('k'), bucket('k'), (clock = 500, bucket('k'))], [true, false, true]);

title('error mapping');
const zod = z.object({ amount: z.number() }).safeParse({ amount: 'x' }).error;
check('a validation failure is 400 invalid_body', [toErrorResponse(zod).status, toErrorResponse(zod).body.error.code], [400, 'invalid_body']);
check('an HttpError keeps its status and code', toErrorResponse(new HttpError(404, 'not_found', 'No such record.')),
  { status: 404, body: { error: { code: 'not_found', message: 'No such record.' } } });
check('a duplicate generated row is 409', toErrorResponse(Object.assign(new Error('dup'), { code: '23505' })).status, 409);
check('a value Postgres cannot store is 400',
  toErrorResponse(Object.assign(new Error('out of range'), { code: '22003' })).body.error.code, 'invalid_value');
check('a record that breaks a rule of the table is 400',
  toErrorResponse(Object.assign(new Error('null value'), { code: '23502' })).body.error.code, 'invalid_record');
check('a sign-in service that does not answer in time is 503, not 500',
  toErrorResponse(new DOMException('The operation timed out.', 'TimeoutError')).status, 503);
check('bad JSON is 400', toErrorResponse(new SyntaxError('Unexpected token')).body.error.code, 'invalid_json');
const internal = toErrorResponse(new Error('connection string with a password in it'));
check('anything else is a 500 that says nothing about internals',
  [internal.status, internal.body.error.message], [500, 'Something went wrong on the server.']);

title('session cache');
check('the token is read from the cookie header', sessionToken('a=1; ory_kratos_session=tok=en; b=2'), 'tok=en');
check('no session cookie, no token', sessionToken('a=1'), null);
let lookups = 0;
let now = 0;
const cached = cachedWhoami(async () => { lookups++; return { id: 'x', email: 'x@x', verified: true }; },
  { ttlMs: 30_000, now: () => now });
await cached('ory_kratos_session=s1');
await cached('ory_kratos_session=s1');
check('a second call inside 30 s does not reach Kratos', lookups, 1);
now = 30_001;
await cached('ory_kratos_session=s1');
check('after 30 s it asks again', lookups, 2);
await cached('other=1');
check('a request without the cookie never reaches Kratos', lookups, 2);

title('server-to-Kratos whoami');
const kratos = kratosWhoami('http://kratos:4433', async (input, init) => {
  const cookie = new Headers(init?.headers).get('cookie');
  check('the browser cookie is forwarded', [String(input), cookie], ['http://kratos:4433/sessions/whoami', 'ory_kratos_session=ok']);
  return new Response(JSON.stringify({ active: true, identity: { id: USER_A, traits: { email: 'me@x.test' },
    verifiable_addresses: [{ value: 'me@x.test', verified: true }] } }), { status: 200 });
});
check('an active session is an identity', await kratos('ory_kratos_session=ok'), { id: USER_A, email: 'me@x.test', verified: true });
const refused = kratosWhoami('http://kratos:4433', async () => new Response('{}', { status: 401 }));
check('anything but 200 is no identity', await refused('ory_kratos_session=old'), null);
const aal2 = kratosWhoami('http://kratos:4433', async () => new Response('{}', { status: 403 }));
check('a session still owing its second factor is no identity', await aal2('ory_kratos_session=half'), null);

await db.close();
finish();
