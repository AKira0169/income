/* workbook/build.ts — turns the store into a multi-sheet workbook.

   Every total is a live Excel formula carrying a cached value, so the numbers
   still add up if you edit rows in Excel, and still read correctly in a tool
   that never evaluates formulas. */

import { METERED } from '../domain/catalog.ts';
import { plural } from '../domain/money.ts';
import { monthlyEquivalent, periodLabel, todayISO } from '../domain/period.ts';
import { billIsOverdue } from '../domain/recurring.ts';
import {
  accountBalance, accountFlows, accountName, activePeriods, billsIn, groupByCategory,
  incomeIn, purchasesIn, savingsBalance, savingsMovement, savingsTxIn, sum, summary,
  totalSavings
} from '../domain/selectors.ts';
import { goldHoldings, goldIn, goldPricePerGram, goldSummary } from '../domain/gold.ts';
import { write } from './xlsx.ts';
import type { CellInput, CellObject, Sheet, StyleName } from './xlsx.ts';
import type {
  AppState, Bill, Cents, GoldEntry, IncomeEntry, IsoDate, Period, Purchase, SavingsTx
} from '../domain/types.ts';

/* ------------------------------------------------------------ cell makers */

const money = (cents: Cents | null | undefined): CellObject => ({ t: 'money', v: (cents ?? 0) / 100 });
const moneyBold = (cents: Cents): CellObject => ({ t: 'money', v: cents / 100, s: 'moneyBold' });
const date = (iso: IsoDate | '' | null | undefined): CellObject | null => (iso ? { t: 'date', v: iso } : null);
const head = (label: string): CellObject => ({ v: label, s: 'header' });
const bold = (v: string): CellObject => ({ v, s: 'bold' });
const styled = (v: string, s: StyleName): CellObject => ({ v, s });

const headerRow = (labels: readonly string[]): CellInput[] => labels.map(head);

/** A number cell, or blank when there is nothing to show. */
function optionalNumber(value: unknown): CellObject | null {
  if (value === null || value === undefined || value === '') return null;
  return { t: 'number', v: Number(value) };
}

/** SUM over a column, or a literal 0 when there is nothing to sum. */
function columnTotal(col: string, firstRow: number, lastRow: number, cachedCents: Cents): CellObject {
  if (lastRow < firstRow) return { t: 'money', v: 0, s: 'moneyBold' };
  return {
    t: 'formula',
    f: `SUM(${col}${firstRow}:${col}${lastRow})`,
    v: (cachedCents ?? 0) / 100,
    s: 'moneyBold'
  };
}

/** Excel needs a sheet name quoted once it is not a bare identifier. */
function sheetRef(name: string, cell: string): string {
  const quoted = /[^A-Za-z0-9_]/.test(name) ? `'${name.replace(/'/g, "''")}'` : name;
  return `${quoted}!${cell}`;
}

const byDate = <T extends { date?: IsoDate }>(a: T, b: T): number =>
  String(a.date).localeCompare(String(b.date));

/* ------------------------------------------------------------- selection */

export type Scope =
  | { type: 'all' }
  | { type: 'year'; year: number | string }
  | { type: 'month'; period: Period };

export interface ScopeSelection {
  income: IncomeEntry[];
  bills: Bill[];
  purchases: Purchase[];
  savingsTx: SavingsTx[];
  gold: GoldEntry[];
  periods: Period[];
}

