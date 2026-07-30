/* sqlite.ts — SQLite (via sql.js/WASM) as the durable store.

   The database is the source of truth on disk; Store keeps an in-memory copy for
   rendering. Every save rewrites the tables inside one transaction and pushes
   the exported bytes to IndexedDB. Rewriting wholesale rather than syncing
   row-by-row keeps the file exactly consistent with what is on screen, and costs
   about a millisecond at this data size.

   OPFS is blocked on file:// origins, which is why persistence goes through
   IndexedDB (with localStorage as a fallback) instead of a live SQLite VFS. */

import type { AppState, CollectionKey, RecordOf } from '../domain/types.ts';

const DB_NAME = 'income-tracker';
const STORE_NAME = 'db';
const DB_KEY = 'main';
const LEGACY_KEY = 'income-tracker-v1';
const FALLBACK_KEY = 'income-tracker-sqlite-b64';

/* ------------------------------------------------- the sql.js surface used */

type SqlValue = string | number | Uint8Array | null;

interface SqlStatement {
  run(params: SqlValue[]): void;
  free(): void;
}

interface SqlDatabase {
  run(sql: string): void;
  exec(sql: string): Array<{ columns: string[]; values: SqlValue[][] }>;
  prepare(sql: string): SqlStatement;
  export(): Uint8Array<ArrayBuffer>;
}

interface SqlJsStatic {
  Database: new (bytes?: Uint8Array) => SqlDatabase;
}

/* Supplied by the sql.js loader the build prepends, and the wasm binary the
   build inlines as base64 — neither can be imported on a file:// origin. */
declare const initSqlJs: (config: { wasmBinary: Uint8Array }) => Promise<SqlJsStatic>;

export type StorageBackend = 'none' | 'indexeddb' | 'localstorage' | 'memory';

let db: SqlDatabase | null = null;
let backend: StorageBackend = 'none';

export const getBackend = (): StorageBackend => backend;
export const isReady = (): boolean => !!db;

/* ------------------------------------------------------------ base64 <-> */

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += chunk) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunk)));
  }
  return btoa(parts.join(''));
}

/* ------------------------------------------------------------- IndexedDB */

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function idbGet(key: string): Promise<ArrayBuffer | Uint8Array | null> {
  const conn = await idb();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => conn.close();
  });
}

async function idbPut(key: string, value: Uint8Array): Promise<boolean> {
  const conn = await idb();
  return new Promise((resolve, reject) => {
    const tx = conn.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => { conn.close(); resolve(true); };
    tx.onerror = () => reject(tx.error);
  });
}

/* ----------------------------------------------------------------- schema */

/* The column lists double as the object<->row mapping, so there is exactly one
   place to change when a field is added. Typing each list against its own
   record means a misspelt column no longer compiles, and a field added to the
   domain model has a single obvious place to be declared. */
type ColumnsOf<K extends CollectionKey> = ReadonlyArray<Extract<keyof RecordOf<K>, string>>;
type TableMap = { readonly [K in CollectionKey]: ColumnsOf<K> };

export const TABLES: TableMap = {
  income: ['id', 'templateId', 'date', 'source', 'category', 'amount', 'accountId', 'method', 'notes'],
  incomeTemplates: ['id', 'source', 'category', 'frequency', 'payDay', 'expected', 'accountId', 'method', 'active', 'anchor', 'generatedThrough', 'notes'],
  billTemplates: ['id', 'name', 'category', 'provider', 'frequency', 'dueDay', 'expected', 'accountId', 'method', 'active', 'anchor', 'generatedThrough', 'notes'],
  bills: ['id', 'templateId', 'name', 'category', 'provider', 'period', 'dueDate', 'amount', 'accountId', 'units', 'unitRate', 'status', 'paidDate', 'method', 'notes'],
  purchases: ['id', 'date', 'item', 'category', 'amount', 'accountId', 'method', 'notes'],
  accounts: ['id', 'name', 'type', 'target', 'opening', 'notes'],
  savingsTx: ['id', 'date', 'accountId', 'fromAccountId', 'direction', 'amount', 'notes'],
  gold: ['id', 'date', 'direction', 'karat', 'grams', 'pricePerGram', 'amount', 'accountId', 'dealer', 'notes'],
  goldPrices: ['id', 'date', 'usdPerOz', 'egpPerUsd', 'egpPerGram24', 'source', 'fetchedAt']
};

