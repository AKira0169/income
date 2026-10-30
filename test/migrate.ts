/* Migration test: the schema the api runs against is the schema the domain
   describes, RLS is on everywhere a user's rows live, and the runtime role can
   neither own nor bypass any of it.

   Needs the test database:  pnpm db:test:up
   Run:  node test/migrate.ts */

import { COLLECTION_KEYS } from '../src/domain/catalog.ts';
import { migrate } from '../server/migrate.ts';
import { kindOf, PG_TYPE, snake, TABLE_NAME, TABLES } from '../server/schema.ts';
import { check, finish, title } from './support/check.ts';
import { freshDatabase } from './support/db.ts';

const db = await freshDatabase();

title('the runner');
check('a fresh database gets the initial migration', db.applied, ['001_init.sql']);
check('running again applies nothing', await migrate(db.admin), []);

title('every domain field has a column of the right type');
const columns = await db.admin<{ table_name: string; column_name: string; data_type: string }[]>`
  select table_name, column_name, data_type from information_schema.columns
  where table_schema = 'public'`;
for (const key of COLLECTION_KEYS) {
  const table = TABLE_NAME[key];
  const types = new Map(columns.filter((c) => c.table_name === table).map((c) => [c.column_name, c.data_type]));
  for (const field of TABLES[key]) {
    // gold_prices is keyed by date; the domain's `gpr_<date>` id is derived on read.
    if (key === 'goldPrices' && field === 'id') continue;
    check(`${table}.${snake(field)}`, types.get(snake(field)), PG_TYPE[kindOf(field)]);
  }
}
check('income stores its period for the uniqueness rule',
  columns.some((c) => c.table_name === 'income' && c.column_name === 'period'), true);
check('accounts carry a currency',
  columns.find((c) => c.table_name === 'accounts' && c.column_name === 'currency')?.data_type, 'character');
check('fx_rates exists for phase 3',
  columns.filter((c) => c.table_name === 'fx_rates').map((c) => c.column_name).sort(),
  ['currency', 'date', 'rate_to_base', 'user_id']);

title('isolation backstop');
const perUser = ['users', 'settings', 'income', 'income_templates', 'bill_templates', 'bills',
  'purchases', 'accounts', 'goals', 'savings_tx', 'gold', 'fx_rates'];
const rls = await db.admin<{ relname: string; relrowsecurity: boolean }[]>`
  select relname, relrowsecurity from pg_class where relname in ${db.admin(perUser)} and relkind = 'r'`;
check('RLS is enabled on every per-user table',
  rls.filter((r) => r.relrowsecurity).map((r) => r.relname).sort(), [...perUser].sort());
const [role] = await db.admin<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
  select rolsuper, rolbypassrls from pg_roles where rolname = 'app'`;
check('the api role is neither superuser nor RLS-exempt', [role?.rolsuper, role?.rolbypassrls], [false, false]);
const owners = await db.admin<{ tableowner: string }[]>`
  select distinct tableowner from pg_tables where schemaname = 'public'`;
check('and owns no table', owners.map((o) => o.tableowner), ['postgres']);

title('generated rows cannot be duplicated');
const u = '00000000-0000-4000-8000-000000000001';
const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try { await work(); return 'accepted'; } catch (err) { return (err as { code?: string }).code ?? 'error'; }
};
await db.admin`insert into users (id) values (${u}::uuid)`;
await db.admin`insert into bills (user_id, id, template_id, period) values (${u}::uuid, 'b1', 't1', '2026-07')`;
check('a second bill for the same template and month is refused',
  await codeOf(() => db.admin`insert into bills (user_id, id, template_id, period) values (${u}::uuid, 'b2', 't1', '2026-07')`),
  '23505');
await db.admin`insert into income (user_id, id, template_id, date) values (${u}::uuid, 'i1', 't9', '2026-07-01')`;
check('so is a second income entry, keyed on the month of its date',
  await codeOf(() => db.admin`insert into income (user_id, id, template_id, date) values (${u}::uuid, 'i2', 't9', '2026-07-28')`),
  '23505');
check('entries typed by hand (no template) are never caught by it',
  await codeOf(() => db.admin`insert into income (user_id, id, template_id, date)
    values (${u}::uuid, 'i3', null, '2026-07-28'), (${u}::uuid, 'i4', null, '2026-07-28')`),
  'accepted');

await db.close();
finish();