export function scopeRecords(state: AppState, scope: Scope): ScopeSelection {
  if (scope.type === 'all') {
    return {
      income: state.income.slice(),
      bills: state.bills.slice(),
      purchases: state.purchases.slice(),
      savingsTx: state.savingsTx.slice(),
      gold: state.gold.slice(),
      periods: activePeriods(state).slice().sort()
    };
  }

  if (scope.type === 'year') {
    const yr = String(scope.year);
    const inYear = (iso: string | null | undefined): boolean => String(iso ?? '').slice(0, 4) === yr;
    return {
      income: state.income.filter((r) => inYear(r.date)),
      bills: state.bills.filter((r) => String(r.period ?? '').slice(0, 4) === yr),
      purchases: state.purchases.filter((r) => inYear(r.date)),
      savingsTx: state.savingsTx.filter((r) => inYear(r.date)),
      gold: state.gold.filter((r) => inYear(r.date)),
      periods: activePeriods(state).filter((p) => p.slice(0, 4) === yr).sort()
    };
  }

  const p = scope.period;
  return {
    income: incomeIn(state, p),
    bills: billsIn(state, p),
    purchases: purchasesIn(state, p),
    savingsTx: savingsTxIn(state, p),
    gold: goldIn(state, p),
    periods: [p]
  };
}

export function scopeLabel(state: AppState, scope: Scope): string {
  if (scope.type === 'all') return 'All time';
  if (scope.type === 'year') return `Year ${scope.year}`;
  return periodLabel(scope.period, state.settings.locale);
}

/* ---------------------------------------------------------------- sheets */

/* Figures the Summary sheet needs back from a data sheet: it addresses other
   sheets by cell, so it has to know how far their rows run. */
interface SheetTotals {
  total: Cents;
  lastRow: number;
  count: number;
}

type IncomeSheet = Sheet & SheetTotals;
type BillsSheet = Sheet & SheetTotals & { paid: Cents };
type PurchasesSheet = Sheet & SheetTotals;
type AccountsSheet = Sheet & { total: Cents };
type SavingsSheet = Sheet & { movedIn: Cents; movedOut: Cents };

/** A filter range only makes sense once there is a row to filter. */
const filterRange = (lastCol: string, count: number): string | undefined =>
  count ? `A1:${lastCol}${count + 1}` : undefined;

/* The Recurring and Paid Into columns are appended rather than inserted:
   Amount stays in column D, which the Summary sheet and the total below both
   address by letter. */
function incomeSheet(state: AppState, records: readonly IncomeEntry[]): IncomeSheet {
  const sorted = records.slice().sort(byDate);
  const rows: CellInput[][] = [
    headerRow(['Date', 'Source', 'Category', 'Amount', 'Method', 'Notes', 'Recurring', 'Paid Into'])
  ];
  for (const r of sorted) {
    rows.push([date(r.date), r.source || '', r.category || '', money(r.amount), r.method || '',
      r.notes || '', r.templateId ? 'Yes' : '', accountName(state, r.accountId)]);
  }
  const total = sum(sorted, (r) => r.amount);
  rows.push([]);
  rows.push([bold('Total'), null, null, columnTotal('D', 2, sorted.length + 1, total), null, null, null, null]);

  return {
    name: 'Income', freeze: 1,
    autoFilter: filterRange('H', sorted.length),
    cols: [{ w: 12 }, { w: 24 }, { w: 16 }, { w: 14 }, { w: 16 }, { w: 34 }, { w: 11 }, { w: 18 }],
    rows,
    total, lastRow: sorted.length + 1, count: sorted.length
  };
}

function incomeTemplatesSheet(state: AppState): Sheet {
  const templates = state.incomeTemplates;
  const rows: CellInput[][] = [
    headerRow(['Source', 'Category', 'Frequency', 'Pay Day', 'Expected Amount',
      'Income / Month', 'Method', 'Active', 'Notes'])
  ];
  for (const t of templates) {
    rows.push([t.source || '', t.category || '', t.frequency || 'Monthly',
      { t: 'int', v: Number(t.payDay) || 1 }, money(t.expected),
      money(monthlyEquivalent(t)), t.method || '', t.active ? 'Yes' : 'No', t.notes || '']);
  }
  // As with bills: a yearly bonus is not a monthly income, so each cadence is
  // spread over 12 months to make the sources comparable.
  const perMonth = sum(templates.filter((t) => t.active), monthlyEquivalent);
  rows.push([]);
  rows.push([bold('Active recurring income, per month'), null, null, null, null, moneyBold(perMonth)]);
  rows.push([bold('Active recurring income, per year'), null, null, null, null, moneyBold(perMonth * 12)]);

  return {
    name: 'Recurring Income', freeze: 1,
    cols: [{ w: 26 }, { w: 16 }, { w: 13 }, { w: 10 }, { w: 16 }, { w: 15 }, { w: 16 }, { w: 8 }, { w: 28 }],
    rows
  };
}

