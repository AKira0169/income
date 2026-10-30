/* server/app.ts — the Hono app: middleware, then routes.

   Middleware order is the spec's: request id + log on everything; then, for
   /api/*, the session (401 without one), the Origin check on anything that is
   not a read (403), and the rate limit (429). The per-user lock is not
   middleware — it is taken inside each write's own transaction (mutate.ts),
   which is the only place it means anything. */

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { MeResponse, StateResponse } from '../src/wire.ts';
import { withUser } from './db.ts';
import type { Sql } from './db.ts';
import { HttpError, toErrorResponse } from './errors.ts';
import type { Identity } from './kratos.ts';
import { tokenBucket } from './ratelimit.ts';
import { ensureUser, loadState, readVersion } from './repo.ts';

export interface AppDeps {
  sql: Sql;
  whoami: (cookieHeader: string | undefined) => Promise<Identity | null>;
  /** `https://$APP_DOMAIN` — the only origin allowed to write. */
  appOrigin: string;
  rateLimit?: { capacity: number; perSecond: number };
  log?: (entry: Record<string, unknown>) => void;
}

export type AppEnv = { Variables: { requestId: string; identity: Identity; userId: string } };

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const allow = tokenBucket(deps.rateLimit ?? { capacity: 120, perSecond: 20 });
  /** Users whose row is known to exist, so first sight costs one insert. */
  const known = new Set<string>();

  app.use('*', async (c, next) => {
    // Not crypto.randomUUID: the api suites make that deterministic for the domain's ids.
    const requestId = randomBytes(8).toString('hex');
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);
    const started = performance.now();
    await next();
    log({
      requestId, method: c.req.method, path: c.req.path, status: c.res.status,
      ms: Math.round(performance.now() - started), user: c.get('userId') ?? null
    });
  });

  app.get('/healthz', (c) => c.text('ok'));

  app.use('/api/*', async (c, next) => {
    const identity = await deps.whoami(c.req.header('cookie'));
    if (!identity) throw new HttpError(401, 'unauthenticated', 'Sign in to continue.');
    if (!known.has(identity.id)) {
      await withUser(deps.sql, identity.id, (tx) => ensureUser(identity.id, tx));
      known.add(identity.id);
    }
    c.set('identity', identity);
    c.set('userId', identity.id);
    await next();
  });

  app.use('/api/*', async (c, next) => {
    if (!READS.has(c.req.method) && c.req.header('origin') !== deps.appOrigin) {
      throw new HttpError(403, 'bad_origin', 'This request did not come from the app.');
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    if (!allow(c.get('userId'))) {
      throw new HttpError(429, 'rate_limited', 'Too many requests — wait a moment and try again.');
    }
    await next();
  });

  app.get('/api/me', async (c) => {
    const identity = c.get('identity');
    const version = await withUser(deps.sql, identity.id, (tx) => readVersion(identity.id, tx));
    const body: MeResponse = { email: identity.email, verified: identity.verified, version };
    return c.json(body);
  });

  app.get('/api/state', async (c) => {
    const userId = c.get('userId');
    const loaded = await withUser(deps.sql, userId, (tx) => loadState(userId, tx));
    const body: StateResponse = { version: loaded.version, state: loaded.state };
    return c.json(body);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.' } }, 404));

  app.onError((err, c) => {
    const { status, body } = toErrorResponse(err);
    if (status === 500) log({ requestId: c.get('requestId'), error: err instanceof Error ? err.stack : String(err) });
    return c.json(body, status);
  });

  return app;
}
