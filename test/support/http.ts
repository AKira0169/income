/* test/support/http.ts — drive the api in-process through Hono's
   app.request(): no port, no Kratos. The whoami stub treats the session cookie
   as the identity id, which is all the api ever learns from Kratos anyway. */

import type { Hono } from 'hono';
import type { AppEnv } from '../../server/app.ts';
import type { Identity } from '../../server/kratos.ts';
import { sessionToken } from '../../server/session.ts';

export const ORIGIN = 'https://app.test';
export const USER_A = '00000000-0000-4000-8000-0000000000a1';
export const USER_B = '00000000-0000-4000-8000-0000000000b2';
export const USER_C = '00000000-0000-4000-8000-0000000000c3';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const stubWhoami = () => async (cookieHeader: string | undefined): Promise<Identity | null> => {
  const token = sessionToken(cookieHeader);
  return token && UUID.test(token) ? { id: token, email: `${token.slice(-2)}@example.test`, verified: false } : null;
};

export interface Reply<T> { status: number; body: T; headers: Headers }

export function as(app: Hono<AppEnv>, userId: string | null, origin: string | null = ORIGIN) {
  const call = async <T>(method: string, path: string, body?: unknown, raw?: string): Promise<Reply<T>> => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (userId) headers['cookie'] = `ory_kratos_session=${userId}`;
    if (origin) headers['origin'] = origin;
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path, { method, headers, body: payload });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* plain text, e.g. /healthz */ }
    return { status: res.status, body: parsed as T, headers: res.headers };
  };
  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
    put: <T>(path: string, body: unknown) => call<T>('PUT', path, body),
    patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
    del: <T>(path: string) => call<T>('DELETE', path),
    raw: <T>(method: string, path: string, text: string) => call<T>(method, path, undefined, text)
  };
}