function billsSheet(state: AppState, records: readonly Bill[]): BillsSheet {
  const sorted = records.slice().sort((a, b) =>
    String(a.period + a.dueDate).localeCompare(String(b.period + b.dueDate)));

  const rows: CellInput[][] = [
    headerRow(['Period', 'Due Date', 'Bill', 'Category', 'Provider', 'Amount', 'Units Used',
      'Unit', 'Rate / Unit', 'Status', 'Paid Date', 'Method', 'Notes', 'Paid From'])
  ];
  for (const b of sorted) {
    const status = b.status === 'paid' ? 'Paid' : (billIsOverdue(b) ? 'OVERDUE' : 'Unpaid');
    rows.push([
      b.period || '', date(b.dueDate), b.name || '', b.category || '', b.provider || '',
      money(b.amount),
      optionalNumber(b.units),
      METERED[b.category] || '',
      optionalNumber(b.unitRate),
      status,
      date(b.paidDate), b.method || '', b.notes || '', accountName(state, b.accountId)
    ]);
  }
  const total = sum(sorted, (r) => r.amount);
  const paid = sum(sorted.filter((b) => b.status === 'paid'), (r) => r.amount);
  rows.push([]);
  rows.push([bold('Total billed'), null, null, null, null, columnTotal('F', 2, sorted.length + 1, total)]);
  rows.push([bold('Paid'), null, null, null, null, moneyBold(paid)]);
  rows.push([bold('Outstanding'), null, null, null, null, moneyBold(total - paid)]);

  return {
    name: 'Bills', freeze: 1,
    autoFilter: filterRange('N', sorted.length),
    cols: [{ w: 10 }, { w: 12 }, { w: 22 }, { w: 16 }, { w: 18 }, { w: 14 }, { w: 12 }, { w: 8 },
      { w: 12 }, { w: 11 }, { w: 12 }, { w: 15 }, { w: 28 }, { w: 18 }],
    rows,
    total, paid, lastRow: sorted.length + 1, count: sorted.length
  };
}

function billTemplatesSheet(state: AppState): Sheet {
  const templates = state.billTemplates;
  const rows: CellInput[][] = [
    headerRow(['Bill', 'Category', 'Provider', 'Frequency', 'Due Day', 'Expected Amount',
      'Cost / Month', 'Method', 'Active', 'Notes'])
  ];
  for (const t of templates) {
    rows.push([t.name || '', t.category || '', t.provider || '', t.frequency || 'Monthly',
      { t: 'int', v: Number(t.dueDay) || 1 }, money(t.expected),
      money(monthlyEquivalent(t)), t.method || '', t.active ? 'Yes' : 'No', t.notes || '']);
  }
  // A yearly bill is not a monthly cost — spread each cadence over 12 months.
  const perMonth = sum(templates.filter((t) => t.active), monthlyEquivalent);
  rows.push([]);
  rows.push([bold('Active recurring bills, per month'), null, null, null, null, null, moneyBold(perMonth)]);
  rows.push([bold('Active recurring bills, per year'), null, null, null, null, null, moneyBold(perMonth * 12)]);

  return {
    name: 'Recurring Bills', freeze: 1,
    cols: [{ w: 22 }, { w: 16 }, { w: 18 }, { w: 13 }, { w: 10 }, { w: 16 }, { w: 14 }, { w: 15 }, { w: 8 }, { w: 28 }],
    rows
  };
}

