/* store.js — data model, persistence and derived figures.
   All money is stored as an integer number of minor units (cents) so totals
   never drift. Attaches globalThis.Store. */
(function (root) {
  'use strict';

  var STORAGE_KEY = 'income-tracker-v1';
  var SCHEMA_VERSION = 1;

  /* ------------------------------------------------------------ categories */

  var INCOME_CATEGORIES = [
    'Salary', 'Freelance', 'Business', 'Rental', 'Investment', 'Interest',
    'Bonus', 'Commission', 'Pension', 'Refund', 'Gift', 'Other'
  ];

  var BILL_CATEGORIES = [
    'Electricity', 'Water', 'Gas', 'Internet', 'Mobile', 'Landline',
    'Rent', 'Mortgage', 'Council Tax', 'Refuse', 'TV / Streaming',
    'Insurance', 'Loan Repayment', 'Credit Card', 'Childcare', 'Education',
    'Health', 'Subscriptions', 'Maintenance', 'Other'
  ];

  var PURCHASE_CATEGORIES = [
    'Groceries', 'Dining Out', 'Household', 'Clothing', 'Electronics',
    'Pharmacy', 'Fuel', 'Transport', 'Entertainment', 'Gifts',
    'Home Improvement', 'Kids', 'Pets', 'Travel', 'Personal Care', 'Other'
  ];

  var PAYMENT_METHODS = ['Bank Transfer', 'Direct Debit', 'Card', 'Cash', 'Standing Order', 'Mobile Money', 'Cheque', 'Other'];

  var ACCOUNT_TYPES = ['Savings', 'Emergency Fund', 'Fixed Deposit', 'Investment', 'Pension', 'Cash', 'Goal Pot', 'Other'];

  var FREQUENCIES = ['Monthly', 'Bi-monthly', 'Quarterly', 'Half-yearly', 'Yearly', 'One-off'];

  /* How many times a year each frequency bills — used to put bills of different
     cadences on a comparable monthly footing. */
  var PER_YEAR = {
    'Monthly': 12, 'Bi-monthly': 6, 'Quarterly': 4,
    'Half-yearly': 2, 'Yearly': 1, 'One-off': 0
  };

  function monthlyEquivalent(template) {
    var perYear = PER_YEAR[template.frequency];
    if (perYear === undefined) perYear = 12;
    return Math.round(((template.expected || 0) * perYear) / 12);
  }

  /* Utility categories carry a meter reading, so cost can be read against
     consumption rather than on its own. */
  var METERED = {
    'Electricity': 'kWh',
    'Water': 'm³',
    'Gas': 'm³'
  };

  /* ------------------------------------------------------------ money utils */

  /* Parses user input into integer minor units. Handles "1,234.56",
     "1.234,56", "$1 234.56", "(50)" for negatives. */
  function parseMoney(input) {
    if (typeof input === 'number') return Math.round(input * 100);
    var raw = String(input == null ? '' : input).trim();
    if (!raw) return 0;

    var negative = /^\(.*\)$/.test(raw) || raw.indexOf('-') !== -1;
    var digits = raw.replace(/[^0-9.,]/g, '');
    if (!digits) return 0;

    var lastDot = digits.lastIndexOf('.');
    var lastComma = digits.lastIndexOf(',');
    var decimalAt = Math.max(lastDot, lastComma);
    var whole, frac = '';

    // A separator is decimal only if 1-2 digits follow it; otherwise grouping.
    if (decimalAt !== -1 && digits.length - decimalAt - 1 <= 2 && digits.length - decimalAt - 1 > 0) {
      whole = digits.slice(0, decimalAt).replace(/[.,]/g, '');
      frac = digits.slice(decimalAt + 1);
    } else {
      whole = digits.replace(/[.,]/g, '');
    }

    var cents = (parseInt(whole || '0', 10) * 100) + parseInt((frac + '00').slice(0, 2), 10);
    if (!isFinite(cents)) cents = 0;
    return negative ? -cents : cents;
  }

  function toMajor(cents) { return (cents || 0) / 100; }

  function plural(count, one, many) {
    return count + ' ' + (count === 1 ? one : (many || one + 's'));
  }

  function formatMoney(cents, settings, opts) {
    var s = settings || state.settings;
    var options = opts || {};
    var value = toMajor(cents);
    var body = Math.abs(value).toLocaleString(s.locale || 'en-US', {
      minimumFractionDigits: options.round ? 0 : 2,
      maximumFractionDigits: options.round ? 0 : 2
    });
    return (value < 0 ? '-' : '') + (s.currencySymbol || '') + body;
  }

  /* ------------------------------------------------------------- date utils */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function periodOf(isoDate) { return String(isoDate || '').slice(0, 7); }

  function currentPeriod() { return todayISO().slice(0, 7); }

  function shiftPeriod(period, months) {
    var parts = String(period).split('-');
    var d = new Date(+parts[0], (+parts[1] - 1) + months, 1);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function daysInPeriod(period) {
    var parts = String(period).split('-');
    return new Date(+parts[0], +parts[1], 0).getDate();
  }

  function periodLabel(period) {
    var parts = String(period).split('-');
    var d = new Date(+parts[0], +parts[1] - 1, 1);
    return d.toLocaleDateString(state.settings.locale || 'en-US', { month: 'long', year: 'numeric' });
  }

  /* Due date for a template within a period, clamped to the month's length. */
  function dueDateFor(period, dueDay) {
    var day = Math.min(Math.max(parseInt(dueDay, 10) || 1, 1), daysInPeriod(period));
    return period + '-' + pad2(day);
  }

  /* Does a recurring template produce a bill in this period? `anchor` is the
     template's start period, used to phase quarterly/yearly schedules. */
  function occursIn(template, period) {
    if (!template.active) return false;
    var freq = template.frequency || 'Monthly';
    if (freq === 'Monthly') return true;
    if (freq === 'One-off') return (template.anchor || '') === period;

    var anchor = template.anchor || period;
    var a = anchor.split('-'), p = period.split('-');
    var delta = (+p[0] - +a[0]) * 12 + (+p[1] - +a[1]);
    if (delta < 0) return false;
    if (freq === 'Bi-monthly') return delta % 2 === 0;
    if (freq === 'Quarterly') return delta % 3 === 0;
    if (freq === 'Half-yearly') return delta % 6 === 0;
    if (freq === 'Yearly') return delta % 12 === 0;
    return true;
  }

  /* ---------------------------------------------------------------- state */

  function blankState() {
    return {
      version: SCHEMA_VERSION,
      settings: {
        currencySymbol: 'E£',
        currencyCode: 'EGP',
        locale: 'en-EG',
        savingsGoalRate: 20,
        autoGenerate: true
      },
      income: [],
      incomeTemplates: [],
      billTemplates: [],
      bills: [],
      purchases: [],
      accounts: [],
      savingsTx: []
    };
  }

  var state = blankState();
  var storageAvailable = true;
  var listeners = [];

  /* Persistence is injected so the same logic runs against SQLite in the
     browser and against plain memory in the Node tests. */
  var persistence = {
    save: function () { return Promise.resolve(false); },
    describe: function () { return 'memory'; }
  };

  function attachPersistence(adapter) { persistence = adapter; }

  function uid(prefix) {
    var rnd;
    if (root.crypto && root.crypto.randomUUID) rnd = root.crypto.randomUUID().slice(0, 12);
    else rnd = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    return (prefix || 'id') + '_' + rnd;
  }

  var COLLECTION_KEYS = ['income', 'incomeTemplates', 'billTemplates', 'bills', 'purchases', 'accounts', 'savingsTx'];

  function migrate(loaded) {
    var base = blankState();
    if (!loaded || typeof loaded !== 'object') return base;
    base.settings = Object.assign(base.settings, loaded.settings || {});
    COLLECTION_KEYS.forEach(function (key) {
      base[key] = Array.isArray(loaded[key]) ? loaded[key] : [];
    });
    base.version = SCHEMA_VERSION;
    return base;
  }

  /* migrate() is deliberately forgiving so old saves still load, which means it
     happily turns an unrelated file into an empty state. Restore must not do
     that, so it checks the shape first. */
  function looksLikeBackup(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return COLLECTION_KEYS.some(function (key) { return Array.isArray(parsed[key]); });
  }

  /* Adopt a state object read out of the database at boot. */
  function hydrate(loaded, available) {
    state = migrate(loaded);
    storageAvailable = available !== false;
    return state;
  }

  function save() {
    try {
      var result = persistence.save(state);
      if (result && typeof result.then === 'function') {
        result.then(function (ok) { storageAvailable = ok !== false; })
          .catch(function () { storageAvailable = false; });
      } else {
        storageAvailable = result !== false;
      }
    } catch (err) {
      storageAvailable = false;
    }
    listeners.forEach(function (fn) { fn(state); });
  }

  function subscribe(fn) { listeners.push(fn); }

  /* --------------------------------------------------------------- records */

  function sortByDateDesc(list, key) {
    return list.slice().sort(function (a, b) {
      var d = String(b[key] || '').localeCompare(String(a[key] || ''));
      return d !== 0 ? d : String(b.id).localeCompare(String(a.id));
    });
  }

  var COLLECTIONS = {
    income: 'inc', incomeTemplates: 'itp', billTemplates: 'tpl', bills: 'bil',
    purchases: 'pur', accounts: 'acc', savingsTx: 'sav'
  };

  function upsert(collection, record) {
    var list = state[collection];
    if (!list) throw new Error('unknown collection: ' + collection);
    if (record.id) {
      var idx = list.findIndex(function (r) { return r.id === record.id; });
      if (idx !== -1) { list[idx] = Object.assign({}, list[idx], record); save(); return list[idx]; }
    }
    record.id = record.id || uid(COLLECTIONS[collection]);
    list.push(record);
    save();
    return record;
  }

  function remove(collection, id) {
    state[collection] = state[collection].filter(function (r) { return r.id !== id; });
    // Removing an account takes its transactions with it.
    if (collection === 'accounts') {
      state.savingsTx = state.savingsTx.filter(function (t) { return t.accountId !== id; });
    }
    // Deleting a recurring definition keeps the entries it already produced,
    // orphaned rather than removed — that money really did move.
    if (collection === 'billTemplates') {
      state.bills.forEach(function (b) { if (b.templateId === id) b.templateId = null; });
    }
    if (collection === 'incomeTemplates') {
      state.income.forEach(function (r) { if (r.templateId === id) r.templateId = null; });
    }
    save();
  }

  function byId(collection, id) {
    return state[collection].find(function (r) { return r.id === id; }) || null;
  }

  /* ------------------------------------------------------------ generation */

  /* One bill for one template in one period, or nothing if it is not due then
     or already exists. Returns how many rows it added, so callers can total. */
  function generateBillFor(tpl, period) {
    if (!occursIn(tpl, period)) return 0;
    var exists = state.bills.some(function (b) { return b.templateId === tpl.id && b.period === period; });
    if (exists) return 0;
    state.bills.push({
      id: uid('bil'),
      templateId: tpl.id,
      name: tpl.name,
      category: tpl.category,
      provider: tpl.provider || '',
      period: period,
      dueDate: dueDateFor(period, tpl.dueDay),
      amount: tpl.expected || 0,
      units: null,
      unitRate: null,
      status: 'unpaid',
      paidDate: '',
      method: tpl.method || '',
      notes: ''
    });
    return 1;
  }

  function generateIncomeFor(tpl, period) {
    if (!occursIn(tpl, period)) return 0;
    var exists = state.income.some(function (r) {
      return r.templateId === tpl.id && periodOf(r.date) === period;
    });
    if (exists) return 0;
    state.income.push({
      id: uid('inc'),
      templateId: tpl.id,
      date: dueDateFor(period, tpl.payDay),
      source: tpl.source,
      category: tpl.category,
      amount: tpl.expected || 0,
      method: tpl.method || '',
      notes: tpl.notes || ''
    });
    return 1;
  }

  /* Fills `period` from every active template. Used by the manual buttons, so
     it deliberately ignores generatedThrough — asking for a month means that
     month, whether or not the automatic sweep has already been past it. */
  function generateBills(period) {
    var created = 0;
    state.billTemplates.forEach(function (tpl) { created += generateBillFor(tpl, period); });
    if (created) save();
    return created;
  }

  function generateIncome(period) {
    var created = 0;
    state.incomeTemplates.forEach(function (tpl) { created += generateIncomeFor(tpl, period); });
    if (created) save();
    return created;
  }

  /* -------------------------------------------------------- automatic sweep */

  /* A template remembers the last month it was swept through, so a row you
     deliberately deleted is not recreated on the next visit — the sweep only
     ever looks at months it has not seen before. */
  var CATCHUP_MONTHS = 24;
  var swept = false;

  function sweep(templates, generate) {
    var current = currentPeriod();
    var earliest = shiftPeriod(current, -(CATCHUP_MONTHS - 1));
    var created = 0;

    templates.forEach(function (tpl) {
      if (tpl.generatedThrough === current) return;
      var from = tpl.generatedThrough ? shiftPeriod(tpl.generatedThrough, 1) : (tpl.anchor || current);
      if (from < earliest) from = earliest; // guard against a stale anchor
      // Periods are YYYY-MM, so string order is chronological order.
      for (var period = from; period <= current; period = shiftPeriod(period, 1)) {
        created += generate(tpl, period);
      }
      // Bumped even for paused templates: resuming one should not backfill the
      // months it was switched off for.
      tpl.generatedThrough = current;
      swept = true;
    });

    return created;
  }

  /* Brings every recurring definition up to the current month. Called once at
     start-up: set your salary and your bills up once, and each new month fills
     itself in. Months are never generated ahead of today, nor before the
     template existed. */
  function catchUp() {
    var result = { income: 0, bills: 0, total: 0 };
    if (state.settings.autoGenerate === false) return result;

    swept = false;
    result.income = sweep(state.incomeTemplates, generateIncomeFor);
    result.bills = sweep(state.billTemplates, generateBillFor);
    result.total = result.income + result.bills;

    // The generatedThrough marks move even in a month where nothing was due,
    // so a sweep that added no rows can still need persisting.
    if (swept) save();
    return result;
  }

  function billIsOverdue(bill, referenceISO) {
    return bill.status !== 'paid' && String(bill.dueDate || '') < (referenceISO || todayISO());
  }

  /* A bill's period and paid status are both derived from its dates, so every
     write path must recompute them — otherwise editing a due date leaves the
     bill filed under the old month, and entering a paid date leaves it
     counted as outstanding. */
  function normalizeBill(record, fallbackPeriod) {
    var out = Object.assign({}, record);
    out.period = periodOf(out.dueDate) || fallbackPeriod || currentPeriod();
    out.status = out.paidDate ? 'paid' : 'unpaid';
    return out;
  }

  /* ------------------------------------------------------------- selectors */

  function sum(list, pick) {
    return list.reduce(function (acc, item) { return acc + (pick ? pick(item) : item); }, 0);
  }

  function incomeIn(period) {
    return state.income.filter(function (r) { return periodOf(r.date) === period; });
  }
  function purchasesIn(period) {
    return state.purchases.filter(function (r) { return periodOf(r.date) === period; });
  }
  function billsIn(period) {
    return state.bills.filter(function (r) { return r.period === period; });
  }
  function savingsTxIn(period) {
    return state.savingsTx.filter(function (r) { return periodOf(r.date) === period; });
  }

  function accountBalance(accountId) {
    var account = byId('accounts', accountId);
    if (!account) return 0;
    return state.savingsTx.reduce(function (total, tx) {
      if (tx.accountId !== accountId) return total;
      return total + (tx.direction === 'out' ? -tx.amount : tx.amount);
    }, account.opening || 0);
  }

  function totalSavings() {
    return sum(state.accounts, function (a) { return accountBalance(a.id); });
  }

  function summary(period) {
    var income = sum(incomeIn(period), function (r) { return r.amount; });
    var bills = billsIn(period);
    var billsTotal = sum(bills, function (r) { return r.amount; });
    var billsPaid = sum(bills.filter(function (b) { return b.status === 'paid'; }), function (r) { return r.amount; });
    var purchases = sum(purchasesIn(period), function (r) { return r.amount; });
    var tx = savingsTxIn(period);
    var savedIn = sum(tx.filter(function (t) { return t.direction === 'in'; }), function (t) { return t.amount; });
    var savedOut = sum(tx.filter(function (t) { return t.direction === 'out'; }), function (t) { return t.amount; });
    var spent = billsTotal + purchases;

    return {
      period: period,
      income: income,
      bills: billsTotal,
      billsPaid: billsPaid,
      billsOutstanding: billsTotal - billsPaid,
      billCount: bills.length,
      overdueCount: bills.filter(function (b) { return billIsOverdue(b); }).length,
      purchases: purchases,
      spent: spent,
      net: income - spent,
      savedIn: savedIn,
      savedOut: savedOut,
      savedNet: savedIn - savedOut,
      savingsRate: income > 0 ? (savedIn - savedOut) / income : 0
    };
  }

  function groupByCategory(records) {
    var map = {};
    records.forEach(function (r) {
      var key = r.category || 'Uncategorised';
      map[key] = (map[key] || 0) + (r.amount || 0);
    });
    return Object.keys(map).map(function (k) { return { category: k, amount: map[k] }; })
      .sort(function (a, b) { return b.amount - a.amount; });
  }

  /* Periods that hold any record at all, newest first. */
  function activePeriods() {
    var set = {};
    state.income.forEach(function (r) { if (r.date) set[periodOf(r.date)] = 1; });
    state.purchases.forEach(function (r) { if (r.date) set[periodOf(r.date)] = 1; });
    state.savingsTx.forEach(function (r) { if (r.date) set[periodOf(r.date)] = 1; });
    state.bills.forEach(function (r) { if (r.period) set[r.period] = 1; });
    set[currentPeriod()] = 1;
    return Object.keys(set).sort().reverse();
  }

  function trend(endPeriod, months) {
    var out = [];
    for (var i = months - 1; i >= 0; i--) out.push(summary(shiftPeriod(endPeriod, -i)));
    return out;
  }

  function upcomingBills(withinDays) {
    var today = todayISO();
    var limit = new Date();
    limit.setDate(limit.getDate() + (withinDays || 30));
    var limitISO = limit.getFullYear() + '-' + pad2(limit.getMonth() + 1) + '-' + pad2(limit.getDate());
    return state.bills
      .filter(function (b) { return b.status !== 'paid' && b.dueDate && b.dueDate <= limitISO; })
      .sort(function (a, b) { return String(a.dueDate).localeCompare(String(b.dueDate)); })
      .map(function (b) { return Object.assign({}, b, { overdue: b.dueDate < today }); });
  }

  /* ------------------------------------------------------- backup / restore */

  function exportJSON() {
    return JSON.stringify(state, null, 2);
  }

  function importJSON(text) {
    var parsed = JSON.parse(text);
    if (!looksLikeBackup(parsed)) {
      throw new Error('This file is not an Income Tracker backup, so nothing was changed. ' +
        'Pick the .json file produced by "Download backup".');
    }
    var next = migrate(parsed);
    var counts = {};
    COLLECTION_KEYS.forEach(function (k) { counts[k] = next[k].length; });
    state = next;
    save();
    return counts;
  }

  function replaceState(next) { state = migrate(next); save(); }

  function clearAll() { state = blankState(); save(); }

  root.Store = {
    STORAGE_KEY: STORAGE_KEY,
    INCOME_CATEGORIES: INCOME_CATEGORIES,
    BILL_CATEGORIES: BILL_CATEGORIES,
    PURCHASE_CATEGORIES: PURCHASE_CATEGORIES,
    PAYMENT_METHODS: PAYMENT_METHODS,
    ACCOUNT_TYPES: ACCOUNT_TYPES,
    FREQUENCIES: FREQUENCIES,
    METERED: METERED,

    get state() { return state; },
    get storageAvailable() { return storageAvailable; },

    hydrate: hydrate, save: save, subscribe: subscribe,
    attachPersistence: attachPersistence,
    upsert: upsert, remove: remove, byId: byId, uid: uid,

    parseMoney: parseMoney, toMajor: toMajor, formatMoney: formatMoney, plural: plural,
    todayISO: todayISO, periodOf: periodOf, currentPeriod: currentPeriod,
    shiftPeriod: shiftPeriod, periodLabel: periodLabel, daysInPeriod: daysInPeriod,
    dueDateFor: dueDateFor, occursIn: occursIn,

    generateBills: generateBills, generateIncome: generateIncome, catchUp: catchUp,
    billIsOverdue: billIsOverdue, monthlyEquivalent: monthlyEquivalent,
    normalizeBill: normalizeBill, looksLikeBackup: looksLikeBackup,
    incomeIn: incomeIn, purchasesIn: purchasesIn, billsIn: billsIn, savingsTxIn: savingsTxIn,
    accountBalance: accountBalance, totalSavings: totalSavings,
    summary: summary, groupByCategory: groupByCategory, activePeriods: activePeriods,
    trend: trend, upcomingBills: upcomingBills, sortByDateDesc: sortByDateDesc, sum: sum,

    exportJSON: exportJSON, importJSON: importJSON, replaceState: replaceState, clearAll: clearAll
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
