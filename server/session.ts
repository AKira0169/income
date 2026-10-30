/* server/session.ts — whoami, remembered for 30 seconds per session token.

   Every api request needs the user id, and asking Kratos each time would put a
   network hop in front of every keystroke-sized write. Only positive answers
   are kept: a request that was refused a moment ago should succeed as soon as
   the person has logged in. The cost is that a logged-out session can keep
   working for up to 30 s — the spec accepts that, and the in-memory cache is
   also why the api runs as a single instance. */

import type { Identity } from './kratos.ts';

export const SESSION_COOKIE = 'ory_kratos_session';

export function sessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

export interface SessionCacheOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
}

export function cachedWhoami(
  lookup: (cookieHeader: string) => Promise<Identity | null>, options: SessionCacheOptions = {}
) {
  const ttl = options.ttlMs ?? 30_000;
  const max = options.max ?? 1000;
  const now = options.now ?? Date.now;
  /* A Map iterates in insertion order, so re-inserting on every hit makes the
     first key the least recently used one. */
  const cache = new Map<string, { identity: Identity; until: number }>();

  return async (cookieHeader: string | undefined): Promise<Identity | null> => {
    const token = sessionToken(cookieHeader);
    if (!token || !cookieHeader) return null;
    const hit = cache.get(token);
    cache.delete(token);
    if (hit && hit.until > now()) {
      cache.set(token, hit);
      return hit.identity;
    }
    const identity = await lookup(cookieHeader);
    if (identity) {
      cache.set(token, { identity, until: now() + ttl });
      while (cache.size > max) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    return identity;
  };
}