function purchasesSheet(state: AppState, records: readonly Purchase[]): PurchasesSheet {
  const sorted = records.slice().sort(byDate);
  const rows: CellInput[][] = [
    headerRow(['Date', 'Item', 'Category', 'Amount', 'Method', 'Notes', 'Paid From'])
  ];
  for (const r of sorted) {
    rows.push([date(r.date), r.item || '', r.category || '', money(r.amount), r.method || '',
      r.notes || '', accountName(state, r.accountId)]);
  }
  const total = sum(sorted, (r) => r.amount);
  rows.push([]);
  rows.push([bold('Total'), null, null, columnTotal('D', 2, sorted.length + 1, total)]);

  return {
    name: 'Purchases', freeze: 1,
    autoFilter: filterRange('G', sorted.length),
    cols: [{ w: 12 }, { w: 28 }, { w: 18 }, { w: 14 }, { w: 16 }, { w: 30 }, { w: 18 }],
    rows,
    total, lastRow: sorted.length + 1, count: sorted.length
  };
}

/* Column F stays Current Balance: the Summary sheet sums it by letter. Paid In
   and Withdrawn cover every flow that touches the account, not only the
   movements you recorded by hand, or the columns would not add up to the
   balance beside them. */
function accountsSheet(state: AppState): AccountsSheet {
  const rows: CellInput[][] = [
    headerRow(['Account', 'Type', 'Opening Balance', 'Paid In', 'Withdrawn', 'Current Balance',
      'Target', 'Progress', 'Notes', 'Income', 'Purchases', 'Bills Paid', 'Gold', 'Moved In', 'Moved Out'])
  ];
  for (const a of state.accounts) {
    const f = accountFlows(state, a.id);
    const balance = accountBalance(state, a.id);
    rows.push([
      a.name || '', a.type || '', money(a.opening),
      money(f.income + f.savedIn),
      money(f.purchases + f.bills + f.savedOut + f.gold),
      money(balance),
      a.target ? money(a.target) : null,
      a.target ? { t: 'percent', v: balance / a.target } : null,
      a.notes || '',
      money(f.income), money(f.purchases), money(f.bills), money(f.gold),
      money(f.savedIn), money(f.savedOut)
    ]);
  }
  const total = totalSavings(state);
  rows.push([]);
  rows.push([bold('Across all accounts'), null, null, null, null,
    columnTotal('F', 2, state.accounts.length + 1, total)]);
  rows.push([bold('Of which savings pots'), null, null, null, null, moneyBold(savingsBalance(state))]);

  return {
    name: 'Savings Accounts', freeze: 1,
    cols: [{ w: 24 }, { w: 16 }, { w: 16 }, { w: 14 }, { w: 14 }, { w: 17 }, { w: 14 }, { w: 11 }, { w: 28 },
      { w: 14 }, { w: 14 }, { w: 14 }, { w: 12 }, { w: 13 }, { w: 13 }],
    rows,
    total
  };
}

function movementLabel(t: SavingsTx): string {
  if (t.direction === 'transfer') return 'Transfer';
  return t.direction === 'out' ? 'Withdrawal' : 'Deposit';
}

function savingsTxSheet(state: AppState, records: readonly SavingsTx[]): SavingsSheet {
  const sorted = records.slice().sort(byDate);
  const rows: CellInput[][] = [
    headerRow(['Date', 'Account', 'Direction', 'Amount', 'Notes', 'From Account', 'Counts As Saving'])
  ];
  for (const t of sorted) {
    const move = savingsMovement(state, t);
    rows.push([
      date(t.date), accountName(state, t.accountId) || '(deleted account)',
      movementLabel(t), money(t.amount), t.notes || '',
      t.direction === 'transfer' ? (accountName(state, t.fromAccountId) || '(deleted account)') : '',
      move.in ? 'In' : (move.out ? 'Out' : 'No')
    ]);
  }
  // Moving money between two of your own pots is not saving more of it, so the
  // totals count only what crossed the line into or out of savings.
  const movedIn = sum(sorted, (t) => savingsMovement(state, t).in);
  const movedOut = sum(sorted, (t) => savingsMovement(state, t).out);
  rows.push([]);
  rows.push([bold('Into savings'), null, null, moneyBold(movedIn)]);
  rows.push([bold('Out of savings'), null, null, moneyBold(movedOut)]);
  rows.push([bold('Net saved'), null, null, moneyBold(movedIn - movedOut)]);

  return {
    name: 'Savings Transactions', freeze: 1,
    autoFilter: filterRange('G', sorted.length),
    cols: [{ w: 12 }, { w: 24 }, { w: 13 }, { w: 14 }, { w: 32 }, { w: 24 }, { w: 16 }],
    rows,
    movedIn, movedOut
  };
}

