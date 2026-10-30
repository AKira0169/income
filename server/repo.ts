/* server/repo.ts — every SQL statement the api runs against user data.

   The user id is the first argument of every per-user function, and every
   statement names it: that is the isolation rule. RLS (001_init.sql) is the
   backstop if a statement here ever forgets — the transaction from withUser()
   has already told Postgres whose rows these are.

   Reads come back through normalizeRecord(), so a record looks exactly as the
   diff (server/diff.ts) describes it and exactly as the browser will hold it.
   Every parameter is cast to its column type in the SQL, so nothing depends on
   how the driver guesses a JavaScript value's type. */

import type postgres from 'postgres';
import { migrate as migrateState } from '../src/domain/records.ts';
import type { AppState, GoldPrice, RecordOf, Settings } from '../src/domain/types.ts';
import { USER_COLLECTIONS } from '../src/wire.ts';
import type { StateDiff, UserCollection, WireRecord } from '../src/wire.ts';
import type { Db, Tx } from './db.ts';
import { diffState, isEmptyDiff } from './diff.ts';
import { coerce, kindOf, normalizeRecord, PG_TYPE, snake, TABLE_NAME, TABLES } from './schema.ts';

export interface Loaded {
  state: AppState;
  version: number;
}

/** Rows per INSERT. 500 rows of the widest table stays far below Postgres's
    65 535-parameter limit. */
const BATCH = 500;

const quoted = (name: string): string => `"${name}"`;
const selectList = (collection: UserCollection): string =>
  TABLES[collection].map((c) => quoted(snake(c))).join(', ');

function fromRow<K extends UserCollection>(collection: K, row: Record<string, unknown>): RecordOf<K> {
  const record: Record<string, unknown> = {};
  for (const column of TABLES[collection]) record[column] = row[snake(column)];
  return normalizeRecord(collection, record);
}

export async function ensureUser(userId: string, tx: Tx): Promise<void> {
  await tx`insert into users (id) values (${userId}::uuid) on conflict (id) do nothing`;
}

export async function readVersion(userId: string, tx: Tx): Promise<number> {
  const [row] = await tx<{ state_version: number }[]>`
    select state_version from users where id = ${userId}::uuid`;
  return Number(row?.state_version ?? 0);
}

export async function listRecords<K extends UserCollection>(
  userId: string, tx: Tx, collection: K
): Promise<RecordOf<K>[]> {
  const rows = await tx.unsafe<Record<string, unknown>[]>(
    `select ${selectList(collection)} from ${quoted(TABLE_NAME[collection])} where user_id = $1::uuid order by seq`,
    [userId]
  );
  return rows.map((row) => fromRow(collection, row));
}

export async function getRecord<K extends UserCollection>(
  userId: string, tx: Tx, collection: K, id: string
): Promise<RecordOf<K> | null> {
  const rows = await tx.unsafe<Record<string, unknown>[]>(
    `select ${selectList(collection)} from ${quoted(TABLE_NAME[collection])} where user_id = $1::uuid and id = $2::text`,
    [userId, id]
  );
  return rows[0] ? fromRow(collection, rows[0]) : null;
}

export async function loadState(userId: string, tx: Tx): Promise<Loaded> {
  const version = await readVersion(userId, tx);
  const [settingsRow] = await tx<{ data: Record<string, unknown> }[]>`
    select data from settings where user_id = ${userId}::uuid`;
  const loaded: Record<string, unknown> = { settings: settingsRow?.data ?? {} };
  for (const key of USER_COLLECTIONS) loaded[key] = await listRecords(userId, tx, key);
  loaded['goldPrices'] = await loadGoldPrices(tx);
  // The same forgiving migrate() a backup goes through: it fills in any setting
  // the stored copy predates.
  return { state: migrateState(loaded), version };
}

/* The base currency is phase-3 data with no screen yet. Until there is one it
   is whatever currency code the user had when it was first stored. */
export function baseCurrencyOf(settings: Settings): string {
  const stored = (settings as Settings & { baseCurrency?: unknown }).baseCurrency;
  const code = String(stored || settings.currencyCode || 'EGP').toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'EGP';
}

