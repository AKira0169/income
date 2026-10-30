/* server/errors.ts — every failure leaves the api as { error: { code, message } }.

   Messages are written for the person using the app; the toast shows them as
   they are. A 500 says nothing about why — the request id in the log does. */

import { ZodError } from 'zod';
import type { ErrorBody } from '../src/wire.ts';

export type ApiStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;

export class HttpError extends Error {
  readonly status: ApiStatus;
  readonly code: string;
  constructor(status: ApiStatus, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const reply = (status: ApiStatus, code: string, message: string) =>
  ({ status, body: { error: { code, message } } satisfies ErrorBody });

export function toErrorResponse(err: unknown): { status: ApiStatus; body: ErrorBody } {
  if (err instanceof HttpError) return reply(err.status, err.code, err.message);
  if (err instanceof ZodError) {
    const detail = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    return reply(400, 'invalid_body', `The request was not understood (${detail}).`);
  }
  if (err instanceof SyntaxError) return reply(400, 'invalid_json', 'The request body is not valid JSON.');
  /* Postgres error classes: 23 is a record breaking a rule of its table, 22 a
     value the column cannot hold (a number too big for BIGINT). Both are the
     request's fault, and neither should read as the server falling over. */
  const pgCode = (err as { code?: unknown } | null)?.code;
  const pgClass = typeof pgCode === 'string' ? pgCode.slice(0, 2) : '';
  if (pgCode === '23505') {
    return reply(409, 'conflict',
      'That would make a second entry for the same recurring item in the same month.');
  }
  if (pgClass === '23') {
    return reply(400, 'invalid_record', 'A record in this request is incomplete or contradicts another.');
  }
  if (pgClass === '22') {
    return reply(400, 'invalid_value', 'A value in this request is out of range or the wrong kind.');
  }
  return reply(500, 'internal', 'Something went wrong on the server.');
}