/* Gold: what was bought and sold, what is left, and the daily price series the
   valuation is built on — so the workbook stands on its own. */
function goldSheet(state: AppState, records: readonly GoldEntry[]): Sheet {
  const sorted = records.slice().sort(byDate);
  const rows: CellInput[][] = [
    headerRow(['Date', 'Bought / Sold', 'Karat', 'Grams', 'Amount', 'Price / Gram',
      'Paid From', 'Shop', 'Notes'])
  ];
  sorted.forEach((r, i) => {
    const grams = Number(r.grams) || 0;
    const line = i + 2;
    rows.push([
      date(r.date), r.direction === 'sell' ? 'Sold' : 'Bought',
      { t: 'int', v: Number(r.karat) || 24 },
      grams ? { t: 'number', v: grams } : null,
      money(r.amount),
      grams
        ? { t: 'formula', f: `IF(D${line}=0,"",E${line}/D${line})`, v: (r.amount / 100) / grams, s: 'money' }
        : null,
      accountName(state, r.accountId), r.dealer || '', r.notes || ''
    ]);
  });
  if (!sorted.length) rows.push([styled('No gold recorded in this period.', 'muted')]);

  const figures = goldSummary(state);
  rows.push([]);
  rows.push(Array.from({ length: 6 }, (_, i) => styled(i === 0 ? 'Held now (all time)' : '', 'group')));
  rows.push([head('Karat'), head('Grams'), head('Price / Gram'), head('Worth')]);
  for (const h of goldHoldings(state)) {
    rows.push([{ t: 'int', v: h.karat }, { t: 'number', v: h.grams },
      money(goldPricePerGram(state, h.karat)), money(h.value)]);
  }
  rows.push([bold('Total worth'), null, null, moneyBold(figures.value)]);
  rows.push([bold('Paid for it'), null, null, moneyBold(figures.invested)]);
  rows.push([bold(figures.gain >= 0 ? 'Gain' : 'Loss'), null, null, moneyBold(figures.gain)]);
  rows.push([]);

  const history = state.goldPrices.slice().sort(byDate);
  rows.push(Array.from({ length: 4 }, (_, i) => styled(i === 0 ? 'Price history' : '', 'group')));
  rows.push([head('Date'), head('24k / Gram'), head('USD / Ounce'), head('EGP per USD'), head('Source')]);
  for (const p of history) {
    rows.push([date(p.date), money(p.egpPerGram24),
      { t: 'number', v: Number(p.usdPerOz) || 0 }, { t: 'number', v: Number(p.egpPerUsd) || 0 },
      p.source || '']);
  }
  if (!history.length) rows.push([styled('No prices have been fetched yet.', 'muted')]);

  return {
    name: 'Gold', freeze: 1,
    cols: [{ w: 12 }, { w: 14 }, { w: 9 }, { w: 11 }, { w: 14 }, { w: 14 }, { w: 18 }, { w: 18 }, { w: 26 }],
    rows
  };
}

/** The Monthly Breakdown columns that carry a running money total. */
const MONTHLY_KEYS = ['income', 'bills', 'purchases', 'spent', 'net', 'savedIn', 'savedOut', 'savedNet'] as const;
const MONTHLY_COLS = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'] as const;

