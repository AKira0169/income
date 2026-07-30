/* export.js — turns the store into a multi-sheet workbook.
   Attaches globalThis.Exporter. Depends on Store and XLSXMini. */
(function (root) {
  'use strict';

  var S = root.Store;
  var money = function (cents) { return { t: 'money', v: (cents || 0) / 100 }; };
  var date = function (iso) { return iso ? { t: 'date', v: iso } : null; };
  var head = function (label) { return { v: label, s: 'header' }; };
  var bold = function (v) { return { v: v, s: 'bold' }; };

  function headerRow(labels) { return labels.map(head); }

  /* SUM over a column, or a literal 0 when there is nothing to sum. */
  function columnTotal(col, firstRow, lastRow, cachedCents) {
    if (lastRow < firstRow) return { t: 'money', v: 0, s: 'moneyBold' };
    return { t: 'formula', f: 'SUM(' + col + firstRow + ':' + col + lastRow + ')', v: (cachedCents || 0) / 100, s: 'moneyBold' };
  }

  function sheetRef(name, cell) {
    return (/[^A-Za-z0-9_]/.test(name) ? "'" + name.replace(/'/g, "''") + "'" : name) + '!' + cell;
  }

  /* ------------------------------------------------------------- selection */

  function scopeRecords(scope) {
    var st = S.state;
    if (scope.type === 'all') {
      return {
        income: st.income.slice(),
        bills: st.bills.slice(),
        purchases: st.purchases.slice(),
        savingsTx: st.savingsTx.slice(),
        periods: S.activePeriods().slice().sort()
      };
    }
    if (scope.type === 'year') {
      var yr = String(scope.year);
      var inYear = function (iso) { return String(iso || '').slice(0, 4) === yr; };
      return {
        income: st.income.filter(function (r) { return inYear(r.date); }),
        bills: st.bills.filter(function (r) { return String(r.period || '').slice(0, 4) === yr; }),
        purchases: st.purchases.filter(function (r) { return inYear(r.date); }),
        savingsTx: st.savingsTx.filter(function (r) { return inYear(r.date); }),
        periods: S.activePeriods().filter(function (p) { return p.slice(0, 4) === yr; }).sort()
      };
    }
    var p = scope.period;
    return {
      income: S.incomeIn(p), bills: S.billsIn(p),
      purchases: S.purchasesIn(p), savingsTx: S.savingsTxIn(p),
      periods: [p]
    };
  }

  function scopeLabel(scope) {
    if (scope.type === 'all') return 'All time';
    if (scope.type === 'year') return 'Year ' + scope.year;
    return S.periodLabel(scope.period);
  }

  /* ---------------------------------------------------------------- sheets */

  /* The Recurring column is appended, not inserted: Amount stays in column D,
     which the Summary sheet and the total below both address by letter. */
  function incomeSheet(records) {
    var rows = [headerRow(['Date', 'Source', 'Category', 'Amount', 'Method', 'Notes', 'Recurring'])];
    var sorted = records.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    sorted.forEach(function (r) {
      rows.push([date(r.date), r.source || '', r.category || '', money(r.amount), r.method || '', r.notes || '',
        r.templateId ? 'Yes' : '']);
    });
    var total = S.sum(sorted, function (r) { return r.amount; });
    rows.push([]);
    rows.push([bold('Total'), null, null, columnTotal('D', 2, sorted.length + 1, total), null, null, null]);
    return {
      name: 'Income', freeze: 1,
      autoFilter: sorted.length ? 'A1:G' + (sorted.length + 1) : null,
      cols: [{ w: 12 }, { w: 24 }, { w: 16 }, { w: 14 }, { w: 16 }, { w: 34 }, { w: 11 }],
      rows: rows, _total: total, _lastRow: sorted.length + 1, _count: sorted.length
    };
  }

  function incomeTemplatesSheet() {
    var templates = S.state.incomeTemplates;
    var rows = [headerRow(['Source', 'Category', 'Frequency', 'Pay Day',
      'Expected Amount', 'Income / Month', 'Method', 'Active', 'Notes'])];
    templates.forEach(function (t) {
      rows.push([t.source || '', t.category || '', t.frequency || 'Monthly',
        { t: 'int', v: Number(t.payDay) || 1 }, money(t.expected),
        money(S.monthlyEquivalent(t)), t.method || '',
        t.active ? 'Yes' : 'No', t.notes || '']);
    });
    // As with bills: a yearly bonus is not a monthly income, so each cadence is
    // spread over 12 months to make the sources comparable.
    var perMonth = S.sum(templates.filter(function (t) { return t.active; }), S.monthlyEquivalent);
    rows.push([]);
    rows.push([bold('Active recurring income, per month'), null, null, null, null,
      { t: 'money', v: perMonth / 100, s: 'moneyBold' }]);
    rows.push([bold('Active recurring income, per year'), null, null, null, null,
      { t: 'money', v: (perMonth * 12) / 100, s: 'moneyBold' }]);
    return {
      name: 'Recurring Income', freeze: 1,
      cols: [{ w: 26 }, { w: 16 }, { w: 13 }, { w: 10 }, { w: 16 }, { w: 15 }, { w: 16 }, { w: 8 }, { w: 28 }],
      rows: rows
    };
  }

  function billsSheet(records) {
    var rows = [headerRow(['Period', 'Due Date', 'Bill', 'Category', 'Provider', 'Amount',
      'Units Used', 'Unit', 'Rate / Unit', 'Status', 'Paid Date', 'Method', 'Notes'])];
    var sorted = records.slice().sort(function (a, b) {
      return String(a.period + a.dueDate).localeCompare(String(b.period + b.dueDate));
    });
    sorted.forEach(function (b) {
      var unit = S.METERED[b.category] || '';
      rows.push([
        b.period || '', date(b.dueDate), b.name || '', b.category || '', b.provider || '',
        money(b.amount),
        (b.units === null || b.units === undefined || b.units === '') ? null : { t: 'number', v: Number(b.units) },
        unit,
        (b.unitRate === null || b.unitRate === undefined || b.unitRate === '') ? null : { t: 'number', v: Number(b.unitRate) },
        b.status === 'paid' ? 'Paid' : (S.billIsOverdue(b) ? 'OVERDUE' : 'Unpaid'),
        date(b.paidDate), b.method || '', b.notes || ''
      ]);
    });
    var total = S.sum(sorted, function (r) { return r.amount; });
    var paid = S.sum(sorted.filter(function (b) { return b.status === 'paid'; }), function (r) { return r.amount; });
    rows.push([]);
    rows.push([bold('Total billed'), null, null, null, null, columnTotal('F', 2, sorted.length + 1, total)]);
    rows.push([bold('Paid'), null, null, null, null, { t: 'money', v: paid / 100, s: 'moneyBold' }]);
    rows.push([bold('Outstanding'), null, null, null, null, { t: 'money', v: (total - paid) / 100, s: 'moneyBold' }]);
    return {
      name: 'Bills', freeze: 1,
      autoFilter: sorted.length ? 'A1:M' + (sorted.length + 1) : null,
      cols: [{ w: 10 }, { w: 12 }, { w: 22 }, { w: 16 }, { w: 18 }, { w: 14 }, { w: 12 }, { w: 8 },
        { w: 12 }, { w: 11 }, { w: 12 }, { w: 15 }, { w: 28 }],
      rows: rows, _total: total, _paid: paid, _lastRow: sorted.length + 1, _count: sorted.length
    };
  }

  function templatesSheet() {
    var rows = [headerRow(['Bill', 'Category', 'Provider', 'Frequency', 'Due Day',
      'Expected Amount', 'Cost / Month', 'Method', 'Active', 'Notes'])];
    S.state.billTemplates.forEach(function (t) {
      rows.push([t.name || '', t.category || '', t.provider || '', t.frequency || 'Monthly',
        { t: 'int', v: Number(t.dueDay) || 1 }, money(t.expected),
        money(S.monthlyEquivalent(t)), t.method || '',
        t.active ? 'Yes' : 'No', t.notes || '']);
    });
    // A yearly bill is not a monthly cost — spread each cadence over 12 months.
    var perMonth = S.sum(S.state.billTemplates.filter(function (t) { return t.active; }), S.monthlyEquivalent);
    var perYear = perMonth * 12;
    rows.push([]);
    rows.push([bold('Active recurring bills, per month'), null, null, null, null, null,
      { t: 'money', v: perMonth / 100, s: 'moneyBold' }]);
    rows.push([bold('Active recurring bills, per year'), null, null, null, null, null,
      { t: 'money', v: perYear / 100, s: 'moneyBold' }]);
    return {
      name: 'Recurring Bills', freeze: 1,
      cols: [{ w: 22 }, { w: 16 }, { w: 18 }, { w: 13 }, { w: 10 }, { w: 16 }, { w: 14 }, { w: 15 }, { w: 8 }, { w: 28 }],
      rows: rows
    };
  }

  function purchasesSheet(records) {
    var rows = [headerRow(['Date', 'Item', 'Category', 'Amount', 'Method', 'Notes'])];
    var sorted = records.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    sorted.forEach(function (r) {
      rows.push([date(r.date), r.item || '', r.category || '', money(r.amount), r.method || '', r.notes || '']);
    });
    var total = S.sum(sorted, function (r) { return r.amount; });
    rows.push([]);
    rows.push([bold('Total'), null, null, columnTotal('D', 2, sorted.length + 1, total)]);
    return {
      name: 'Purchases', freeze: 1,
      autoFilter: sorted.length ? 'A1:F' + (sorted.length + 1) : null,
      cols: [{ w: 12 }, { w: 28 }, { w: 18 }, { w: 14 }, { w: 16 }, { w: 30 }],
      rows: rows, _total: total, _lastRow: sorted.length + 1, _count: sorted.length
    };
  }

  function accountsSheet() {
    var rows = [headerRow(['Account', 'Type', 'Opening Balance', 'Paid In', 'Withdrawn', 'Current Balance', 'Target', 'Progress', 'Notes'])];
    var st = S.state;
    st.accounts.forEach(function (a) {
      var inSum = S.sum(st.savingsTx.filter(function (t) { return t.accountId === a.id && t.direction === 'in'; }), function (t) { return t.amount; });
      var outSum = S.sum(st.savingsTx.filter(function (t) { return t.accountId === a.id && t.direction === 'out'; }), function (t) { return t.amount; });
      var balance = S.accountBalance(a.id);
      rows.push([
        a.name || '', a.type || '', money(a.opening), money(inSum), money(outSum), money(balance),
        a.target ? money(a.target) : null,
        a.target ? { t: 'percent', v: balance / a.target } : null,
        a.notes || ''
      ]);
    });
    var total = S.totalSavings();
    rows.push([]);
    rows.push([bold('Total savings'), null, null, null, null, columnTotal('F', 2, st.accounts.length + 1, total)]);
    return {
      name: 'Savings Accounts', freeze: 1,
      cols: [{ w: 24 }, { w: 16 }, { w: 16 }, { w: 14 }, { w: 14 }, { w: 17 }, { w: 14 }, { w: 11 }, { w: 28 }],
      rows: rows, _total: total
    };
  }

  function savingsTxSheet(records) {
    var rows = [headerRow(['Date', 'Account', 'Direction', 'Amount', 'Notes'])];
    var sorted = records.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
    sorted.forEach(function (t) {
      var account = S.byId('accounts', t.accountId);
      rows.push([date(t.date), account ? account.name : '(deleted account)',
        t.direction === 'out' ? 'Withdrawal' : 'Deposit', money(t.amount), t.notes || '']);
    });
    var inSum = S.sum(sorted.filter(function (t) { return t.direction === 'in'; }), function (t) { return t.amount; });
    var outSum = S.sum(sorted.filter(function (t) { return t.direction === 'out'; }), function (t) { return t.amount; });
    rows.push([]);
    rows.push([bold('Deposited'), null, null, { t: 'money', v: inSum / 100, s: 'moneyBold' }]);
    rows.push([bold('Withdrawn'), null, null, { t: 'money', v: outSum / 100, s: 'moneyBold' }]);
    rows.push([bold('Net saved'), null, null, { t: 'money', v: (inSum - outSum) / 100, s: 'moneyBold' }]);
    return {
      name: 'Savings Transactions', freeze: 1,
      autoFilter: sorted.length ? 'A1:E' + (sorted.length + 1) : null,
      cols: [{ w: 12 }, { w: 24 }, { w: 13 }, { w: 14 }, { w: 32 }],
      rows: rows, _in: inSum, _out: outSum
    };
  }

  function monthlySheet(periods) {
    var rows = [headerRow(['Month', 'Income', 'Bills', 'Purchases', 'Total Spent', 'Net',
      'Paid Into Savings', 'Withdrawn', 'Net Saved', 'Savings Rate'])];
    var list = periods.slice().sort();
    list.forEach(function (p, i) {
      var s = S.summary(p);
      var r = i + 2;
      rows.push([
        p,
        money(s.income), money(s.bills), money(s.purchases),
        { t: 'formula', f: 'C' + r + '+D' + r, v: s.spent / 100, s: 'money' },
        { t: 'formula', f: 'B' + r + '-E' + r, v: s.net / 100, s: 'money' },
        money(s.savedIn), money(s.savedOut),
        { t: 'formula', f: 'G' + r + '-H' + r, v: s.savedNet / 100, s: 'money' },
        { t: 'formula', f: 'IF(B' + r + '=0,0,I' + r + '/B' + r + ')', v: s.savingsRate, s: 'percent' }
      ]);
    });
    var last = list.length + 1;
    rows.push([]);
    if (list.length) {
      // Every formula carries a cached value: without one the row reads as 0
      // (or blank) in Excel until a recalculation happens, and stays 0 in any
      // tool that reads the file without evaluating formulas.
      var keys = ['income', 'bills', 'purchases', 'spent', 'net', 'savedIn', 'savedOut', 'savedNet'];
      var totals = {};
      keys.forEach(function (k) { totals[k] = 0; });
      list.forEach(function (p) {
        var s = S.summary(p);
        keys.forEach(function (k) { totals[k] += s[k]; });
      });

      var cols = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
      var tr = list.length + 3;

      rows.push([bold('Total')].concat(cols.map(function (col, i) {
        return columnTotal(col, 2, last, totals[keys[i]]);
      })).concat([
        { t: 'formula', f: 'IF(B' + tr + '=0,0,I' + tr + '/B' + tr + ')', s: 'percent',
          v: totals.income > 0 ? totals.savedNet / totals.income : 0 }
      ]));

      rows.push([bold('Monthly average')].concat(cols.map(function (col, i) {
        return { t: 'formula', f: 'AVERAGE(' + col + '2:' + col + last + ')', s: 'moneyBold',
          v: (totals[keys[i]] / list.length) / 100 };
      })));
    }
    return {
      name: 'Monthly Breakdown', freeze: 1,
      cols: [{ w: 11 }].concat([16, 14, 14, 14, 14, 17, 14, 14, 12].map(function (w) { return { w: w }; })),
      rows: rows
    };
  }

  function categorySheet(sel) {
    var rows = [headerRow(['Type', 'Category', 'Amount', 'Share of Type', 'Entries'])];

    function block(label, records) {
      var groups = S.groupByCategory(records);
      var total = S.sum(groups, function (g) { return g.amount; });
      if (!groups.length) {
        rows.push([{ v: label, s: 'group' }, { v: 'no entries', s: 'muted' }, null, null, null]);
        return;
      }
      groups.forEach(function (g, i) {
        var count = records.filter(function (r) { return (r.category || 'Uncategorised') === g.category; }).length;
        rows.push([
          i === 0 ? { v: label, s: 'group' } : '',
          g.category, money(g.amount),
          { t: 'percent', v: total ? g.amount / total : 0 },
          { t: 'int', v: count }
        ]);
      });
      rows.push([{ v: label + ' total', s: 'bold' }, null, { t: 'money', v: total / 100, s: 'moneyBold' }, null, null]);
      rows.push([]);
    }

    block('Income', sel.income);
    block('Bills', sel.bills);
    block('Purchases', sel.purchases);

    return {
      name: 'Category Breakdown', freeze: 1,
      cols: [{ w: 16 }, { w: 22 }, { w: 15 }, { w: 14 }, { w: 10 }],
      rows: rows
    };
  }

  function utilitiesSheet(bills) {
    var metered = bills.filter(function (b) { return S.METERED[b.category]; });
    var rows = [headerRow(['Period', 'Utility', 'Provider', 'Units Used', 'Unit', 'Rate / Unit', 'Amount', 'Implied Cost / Unit'])];
    metered.slice().sort(function (a, b) {
      return String(a.category + a.period).localeCompare(String(b.category + b.period));
    }).forEach(function (b, i) {
      var r = i + 2;
      var units = Number(b.units);
      var hasUnits = isFinite(units) && units > 0;
      rows.push([
        b.period || '', b.category, b.provider || '',
        hasUnits ? { t: 'number', v: units } : null,
        S.METERED[b.category],
        (b.unitRate === null || b.unitRate === undefined || b.unitRate === '') ? null : { t: 'number', v: Number(b.unitRate) },
        money(b.amount),
        hasUnits ? { t: 'formula', f: 'IF(D' + r + '=0,"",G' + r + '/D' + r + ')', v: (b.amount / 100) / units, s: 'money' } : null
      ]);
    });
    if (!metered.length) {
      rows.push([{ v: 'No metered utility bills recorded yet. Add units to electricity, water or gas bills to track consumption here.', s: 'muted' }]);
    }
    return {
      name: 'Utilities & Meters', freeze: 1,
      cols: [{ w: 10 }, { w: 16 }, { w: 18 }, { w: 12 }, { w: 8 }, { w: 12 }, { w: 14 }, { w: 18 }],
      rows: rows
    };
  }

  function summarySheet(scope, sel, sheets) {
    var st = S.state;
    var income = sheets.income._total;
    var billsTotal = sheets.bills._total;
    var billsPaid = sheets.bills._paid;
    var purchases = sheets.purchases._total;
    var spent = billsTotal + purchases;
    var net = income - spent;
    var savedNet = sheets.savingsTx._in - sheets.savingsTx._out;

    var rows = [];
    rows.push([{ v: 'Income & Spending Report', s: 'title' }]);
    rows.push([{ v: scopeLabel(scope), s: 'muted' }]);
    rows.push([{ v: 'Generated ' + S.todayISO() + ' · currency ' + (st.settings.currencyCode || ''), s: 'muted' }]);
    rows.push([]);

    rows.push([{ v: 'Headline', s: 'group' }, { v: '', s: 'group' }, { v: '', s: 'group' }]);
    var line = function (label, formulaCell, note) { rows.push([label, formulaCell, note ? { v: note, s: 'muted' } : null]); };

    line('Total income', {
      t: 'formula', f: 'SUM(' + sheetRef('Income', 'D2:D' + Math.max(sheets.income._lastRow, 2)) + ')',
      v: income / 100, s: 'moneyBold'
    }, S.plural(sheets.income._count, 'entry', 'entries'));
    line('Total bills', {
      t: 'formula', f: 'SUM(' + sheetRef('Bills', 'F2:F' + Math.max(sheets.bills._lastRow, 2)) + ')',
      v: billsTotal / 100, s: 'moneyBold'
    }, S.plural(sheets.bills._count, 'bill'));
    line('  of which paid', { t: 'money', v: billsPaid / 100, s: 'money' });
    line('  still outstanding', { t: 'money', v: (billsTotal - billsPaid) / 100, s: 'money' });
    line('Total purchases', {
      t: 'formula', f: 'SUM(' + sheetRef('Purchases', 'D2:D' + Math.max(sheets.purchases._lastRow, 2)) + ')',
      v: purchases / 100, s: 'moneyBold'
    }, S.plural(sheets.purchases._count, 'purchase'));
    line('Total spent (bills + purchases)', { t: 'money', v: spent / 100, s: 'moneyBold' });
    line('Net (income − spent)', { t: 'money', v: net / 100, s: 'moneyBold' });
    rows.push([]);

    /* What is committed rather than what happened: the standing set-up, put on
       a monthly footing so cadences are comparable. Independent of scope. */
    var activeOnly = function (list) { return list.filter(function (t) { return t.active; }); };
    var incomePerMonth = S.sum(activeOnly(st.incomeTemplates), S.monthlyEquivalent);
    var billsPerMonth = S.sum(activeOnly(st.billTemplates), S.monthlyEquivalent);
    rows.push([{ v: 'Recurring set-up, per month', s: 'group' }, { v: '', s: 'group' }, { v: '', s: 'group' }]);
    line('Recurring income', { t: 'money', v: incomePerMonth / 100, s: 'moneyBold' },
      S.plural(activeOnly(st.incomeTemplates).length, 'active source'));
    line('Recurring bills', { t: 'money', v: billsPerMonth / 100, s: 'moneyBold' },
      S.plural(activeOnly(st.billTemplates).length, 'active bill'));
    line('Left over before purchases', { t: 'money', v: (incomePerMonth - billsPerMonth) / 100, s: 'moneyBold' });
    rows.push([]);

    rows.push([{ v: 'Savings', s: 'group' }, { v: '', s: 'group' }, { v: '', s: 'group' }]);
    line('Paid into savings', { t: 'money', v: sheets.savingsTx._in / 100, s: 'money' });
    line('Withdrawn from savings', { t: 'money', v: sheets.savingsTx._out / 100, s: 'money' });
    line('Net saved', { t: 'money', v: savedNet / 100, s: 'moneyBold' });
    line('Savings rate', { t: 'percent', v: income > 0 ? savedNet / income : 0 }, 'net saved ÷ income');
    line('Total across all accounts', {
      t: 'formula', f: 'SUM(' + sheetRef('Savings Accounts', 'F2:F' + Math.max(st.accounts.length + 1, 2)) + ')',
      v: sheets.accounts._total / 100, s: 'moneyBold'
    }, S.plural(st.accounts.length, 'account') + ' (all time)');
    rows.push([]);

    rows.push([{ v: 'Where the money went', s: 'group' }, { v: '', s: 'group' }, { v: '', s: 'group' }]);
    var outgoings = sel.bills.concat(sel.purchases);
    var groups = S.groupByCategory(outgoings).slice(0, 12);
    groups.forEach(function (g) {
      rows.push([g.category, money(g.amount), { t: 'percent', v: spent ? g.amount / spent : 0 }]);
    });
    if (!groups.length) rows.push([{ v: 'No outgoings recorded for this period.', s: 'muted' }]);

    return {
      name: 'Summary',
      cols: [{ w: 34 }, { w: 18 }, { w: 22 }],
      rows: rows
    };
  }

  /* ------------------------------------------------------------------ build */

  function build(scope) {
    var sel = scopeRecords(scope);
    var sheets = {
      income: incomeSheet(sel.income),
      incomeTemplates: incomeTemplatesSheet(),
      bills: billsSheet(sel.bills),
      templates: templatesSheet(),
      purchases: purchasesSheet(sel.purchases),
      accounts: accountsSheet(),
      savingsTx: savingsTxSheet(sel.savingsTx),
      monthly: monthlySheet(sel.periods),
      categories: categorySheet(sel),
      utilities: utilitiesSheet(sel.bills)
    };

    return root.XLSXMini.write({
      currency: S.state.settings.currencySymbol,
      sheets: [
        summarySheet(scope, sel, sheets),
        sheets.income, sheets.incomeTemplates,
        sheets.bills, sheets.templates, sheets.purchases,
        sheets.utilities, sheets.accounts, sheets.savingsTx,
        sheets.monthly, sheets.categories
      ]
    });
  }

  function filename(scope) {
    var stamp = scope.type === 'all' ? 'all-time'
      : scope.type === 'year' ? String(scope.year)
        : scope.period;
    return 'income-tracker-' + stamp + '.xlsx';
  }

  root.Exporter = { build: build, filename: filename, scopeLabel: scopeLabel, scopeRecords: scopeRecords };
}(typeof globalThis !== 'undefined' ? globalThis : this));
