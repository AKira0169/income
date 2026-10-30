/* server/db.ts — the one way into Postgres.

   BIGINT holds money in minor units. postgres.js returns it as a string by
   default (it can exceed 2^53); our amounts never do, and every domain function
   expects a number, so it is parsed to one here, once.

   withUser() is the request transaction. Before any query runs it tells the
   RLS policies whose rows these are (set_config, scoped to the transaction)
   and — for writes — takes the per-user advisory lock, so two writes by the
   same person queue rather than both reading the same state and the second
   overwriting the first. */

import postgres from 'postgres';

export type Types = { bigint: number };
export type Sql = postgres.Sql<Types>;
export type Tx = postgres.TransactionSql<Types>;
/** A connection or a transaction — for functions that work in either. */
export type Db = postgres.ISql<Types>;

const BIGINT = {
  to: 20,
  from: [20],
  serialize: (value: number): string => String(value),
  parse: (raw: string): number => Number(raw)
};

export function connect(url: string, options: { max?: number } = {}): Sql {
  return postgres(url, {
    types: { bigint: BIGINT },
    max: options.max ?? 10,
    onnotice: () => {}
  });
}

/* A snapshot read sees one moment: loading a whole state is a dozen
   statements, and under the default READ COMMITTED a write committed between
   two of them could return an account without the movement that came with it. */
const SNAPSHOT = 'isolation level repeatable read read only';

export async function withUser<T>(
  sql: Sql, userId: string, work: (tx: Tx) => Promise<T>,
  options: { lock?: boolean; snapshot?: boolean } = {}
): Promise<T> {
  const run = async (tx: Tx): Promise<T> => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    if (options.lock) await tx`select pg_advisory_xact_lock(hashtext(${userId}::text))`;
    return work(tx);
  };
  const result = options.snapshot ? await sql.begin(SNAPSHOT, run) : await sql.begin(run);
  return result as T;
}