function monthlySheet(state: AppState, periods: readonly Period[]): Sheet {
  const list = periods.slice().sort();
  const rows: CellInput[][] = [
    headerRow(['Month', 'Income', 'Bills', 'Purchases', 'Total Spent', 'Net',
      'Paid Into Savings', 'Withdrawn', 'Net Saved', 'Savings Rate'])
  ];

  const summaries = list.map((p) => summary(state, p));
  summaries.forEach((s, i) => {
    const r = i + 2;
    rows.push([
      s.period,
      money(s.income), money(s.bills), money(s.purchases),
      { t: 'formula', f: `C${r}+D${r}`, v: s.spent / 100, s: 'money' },
      { t: 'formula', f: `B${r}-E${r}`, v: s.net / 100, s: 'money' },
      money(s.savedIn), money(s.savedOut),
      { t: 'formula', f: `G${r}-H${r}`, v: s.savedNet / 100, s: 'money' },
      { t: 'formula', f: `IF(B${r}=0,0,I${r}/B${r})`, v: s.savingsRate, s: 'percent' }
    ]);
  });

  const last = list.length + 1;
  rows.push([]);

  if (list.length) {
    /* Every formula carries a cached value: without one the row reads as 0 (or
       blank) in Excel until a recalculation happens, and stays 0 in any tool
       that reads the file without evaluating formulas. */
    const totals = {} as Record<(typeof MONTHLY_KEYS)[number], number>;
    for (const key of MONTHLY_KEYS) {
      totals[key] = summaries.reduce((acc, s) => acc + s[key], 0);
    }

    const totalRow = list.length + 3;
    rows.push([
      bold('Total'),
      ...MONTHLY_COLS.map((col, i) => columnTotal(col, 2, last, totals[MONTHLY_KEYS[i]!])),
      {
        t: 'formula', f: `IF(B${totalRow}=0,0,I${totalRow}/B${totalRow})`, s: 'percent',
        v: totals.income > 0 ? totals.savedNet / totals.income : 0
      }
    ]);

    rows.push([
      bold('Monthly average'),
      ...MONTHLY_COLS.map((col, i) => ({
        t: 'formula' as const,
        f: `AVERAGE(${col}2:${col}${last})`,
        s: 'moneyBold' as const,
        v: (totals[MONTHLY_KEYS[i]!] / list.length) / 100
      }))
    ]);
  }

  return {
    name: 'Monthly Breakdown', freeze: 1,
    cols: [{ w: 11 }, ...[16, 14, 14, 14, 14, 17, 14, 14, 12].map((w) => ({ w }))],
    rows
  };
}

function categorySheet(sel: ScopeSelection): Sheet {
  const rows: CellInput[][] = [headerRow(['Type', 'Category', 'Amount', 'Share of Type', 'Entries'])];

  const block = (label: string, records: ReadonlyArray<{ category?: string; amount?: Cents }>): void => {
    const groups = groupByCategory(records);
    const total = sum(groups, (g) => g.amount);
    if (!groups.length) {
      rows.push([styled(label, 'group'), styled('no entries', 'muted'), null, null, null]);
      return;
    }
    groups.forEach((g, i) => {
      const count = records.filter((r) => (r.category || 'Uncategorised') === g.category).length;
      rows.push([
        i === 0 ? styled(label, 'group') : '',
        g.category, money(g.amount),
        { t: 'percent', v: total ? g.amount / total : 0 },
        { t: 'int', v: count }
      ]);
    });
    rows.push([bold(`${label} total`), null, moneyBold(total), null, null]);
    rows.push([]);
  };

  block('Income', sel.income);
  block('Bills', sel.bills);
  block('Purchases', sel.purchases);

  return {
    name: 'Category Breakdown', freeze: 1,
    cols: [{ w: 16 }, { w: 22 }, { w: 15 }, { w: 14 }, { w: 10 }],
    rows
  };
}