const TABLE_NAMES = Object.keys(TABLES) as CollectionKey[];

/** Anything not named here is TEXT. */
const TYPES: Readonly<Record<string, string>> = {
  amount: 'INTEGER', expected: 'INTEGER', target: 'INTEGER', opening: 'INTEGER',
  dueDay: 'INTEGER', payDay: 'INTEGER', active: 'INTEGER', units: 'REAL', unitRate: 'REAL',
  karat: 'INTEGER', grams: 'REAL', pricePerGram: 'INTEGER',
  usdPerOz: 'REAL', egpPerUsd: 'REAL', egpPerGram24: 'INTEGER'
};

const columnType = (column: string): string =>
  column === 'id' ? 'TEXT PRIMARY KEY' : (TYPES[column] ?? 'TEXT');

const SCHEMA: readonly string[] = [
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)',
  ...TABLE_NAMES.map((table) => {
    const cols = TABLES[table].map((c) => `"${c}" ${columnType(c)}`);
    return `CREATE TABLE IF NOT EXISTS "${table}" (${cols.join(', ')})`;
  }),
  // Indexes on the columns every screen filters by.
  'CREATE INDEX IF NOT EXISTS idx_income_date ON income(date)',
  'CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date)',
  'CREATE INDEX IF NOT EXISTS idx_bills_period ON bills(period)',
  'CREATE INDEX IF NOT EXISTS idx_savings_date ON savingsTx(date)',
  'CREATE INDEX IF NOT EXISTS idx_gold_date ON gold(date)',
  'CREATE INDEX IF NOT EXISTS idx_goldprices_date ON goldPrices(date)'
];

function applySchema(database: SqlDatabase): void {
  for (const sql of SCHEMA) database.run(sql);
}

/* CREATE TABLE IF NOT EXISTS never widens a table that already exists, so a
   database written by an earlier build is missing every column added since —
   and readAll() names its columns explicitly, so the first SELECT would throw
   and the app would refuse to open on real data. Add what is missing. */
