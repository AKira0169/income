/* test/support/db.ts — a clean schema per suite, on the disposable Postgres
   from deploy/compose.test.yaml (`pnpm db:test:up`).

   Two connections, as in production: `admin` is the superuser that migrates
   (and that tests use to look underneath the api), `sql` is the `app` role the
   api runs as — the one RLS applies to. */

import { connect } from '../../server/db.ts';
import type { Sql } from '../../server/db.ts';
import { migrate } from '../../server/migrate.ts';

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? 'postgres://postgres:test-admin@127.0.0.1:55439/app';
export const APP_URL = process.env.TEST_APP_URL ?? 'postgres://app:test-app@127.0.0.1:55439/app';

export interface TestDb {
  admin: Sql;
  sql: Sql;
  applied: string[];
  close(): Promise<void>;
}

export async function freshDatabase(): Promise<TestDb> {
  const admin = connect(ADMIN_URL, { max: 1 });
  await admin.unsafe('drop schema if exists public cascade; create schema public;').simple();
  const applied = await migrate(admin);
  const sql = connect(APP_URL, { max: 4 });
  return { admin, sql, applied, close: async () => { await sql.end(); await admin.end(); } };
}