function utilitiesSheet(bills: readonly Bill[]): Sheet {
  const metered = bills
    .filter((b) => METERED[b.category])
    .sort((a, b) => String(a.category + a.period).localeCompare(String(b.category + b.period)));

  const rows: CellInput[][] = [
    headerRow(['Period', 'Utility', 'Provider', 'Units Used', 'Unit', 'Rate / Unit',
      'Amount', 'Implied Cost / Unit'])
  ];
  metered.forEach((b, i) => {
    const r = i + 2;
    const units = Number(b.units);
    const hasUnits = Number.isFinite(units) && units > 0;
    rows.push([
      b.period || '', b.category, b.provider || '',
      hasUnits ? { t: 'number', v: units } : null,
      METERED[b.category] ?? '',
      optionalNumber(b.unitRate),
      money(b.amount),
      hasUnits
        ? { t: 'formula', f: `IF(D${r}=0,"",G${r}/D${r})`, v: (b.amount / 100) / units, s: 'money' }
        : null
    ]);
  });
  if (!metered.length) {
    rows.push([styled('No metered utility bills recorded yet. Add units to electricity, ' +
      'water or gas bills to track consumption here.', 'muted')]);
  }

  return {
    name: 'Utilities & Meters', freeze: 1,
    cols: [{ w: 10 }, { w: 16 }, { w: 18 }, { w: 12 }, { w: 8 }, { w: 12 }, { w: 14 }, { w: 18 }],
    rows
  };
}

interface BuiltSheets {
  income: IncomeSheet;
  bills: BillsSheet;
  purchases: PurchasesSheet;
  accounts: AccountsSheet;
  savingsTx: SavingsSheet;
}

