/* server/schema.ts — how a domain record becomes a row and back.

   TABLES is the column list the sqlite store used, moved here unchanged: one
   list per collection, typed against its record so a misspelt field does not
   compile. Column names are the snake_case of the field names, and the kind of
   each column decides how a value is coerced on its way in.

   normalizeRecord() is the single definition of "what this record looks like
   once stored": exactly the declared fields, missing ones as null, numbers as
   numbers. The write path, the read path and the diff all go through it, so the
   changes a write returns are byte-for-byte what the next read will return. */

import { COLLECTION_KEYS } from '../src/domain/catalog.ts';
import type { AppState, CollectionKey, RecordOf } from '../src/domain/types.ts';

type ColumnsOf<K extends CollectionKey> = ReadonlyArray<Extract<keyof RecordOf<K>, string>>;
type TableMap = { readonly [K in CollectionKey]: ColumnsOf<K> };

export const TABLES: TableMap = {
  income: ['id', 'templateId', 'date', 'source', 'category', 'amount', 'accountId', 'method', 'notes'],
  incomeTemplates: ['id', 'source', 'category', 'frequency', 'payDay', 'expected', 'accountId', 'method', 'active', 'anchor', 'generatedThrough', 'notes'],
  billTemplates: ['id', 'name', 'category', 'provider', 'frequency', 'dueDay', 'expected', 'accountId', 'method', 'active', 'anchor', 'generatedThrough', 'notes'],
  bills: ['id', 'templateId', 'name', 'category', 'provider', 'period', 'dueDate', 'amount', 'accountId', 'units', 'unitRate', 'status', 'paidDate', 'method', 'notes'],
  purchases: ['id', 'goalId', 'date', 'item', 'category', 'amount', 'accountId', 'method', 'notes'],
  accounts: ['id', 'name', 'type', 'target', 'opening', 'notes'],
  goals: ['id', 'name', 'price', 'priority', 'boughtDate', 'notes'],
  savingsTx: ['id', 'date', 'accountId', 'fromAccountId', 'direction', 'amount', 'notes'],
  gold: ['id', 'date', 'direction', 'karat', 'grams', 'pricePerGram', 'amount', 'accountId', 'dealer', 'notes'],
  goldPrices: ['id', 'date', 'usdPerOz', 'egpPerUsd', 'egpPerGram24', 'source', 'fetchedAt']
};

export const TABLE_NAME: Readonly<Record<CollectionKey, string>> = {
  income: 'income', incomeTemplates: 'income_templates', billTemplates: 'bill_templates',
  bills: 'bills', purchases: 'purchases', accounts: 'accounts', goals: 'goals',
  savingsTx: 'savings_tx', gold: 'gold', goldPrices: 'gold_prices'
};

export type ColumnKind = 'text' | 'bigint' | 'int' | 'real' | 'bool';

/** Anything not named here is text — including every date, because '' is a
    legal date in the domain ("not paid yet") and a DATE column cannot hold it. */
const KINDS: Readonly<Record<string, ColumnKind>> = {
  amount: 'bigint', expected: 'bigint', target: 'bigint', opening: 'bigint',
  price: 'bigint', pricePerGram: 'bigint', egpPerGram24: 'bigint',
  priority: 'int', dueDay: 'int', payDay: 'int', karat: 'int',
  units: 'real', unitRate: 'real', grams: 'real', usdPerOz: 'real', egpPerUsd: 'real',
  active: 'bool'
};

export const kindOf = (column: string): ColumnKind => KINDS[column] ?? 'text';

/** As information_schema.columns.data_type spells them. */
export const PG_TYPE: Readonly<Record<ColumnKind, string>> = {
  text: 'text', bigint: 'bigint', int: 'integer', real: 'double precision', bool: 'boolean'
};

export const snake = (column: string): string =>
  column.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/* Forgiving in the same way the sqlite store was: a record written by an older
   build, or a backup edited by hand, may hold "21" where 21 belongs. It is
   stored as the number it obviously means; something that is no number at all
   is stored as null rather than refusing the whole import. `active` reads back
   as a boolean even when it was never set — readAll() did exactly that. */
export function coerce(kind: ColumnKind, value: unknown): string | number | boolean | null {
  if (kind === 'bool') return Boolean(value);
  if (value === undefined || value === null) return null;
  if (kind === 'text') return String(value);
  if (value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return kind === 'real' ? n : Math.round(n);
}

export function normalizeRecord<K extends CollectionKey>(collection: K, record: unknown): RecordOf<K> {
  const source = (record ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const column of TABLES[collection]) out[column] = coerce(kindOf(column), source[column]);
  return out as unknown as RecordOf<K>;
}

/** Every record in every collection as it would come back out of the database.
    Tests compare states through this, because a direct domain call and a round
    trip through Postgres differ only in undefined-versus-null. */
export function normalizeState(state: AppState): AppState {
  const out = { ...state } as Record<string, unknown>;
  for (const key of COLLECTION_KEYS) {
    out[key] = (state[key] as unknown[]).map((r) => normalizeRecord(key, r));
  }
  return out as unknown as AppState;
}