async function upsertRows(
  userId: string, tx: Tx, collection: UserCollection, rows: readonly WireRecord[], baseCurrency: string
): Promise<void> {
  const fields = TABLES[collection];
  /* currency is written on insert only: changing the base currency later must
     not silently relabel accounts that already exist. */
  const extra = collection === 'accounts' ? [{ name: 'currency', type: 'char(3)' }] : [];
  const names = ['user_id', ...fields.map(snake), ...extra.map((e) => e.name)];
  const types = ['uuid', ...fields.map((f) => PG_TYPE[kindOf(f)]), ...extra.map((e) => e.type)];
  const updates = fields.filter((f) => f !== 'id')
    .map((f) => `${quoted(snake(f))} = excluded.${quoted(snake(f))}`).join(', ');

  for (let start = 0; start < rows.length; start += BATCH) {
    const params: (string | number | boolean | null)[] = [];
    const tuples = rows.slice(start, start + BATCH).map((record) => {
      const values = [userId, ...fields.map((f) => coerce(kindOf(f), record[f])), ...extra.map(() => baseCurrency)];
      const marks = values.map((value, i) => { params.push(value); return `$${params.length}::${types[i]}`; });
      return `(${marks.join(', ')})`;
    });
    await tx.unsafe(
      `insert into ${quoted(TABLE_NAME[collection])} (${names.map(quoted).join(', ')}) values ${tuples.join(', ')} ` +
      `on conflict (user_id, id) do update set ${updates}`,
      params
    );
  }
}

/* Deletes first, across every collection, then upserts: a regenerated bill
   reuses its template and month, and the unique key on (template, period) would
   refuse the new row while the old one still existed. */
export async function writeDiff(userId: string, tx: Tx, diff: StateDiff, baseCurrency: string): Promise<number> {
  if (isEmptyDiff(diff)) return readVersion(userId, tx);
  for (const key of USER_COLLECTIONS) {
    const ids = diff.changes[key]?.deletes;
    if (ids?.length) {
      await tx`delete from ${tx(TABLE_NAME[key])} where user_id = ${userId}::uuid and id = any(${ids}::text[])`;
    }
  }
  for (const key of USER_COLLECTIONS) {
    const rows = diff.changes[key]?.upserts;
    if (rows?.length) await upsertRows(userId, tx, key, rows, baseCurrency);
  }
  if (diff.settings) {
    const data = { ...diff.settings, baseCurrency: baseCurrencyOf(diff.settings) };
    await tx`insert into settings (user_id, data) values (${userId}::uuid, ${tx.json(data as unknown as postgres.JSONValue)})
      on conflict (user_id) do update set data = excluded.data`;
  }
  const [row] = await tx<{ state_version: number }[]>`
    update users set state_version = state_version + 1 where id = ${userId}::uuid returning state_version`;
  return Number(row?.state_version ?? 0);
}

/** Makes the stored state equal `state`, writing only what differs. */
export async function saveState(userId: string, tx: Tx, state: AppState): Promise<number> {
  const current = await loadState(userId, tx);
  return writeDiff(userId, tx, diffState(current.state, state), baseCurrencyOf(state.settings));
}

/* --------------------------------------------------------- gold prices */

export async function loadGoldPrices(db: Db): Promise<GoldPrice[]> {
  const rows = await db<Record<string, unknown>[]>`
    select date, usd_per_oz, egp_per_usd, egp_per_gram24, source, fetched_at from gold_prices order by date`;
  return rows.map((row) => normalizeRecord('goldPrices', {
    id: `gpr_${String(row['date'])}`,
    date: row['date'],
    usdPerOz: row['usd_per_oz'],
    egpPerUsd: row['egp_per_usd'],
    egpPerGram24: row['egp_per_gram24'],
    source: row['source'],
    fetchedAt: row['fetched_at']
  }));
}

export async function upsertGoldPrice(db: Db, price: GoldPrice): Promise<void> {
  await db`insert into gold_prices (date, usd_per_oz, egp_per_usd, egp_per_gram24, source, fetched_at)
    values (${price.date}::text, ${price.usdPerOz}::double precision, ${price.egpPerUsd}::double precision,
            ${price.egpPerGram24}::bigint, ${price.source}::text, ${price.fetchedAt}::text)
    on conflict (date) do update set usd_per_oz = excluded.usd_per_oz, egp_per_usd = excluded.egp_per_usd,
      egp_per_gram24 = excluded.egp_per_gram24, source = excluded.source, fetched_at = excluded.fetched_at`;
}

/** Two years of daily readings is plenty to chart against (the domain's
    MAX_GOLD_PRICES said the same); older rows only grow the table. */
export async function pruneGoldPrices(db: Db, keep = 800): Promise<void> {
  await db`delete from gold_prices where date not in (select date from gold_prices order by date desc limit ${keep})`;
}