function summarySheet(state: AppState, scope: Scope, sel: ScopeSelection, sheets: BuiltSheets): Sheet {
  const income = sheets.income.total;
  const billsTotal = sheets.bills.total;
  const billsPaid = sheets.bills.paid;
  const purchases = sheets.purchases.total;
  const spent = billsTotal + purchases;
  const net = income - spent;
  const savedNet = sheets.savingsTx.movedIn - sheets.savingsTx.movedOut;

  const rows: CellInput[][] = [];
  const groupHeading = (label: string): void => {
    rows.push([styled(label, 'group'), styled('', 'group'), styled('', 'group')]);
  };
  const line = (label: string, cell: CellObject, note?: string | null): void => {
    rows.push([label, cell, note ? styled(note, 'muted') : null]);
  };

  rows.push([styled('Income & Spending Report', 'title')]);
  rows.push([styled(scopeLabel(state, scope), 'muted')]);
  rows.push([styled(`Generated ${todayISO()} · currency ${state.settings.currencyCode || ''}`, 'muted')]);
  rows.push([]);

  groupHeading('Headline');
  line('Total income', {
    t: 'formula', f: `SUM(${sheetRef('Income', `D2:D${Math.max(sheets.income.lastRow, 2)}`)})`,
    v: income / 100, s: 'moneyBold'
  }, plural(sheets.income.count, 'entry', 'entries'));
  line('Total bills', {
    t: 'formula', f: `SUM(${sheetRef('Bills', `F2:F${Math.max(sheets.bills.lastRow, 2)}`)})`,
    v: billsTotal / 100, s: 'moneyBold'
  }, plural(sheets.bills.count, 'bill'));
  line('  of which paid', { t: 'money', v: billsPaid / 100, s: 'money' });
  line('  still outstanding', { t: 'money', v: (billsTotal - billsPaid) / 100, s: 'money' });
  line('Total purchases', {
    t: 'formula', f: `SUM(${sheetRef('Purchases', `D2:D${Math.max(sheets.purchases.lastRow, 2)}`)})`,
    v: purchases / 100, s: 'moneyBold'
  }, plural(sheets.purchases.count, 'purchase'));
  line('Total spent (bills + purchases)', moneyBold(spent));
  line('Net (income − spent)', moneyBold(net));
  rows.push([]);

  /* What is committed rather than what happened: the standing set-up, put on a
     monthly footing so cadences are comparable. Independent of scope. */
  const activeIncome = state.incomeTemplates.filter((t) => t.active);
  const activeBills = state.billTemplates.filter((t) => t.active);
  const incomePerMonth = sum(activeIncome, monthlyEquivalent);
  const billsPerMonth = sum(activeBills, monthlyEquivalent);

  groupHeading('Recurring set-up, per month');
  line('Recurring income', moneyBold(incomePerMonth), plural(activeIncome.length, 'active source'));
  line('Recurring bills', moneyBold(billsPerMonth), plural(activeBills.length, 'active bill'));
  line('Left over before purchases', moneyBold(incomePerMonth - billsPerMonth));
  rows.push([]);

  groupHeading('Savings');
  line('Paid into savings', { t: 'money', v: sheets.savingsTx.movedIn / 100, s: 'money' });
  line('Withdrawn from savings', { t: 'money', v: sheets.savingsTx.movedOut / 100, s: 'money' });
  line('Net saved', moneyBold(savedNet));
  line('Savings rate', { t: 'percent', v: income > 0 ? savedNet / income : 0 }, 'net saved ÷ income');
  line('Total across all accounts', {
    t: 'formula',
    f: `SUM(${sheetRef('Savings Accounts', `F2:F${Math.max(state.accounts.length + 1, 2)}`)})`,
    v: sheets.accounts.total / 100, s: 'moneyBold'
  }, `${plural(state.accounts.length, 'account')} (all time)`);
  rows.push([]);

  /* Only when there is gold to report. An empty block on everyone else's
     summary would be noise, and the rows above keep their addresses. */
  if (state.gold.length) {
    const gold = goldSummary(state);
    groupHeading('Gold');
    line('Gold held', { t: 'number', v: gold.grams }, `${gold.pure.toFixed(2)} g of pure gold`);
    line('Worth today', moneyBold(gold.value),
      gold.price ? `priced ${gold.price.date}` : 'no price fetched');
    line('Paid for it', { t: 'money', v: gold.invested / 100, s: 'money' });
    line(gold.gain >= 0 ? 'Gain' : 'Loss', moneyBold(gold.gain),
      gold.invested ? `${Math.round(gold.gainRate * 100)}% on what you paid` : null);
    line('Accounts and gold together', moneyBold(sheets.accounts.total + gold.value));
    rows.push([]);
  }

  groupHeading('Where the money went');
  const groups = groupByCategory([...sel.bills, ...sel.purchases]).slice(0, 12);
  for (const g of groups) {
    rows.push([g.category, money(g.amount), { t: 'percent', v: spent ? g.amount / spent : 0 }]);
  }
  if (!groups.length) rows.push([styled('No outgoings recorded for this period.', 'muted')]);

  return { name: 'Summary', cols: [{ w: 34 }, { w: 18 }, { w: 22 }], rows };
}

/* ------------------------------------------------------------------ build */

export function build(state: AppState, scope: Scope): Uint8Array<ArrayBuffer> {
  const sel = scopeRecords(state, scope);
  const sheets = {
    income: incomeSheet(state, sel.income),
    bills: billsSheet(state, sel.bills),
    purchases: purchasesSheet(state, sel.purchases),
    accounts: accountsSheet(state),
    savingsTx: savingsTxSheet(state, sel.savingsTx)
  };

  return write({
    currency: state.settings.currencySymbol,
    // Sheet order is the reading order of the report, not the build order.
    sheets: [
      summarySheet(state, scope, sel, sheets),
      sheets.income, incomeTemplatesSheet(state),
      sheets.bills, billTemplatesSheet(state), sheets.purchases,
      utilitiesSheet(sel.bills), sheets.accounts, sheets.savingsTx, goldSheet(state, sel.gold),
      monthlySheet(state, sel.periods), categorySheet(sel)
    ]
  });
}

export function filename(scope: Scope): string {
  const stamp = scope.type === 'all' ? 'all-time'
    : scope.type === 'year' ? String(scope.year)
      : scope.period;
  return `income-tracker-${stamp}.xlsx`;
}
