/* sqlite.js — SQLite (via sql.js/WASM) as the durable store.
   Attaches globalThis.SqliteStore.

   The database is the source of truth on disk; Store keeps an in-memory copy
   for rendering. Every save rewrites the tables inside one transaction and
   pushes the exported bytes to IndexedDB. Rewriting wholesale rather than
   syncing row-by-row keeps the file exactly consistent with what is on screen,
   and costs about a millisecond at this data size.

   OPFS is blocked on file:// origins, which is why persistence goes through
   IndexedDB (with localStorage as a fallback) instead of a live SQLite VFS. */
(function (root) {
  'use strict';

  var DB_NAME = 'income-tracker';
  var STORE_NAME = 'db';
  var DB_KEY = 'main';
  var LEGACY_KEY = 'income-tracker-v1';
  var FALLBACK_KEY = 'income-tracker-sqlite-b64';

  var SQL = null;
  var db = null;
  var backend = 'none';

  /* ------------------------------------------------------------ base64 <-> */

  function b64ToBytes(b64) {
    var bin = root.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToB64(bytes) {
    var chunk = 0x8000, parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return root.btoa(parts.join(''));
  }

  /* ------------------------------------------------------------- IndexedDB */

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = root.indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('indexedDB open failed')); };
    });
  }

  function idbGet(key) {
    return idb().then(function (conn) {
      return new Promise(function (resolve, reject) {
        var tx = conn.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
        tx.oncomplete = function () { conn.close(); };
      });
    });
  }

  function idbPut(key, value) {
    return idb().then(function (conn) {
      return new Promise(function (resolve, reject) {
        var tx = conn.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = function () { conn.close(); resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ----------------------------------------------------------------- schema */

  /* Column lists double as the object<->row mapping, so there is exactly one
     place to change when a field is added. */
  var TABLES = {
    income: ['id', 'date', 'source', 'category', 'amount', 'method', 'notes'],
    billTemplates: ['id', 'name', 'category', 'provider', 'frequency', 'dueDay', 'expected', 'method', 'active', 'anchor', 'notes'],
    bills: ['id', 'templateId', 'name', 'category', 'provider', 'period', 'dueDate', 'amount', 'units', 'unitRate', 'status', 'paidDate', 'method', 'notes'],
    purchases: ['id', 'date', 'item', 'category', 'amount', 'method', 'notes'],
    accounts: ['id', 'name', 'type', 'target', 'opening', 'notes'],
    savingsTx: ['id', 'date', 'accountId', 'direction', 'amount', 'notes']
  };

  var TYPES = {
    amount: 'INTEGER', expected: 'INTEGER', target: 'INTEGER', opening: 'INTEGER',
    dueDay: 'INTEGER', active: 'INTEGER', units: 'REAL', unitRate: 'REAL'
  };

  var SCHEMA = (function () {
    var stmts = ['CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)'];
    Object.keys(TABLES).forEach(function (table) {
      var cols = TABLES[table].map(function (c) {
        return '"' + c + '" ' + (c === 'id' ? 'TEXT PRIMARY KEY' : (TYPES[c] || 'TEXT'));
      });
      stmts.push('CREATE TABLE IF NOT EXISTS "' + table + '" (' + cols.join(', ') + ')');
    });
    // Indexes on the columns every screen filters by.
    stmts.push('CREATE INDEX IF NOT EXISTS idx_income_date ON income(date)');
    stmts.push('CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(date)');
    stmts.push('CREATE INDEX IF NOT EXISTS idx_bills_period ON bills(period)');
    stmts.push('CREATE INDEX IF NOT EXISTS idx_savings_date ON savingsTx(date)');
    return stmts;
  }());

  function applySchema(database) {
    SCHEMA.forEach(function (sql) { database.run(sql); });
  }

  /* ------------------------------------------------------------ read/write */

  function readAll() {
    var state = { settings: {} };

    var settingsRes = db.exec('SELECT key, value FROM settings');
    if (settingsRes.length) {
      settingsRes[0].values.forEach(function (row) {
        try { state.settings[row[0]] = JSON.parse(row[1]); }
        catch (e) { state.settings[row[0]] = row[1]; }
      });
    }

    Object.keys(TABLES).forEach(function (table) {
      var cols = TABLES[table];
      var res = db.exec('SELECT "' + cols.join('", "') + '" FROM "' + table + '"');
      state[table] = res.length ? res[0].values.map(function (row) {
        var obj = {};
        cols.forEach(function (col, i) {
          var value = row[i];
          if (col === 'active') value = !!value;
          obj[col] = value;
        });
        return obj;
      }) : [];
    });

    return state;
  }

  function writeAll(state) {
    db.run('BEGIN TRANSACTION');
    try {
      db.run('DELETE FROM settings');
      var setStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
      Object.keys(state.settings || {}).forEach(function (key) {
        setStmt.run([key, JSON.stringify(state.settings[key])]);
      });
      setStmt.free();

      Object.keys(TABLES).forEach(function (table) {
        var cols = TABLES[table];
        db.run('DELETE FROM "' + table + '"');
        var placeholders = cols.map(function () { return '?'; }).join(', ');
        var stmt = db.prepare('INSERT INTO "' + table + '" ("' + cols.join('", "') + '") VALUES (' + placeholders + ')');
        (state[table] || []).forEach(function (record) {
          stmt.run(cols.map(function (col) {
            var value = record[col];
            if (value === undefined || value === null) return null;
            if (typeof value === 'boolean') return value ? 1 : 0;
            return value;
          }));
        });
        stmt.free();
      });
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
  }

  function exportBytes() { return db.export(); }

  function save(state) {
    writeAll(state);
    var bytes = exportBytes();
    if (backend === 'indexeddb') {
      return idbPut(DB_KEY, bytes).catch(function () {
        backend = 'localstorage';
        root.localStorage.setItem(FALLBACK_KEY, bytesToB64(bytes));
      });
    }
    if (backend === 'localstorage') {
      root.localStorage.setItem(FALLBACK_KEY, bytesToB64(bytes));
      return Promise.resolve(true);
    }
    return Promise.resolve(false); // memory-only
  }

  /* ------------------------------------------------------------------ init */

  function loadStoredBytes() {
    return idbGet(DB_KEY).then(function (found) {
      backend = 'indexeddb';
      return found ? new Uint8Array(found) : null;
    }).catch(function () {
      try {
        var b64 = root.localStorage.getItem(FALLBACK_KEY);
        backend = 'localstorage';
        return b64 ? b64ToBytes(b64) : null;
      } catch (e) {
        backend = 'memory';
        return null;
      }
    });
  }

  /* Anything saved by the previous localStorage/JSON version is imported once
     so upgrading does not look like data loss. */
  function legacyState() {
    try {
      var raw = root.localStorage.getItem(LEGACY_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
    } catch (e) { return null; }
  }

  function init(wasmBase64) {
    return root.initSqlJs({ wasmBinary: b64ToBytes(wasmBase64) }).then(function (sql) {
      SQL = sql;
      return loadStoredBytes();
    }).then(function (bytes) {
      var imported = null;
      if (bytes && bytes.length) {
        db = new SQL.Database(bytes);
        applySchema(db);
      } else {
        db = new SQL.Database();
        applySchema(db);
        imported = legacyState();
      }
      return { state: imported || readAll(), migrated: !!imported, backend: backend };
    });
  }

  /* Read-only query surface for the console in Settings. */
  function query(sql) {
    if (!db) throw new Error('database not ready');
    if (!/^\s*(select|with|pragma|explain)\b/i.test(sql)) {
      throw new Error('Only SELECT, WITH, PRAGMA and EXPLAIN queries are allowed here, so nothing can be changed by accident.');
    }
    var res = db.exec(sql);
    if (!res.length) return { columns: [], rows: [] };
    return { columns: res[0].columns, rows: res[0].values };
  }

  root.SqliteStore = {
    init: init,
    save: save,
    query: query,
    exportBytes: exportBytes,
    tables: TABLES,
    get backend() { return backend; },
    get ready() { return !!db; }
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
