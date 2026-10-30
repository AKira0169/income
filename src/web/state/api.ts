/* state/api.ts — the browser's side of the wire.

   Reads are plain requests. Writes go through mutate(), one at a time: each
   starts only once the previous one has answered, so the version a write
   answers with is always the one after the last — and when it is not, another
   device wrote in between and the whole state is fetched again rather than
   guessed at. A write answers with what changed (wire.ts), which is applied to
   the signal as a new object so the screen redraws.

   Failures are ApiErrors carrying the server's own message, which is written
   for a person; the caller decides where to show it. */

import { signal } from '@preact/signals';
import { applyChanges } from '../../wire.ts';
import type { ErrorBody, MutationResponse, StateResponse } from '../../wire.ts';
import { app, hydrate, reachable } from './app.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Requests still on their way. The page dims its buttons while this is > 0. */
export const inFlight = signal(0);

let version = 0;
export const currentVersion = (): number => version;

let unauthorized: () => void = () => {};
/** Who to tell when the session has gone (any 401). */
export function onUnauthorized(handler: () => void): void { unauthorized = handler; }

export async function request<T>(method: string, path: string, body?: unknown, raw?: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  if (payload !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  inFlight.value++;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    reachable.value = false;
    throw new ApiError(0, 'offline', 'Could not reach the server. Check your connection and try again.');
  } finally {
    inFlight.value--;
  }
  reachable.value = true;
  if (res.status === 401) unauthorized();

  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON — a proxy error page */ }
  if (!res.ok) {
    const error = (parsed as ErrorBody | null)?.error;
    throw new ApiError(res.status, error?.code ?? 'error', error?.message ?? `The server answered ${res.status}.`);
  }
  return parsed as T;
}

export async function refresh(): Promise<void> {
  const loaded = await request<StateResponse>('GET', '/api/state');
  hydrate(loaded.state);
  version = loaded.version;
}

/* A write's changes are only the difference from the version it was made on
   top of. If that is the version on screen, they bring the screen up to date;
   if not — another device wrote in between, even when this write itself
   changed nothing — the whole state is fetched rather than guessed at. */
async function adopt(res: MutationResponse<unknown>): Promise<void> {
  if (res.version === version) return;               // nothing written, nothing missed
  if (res.baseVersion === version) {
    app.value = applyChanges(app.peek(), res);
    version = res.version;
    return;
  }
  await refresh();
}

let queue: Promise<unknown> = Promise.resolve();

export function mutate<R>(method: string, path: string, body?: unknown, raw?: string): Promise<R> {
  const run = async (): Promise<R> => {
    const res = await request<MutationResponse<R>>(method, path, body, raw);
    await adopt(res);
    return res.result;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}

/** Resolves once every queued write has answered. The browser suite waits on it. */
export const idle = (): Promise<void> => queue.then(() => undefined);

/** Signing out: nothing about the last user's version may carry over. */
export function forget(): void {
  version = 0;
  queue = Promise.resolve();
}