function migrateColumns(database: SqlDatabase): void {
  for (const table of TABLE_NAMES) {
    const info = database.exec(`PRAGMA table_info("${table}")`);
    if (!info.length) continue; // freshly created by applySchema — already current
    const present = new Set(info[0]!.values.map((row) => String(row[1])));
    for (const col of TABLES[table]) {
      if (!present.has(col)) {
        database.run(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${TYPES[col] ?? 'TEXT'}`);
      }
    }
  }
}

/* ------------------------------------------------------------ read/write */

function requireDb(): SqlDatabase {
  if (!db) throw new Error('database not ready');
  return db;
}

/* Returns a plain object rather than an AppState: nothing here has been
   validated yet, and Store.migrate() is what turns it into real state. Claiming
   the typed shape at this point would be a lie the compiler then trusts. */
function readAll(): unknown {
  const database = requireDb();
  const settings: Record<string, unknown> = {};

  const settingsRes = database.exec('SELECT key, value FROM settings');
  if (settingsRes.length) {
    for (const row of settingsRes[0]!.values) {
      const key = String(row[0]);
      const raw = row[1];
      try { settings[key] = JSON.parse(String(raw)); }
      catch { settings[key] = raw; }
    }
  }

  const state: Record<string, unknown> = { settings };
  for (const table of TABLE_NAMES) {
    const cols = TABLES[table];
    const res = database.exec(`SELECT "${cols.join('", "')}" FROM "${table}"`);
    state[table] = res.length
      ? res[0]!.values.map((row) => {
        const obj: Record<string, unknown> = {};
        cols.forEach((col, i) => {
          obj[col] = col === 'active' ? !!row[i] : row[i];
        });
        return obj;
      })
      : [];
  }

  return state;
}

/** SQLite has no boolean; undefined and null both mean SQL NULL. */
function toSqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

function writeAll(state: AppState): void {
  const database = requireDb();
  database.run('BEGIN TRANSACTION');
  try {
    database.run('DELETE FROM settings');
    const setStmt = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(state.settings ?? {})) {
      setStmt.run([key, JSON.stringify(value)]);
    }
    setStmt.free();

    for (const table of TABLE_NAMES) {
      const cols = TABLES[table];
      database.run(`DELETE FROM "${table}"`);
      const placeholders = cols.map(() => '?').join(', ');
      const stmt = database.prepare(
        `INSERT INTO "${table}" ("${cols.join('", "')}") VALUES (${placeholders})`
      );
      const records: ReadonlyArray<unknown> = state[table] ?? [];
      for (const record of records) {
        const row = record as Record<string, unknown>;
        stmt.run(cols.map((col) => toSqlValue(row[col])));
      }
      stmt.free();
    }
    database.run('COMMIT');
  } catch (err) {
    database.run('ROLLBACK');
    throw err;
  }
}

export function exportBytes(): Uint8Array<ArrayBuffer> { return requireDb().export(); }

export async function save(state: AppState): Promise<boolean> {
  writeAll(state);
  const bytes = exportBytes();

  if (backend === 'indexeddb') {
    try {
      return await idbPut(DB_KEY, bytes);
    } catch {
      backend = 'localstorage';
      localStorage.setItem(FALLBACK_KEY, bytesToB64(bytes));
      return true;
    }
  }
  if (backend === 'localstorage') {
    localStorage.setItem(FALLBACK_KEY, bytesToB64(bytes));
    return true;
  }
  return false; // memory-only
}

/* ------------------------------------------------------------------ init */

async function loadStoredBytes(): Promise<Uint8Array | null> {
  try {
    const found = await idbGet(DB_KEY);
    backend = 'indexeddb';
    return found ? new Uint8Array(found as ArrayBuffer) : null;
  } catch {
    try {
      const b64 = localStorage.getItem(FALLBACK_KEY);
      backend = 'localstorage';
      return b64 ? b64ToBytes(b64) : null;
    } catch {
      backend = 'memory';
      return null;
    }
  }
}

/** Anything saved by the previous localStorage/JSON version is imported once so
    upgrading does not look like data loss. */
function legacyState(): unknown {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch {
    return null;
  }
}

export interface InitResult {
  state: unknown;
  /** True when the state came from the old localStorage format. */
  migrated: boolean;
  backend: StorageBackend;
}

export async function init(wasmBase64: string): Promise<InitResult> {
  const SQL = await initSqlJs({ wasmBinary: b64ToBytes(wasmBase64) });
  const bytes = await loadStoredBytes();

  let imported: unknown = null;
  if (bytes?.length) {
    db = new SQL.Database(bytes);
    applySchema(db);
    migrateColumns(db);
  } else {
    db = new SQL.Database();
    applySchema(db);
    imported = legacyState();
  }
  return { state: imported ?? readAll(), migrated: !!imported, backend };
}

/* ------------------------------------------------------------ SQL console */

export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
}

/** Read-only query surface for the console in Settings. */
export function query(sql: string): QueryResult {
  const database = requireDb();
  if (!/^\s*(select|with|pragma|explain)\b/i.test(sql)) {
    throw new Error('Only SELECT, WITH, PRAGMA and EXPLAIN queries are allowed here, ' +
      'so nothing can be changed by accident.');
  }
  const res = database.exec(sql);
  if (!res.length) return { columns: [], rows: [] };
  return { columns: res[0]!.columns, rows: res[0]!.values };
}
