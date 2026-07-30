/* Export test: seed the store, build the real workbook, parse it back.
   Run:  node test/export.ts      (XLSX_ORACLE must point at a dir with `xlsx`) */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import * as Store from '../src/store.ts';
import * as DatePicker from '../src/datepicker.ts';
import { build, filename } from '../src/export.ts';
import type { Bill, Frequency, Period } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.XLSX_OUT || join(here, '..', '.tmp');
mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown): void => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  } else console.log(`  ok   ${label}`);
};

/* ---------------- money parsing (pure unit checks) ---------------- */
console.log('parseMoney:');
check('plain', Store.parseMoney('1234.56'), 123456);
check('grouped', Store.parseMoney('1,234.56'), 123456);
check('european', Store.parseMoney('1.234,56'), 123456);
check('with symbol', Store.parseMoney('$ 1 234.56'), 123456);
check('integer', Store.parseMoney('80'), 8000);
check('one decimal', Store.parseMoney('80.5'), 8050);
check('negative', Store.parseMoney('-42.10'), -4210);
check('parenthesised negative', Store.parseMoney('(50)'), -5000);
check('empty', Store.parseMoney(''), 0);
check('grouped thousands no decimals', Store.parseMoney('12,000'), 1200000);
check('number input', Store.parseMoney(19.99), 1999);
// A minus only negates when it comes before the digits: text pasted in after an
// amount used to flip the sign of the whole entry.
check('a dash after the digits is not a sign', Store.parseMoney('1,200 - rent'), 120000);
check('a symbol before the sign still negates', Store.parseMoney('$-42.10'), -4210);
check('a hyphenated note is not negative', Store.parseMoney('50 e-mail top-up'), 5000);

/* ---------------- seed ---------------- */
const accId = 'acc_emergency';
Store.replaceState({
  settings: { currencySymbol: '£', currencyCode: 'GBP', locale: 'en-GB', savingsGoalRate: 20 },
  income: [
    { id: 'i1', date: '2026-06-28', source: 'Acme Ltd', category: 'Salary', amount: 320000, method: 'Bank Transfer', notes: 'June pay' },
    { id: 'i2', templateId: 'it1', date: '2026-07-28', source: 'Acme Ltd', category: 'Salary', amount: 320000, method: 'Bank Transfer', notes: '' },
    { id: 'i3', date: '2026-07-12', source: 'Café Ünïcode & Co', category: 'Freelance', amount: 45050, method: 'Card', notes: 'logo <design>' }
  ],
  incomeTemplates: [
    { id: 'it1', source: 'Acme Ltd', category: 'Salary', frequency: 'Monthly', payDay: 25, expected: 320000, method: 'Bank Transfer', active: true, anchor: '2026-06', generatedThrough: null, notes: '' },
    { id: 'it2', source: 'Rental flat', category: 'Rental', frequency: 'Quarterly', payDay: 1, expected: 90000, method: 'Bank Transfer', active: true, anchor: '2026-07', generatedThrough: null, notes: '' }
  ],
  billTemplates: [
    { id: 't1', name: 'Electricity', category: 'Electricity', provider: 'Ørsted', frequency: 'Monthly', dueDay: 5, expected: 8500, method: 'Direct Debit', active: true, anchor: '2026-06', notes: '' },
    { id: 't2', name: 'Water', category: 'Water', provider: 'Thames', frequency: 'Quarterly', dueDay: 12, expected: 6000, method: 'Direct Debit', active: true, anchor: '2026-07', notes: '' }
  ],
  bills: [
    { id: 'b1', templateId: 't1', name: 'Electricity', category: 'Electricity', provider: 'Ørsted', period: '2026-06', dueDate: '2026-06-05', amount: 8210, units: 268, unitRate: 0.31, status: 'paid', paidDate: '2026-06-04', method: 'Direct Debit', notes: '' },
    { id: 'b2', templateId: 't1', name: 'Electricity', category: 'Electricity', provider: 'Ørsted', period: '2026-07', dueDate: '2026-07-05', amount: 9145, units: 295, unitRate: 0.31, status: 'paid', paidDate: '2026-07-05', method: 'Direct Debit', notes: 'hot month' },
    { id: 'b3', templateId: 't2', name: 'Water', category: 'Water', provider: 'Thames', period: '2026-07', dueDate: '2026-07-12', amount: 6120, units: 14, unitRate: 4.37, status: 'unpaid', paidDate: '', method: 'Direct Debit', notes: '' },
    { id: 'b4', templateId: null, name: 'Broadband', category: 'Internet', provider: 'Sky', period: '2026-07', dueDate: '2026-07-18', amount: 3499, units: null, unitRate: null, status: 'unpaid', paidDate: '', method: 'Direct Debit', notes: '' }
  ],
  purchases: [
    { id: 'p1', date: '2026-07-03', item: 'Weekly shop', category: 'Groceries', amount: 8734, method: 'Card', notes: '' },
    { id: 'p2', date: '2026-07-19', item: 'Headphones 🎧', category: 'Electronics', amount: 12999, method: 'Card', notes: 'a & b' }
  ],
  accounts: [
    { id: accId, name: 'Emergency Fund', type: 'Emergency Fund', target: 500000, opening: 100000, notes: '' },
    { id: 'acc_holiday', name: 'Holiday', type: 'Goal Pot', target: 200000, opening: 0, notes: '' }
  ],
  savingsTx: [
    { id: 's1', date: '2026-06-29', accountId: accId, direction: 'in', amount: 50000, notes: '' },
    { id: 's2', date: '2026-07-29', accountId: accId, direction: 'in', amount: 60000, notes: '' },
    { id: 's3', date: '2026-07-22', accountId: accId, direction: 'out', amount: 15000, notes: 'car repair' },
    { id: 's4', date: '2026-07-30', accountId: 'acc_holiday', direction: 'in', amount: 25000, notes: '' }
  ]
});

/* ---------------- derived figures ---------------- */
console.log('\nsummary(2026-07):');
const s = Store.summary('2026-07');
check('income', s.income, 320000 + 45050);
check('bills', s.bills, 9145 + 6120 + 3499);
check('purchases', s.purchases, 8734 + 12999);
check('spent', s.spent, 9145 + 6120 + 3499 + 8734 + 12999);
check('net', s.net, (320000 + 45050) - (9145 + 6120 + 3499 + 8734 + 12999));
check('savedIn', s.savedIn, 60000 + 25000);
check('savedOut', s.savedOut, 15000);
check('savedNet', s.savedNet, 70000);
check('billsPaid', s.billsPaid, 9145);
check('billsOutstanding', s.billsOutstanding, 6120 + 3499);

console.log('\nbalances:');
check('emergency fund balance', Store.accountBalance(accId), 100000 + 50000 + 60000 - 15000);
check('total savings', Store.totalSavings(), (100000 + 50000 + 60000 - 15000) + 25000);
check('active periods', Store.activePeriods().includes('2026-06') && Store.activePeriods().includes('2026-07'), true);

console.log('\nbill generation:');
const beforeAug = Store.state.bills.length;
const made = Store.generateBills('2026-08');
check('august generates monthly only (water is quarterly from July)', made, 1);
check('bill count grew by 1', Store.state.bills.length, beforeAug + 1);
check('re-running is idempotent', Store.generateBills('2026-08'), 0);
check('october picks up quarterly water', Store.generateBills('2026-10'), 2);

console.log('\nrecurring income:');
check('august generates the monthly salary only (rent is quarterly from July)', Store.generateIncome('2026-08'), 1);
check('re-running is idempotent', Store.generateIncome('2026-08'), 0);
const aug = Store.incomeIn('2026-08');
check('one august entry', aug.length, 1);
check('lands on the pay day', aug[0].date, '2026-08-25');
check('carries the template amount', aug[0].amount, 320000);
check('is traceable back to its template', aug[0].templateId, 'it1');
check('october picks up the quarterly rent too', Store.generateIncome('2026-10'), 2);

console.log('\nautomatic catch-up:');
// Every template starts unswept, so the first sweep has months to fill.
check('the first sweep adds entries', Store.catchUp().total > 0, true);
check('sweeping again adds nothing', Store.catchUp().total, 0);
check('every template is marked swept to the current month',
  [...Store.state.incomeTemplates, ...Store.state.billTemplates]
    .every((t) => t.generatedThrough === Store.currentPeriod()), true);
// The marker is what stops a row you deleted on purpose reappearing.
const doomed = Store.state.income.filter((r) => r.templateId === 'it1').pop()!;
Store.remove('income', doomed.id);
check('a deleted generated entry stays deleted', Store.catchUp().total, 0);
check('and is really gone', Store.state.income.some((r) => r.id === doomed.id), false);
// Asking for a month explicitly still works after the sweep has passed it.
check('the manual button can refill that month', Store.generateIncome(Store.periodOf(doomed.date)), 1);

console.log('\nfrequencies:');
const occurs = (frequency: Frequency, anchor: Period, period: Period): boolean =>
  Store.occursIn({ active: true, frequency, anchor }, period);
check('monthly occurs every month', [occurs('Monthly', '2026-01', '2026-07'), occurs('Monthly', '2026-01', '2026-08')], [true, true]);
check('quarterly: anchor, +3, not +1', ['2026-07', '2026-10', '2026-08'].map((p) => occurs('Quarterly', '2026-07', p)), [true, true, false]);
check('half-yearly: anchor, +6, not +3', ['2026-03', '2026-09', '2026-06'].map((p) => occurs('Half-yearly', '2026-03', p)), [true, true, false]);
check('yearly: anchor and +12 only', ['2026-04', '2027-04', '2026-10'].map((p) => occurs('Yearly', '2026-04', p)), [true, true, false]);
check('bi-monthly: every other month', ['2026-02', '2026-04', '2026-03'].map((p) => occurs('Bi-monthly', '2026-02', p)), [true, true, false]);
check('one-off: anchor month only', ['2026-05', '2026-06'].map((p) => occurs('One-off', '2026-05', p)), [true, false]);
check('nothing occurs before its anchor', occurs('Quarterly', '2026-07', '2026-04'), false);
check('paused templates never occur', Store.occursIn({ active: false, frequency: 'Monthly' }, '2026-07'), false);

console.log('\nbill normalization (edit path must not desync status/period):');
const nb = (bill: Partial<Bill>) => Store.normalizeBill(bill, '2026-07');
check('entering a paid date marks it paid', nb({ dueDate: '2026-07-05', paidDate: '2026-07-04', status: 'unpaid' }).status, 'paid');
check('clearing the paid date marks it unpaid', nb({ dueDate: '2026-07-05', paidDate: '', status: 'paid' }).status, 'unpaid');
check('moving the due date refiles the period', nb({ dueDate: '2026-09-05', paidDate: '', period: '2026-07' }).period, '2026-09');
check('a missing due date falls back to the given period', nb({ dueDate: '', paidDate: '' }).period, '2026-07');
check('a normalized paid bill is not overdue', Store.billIsOverdue(nb({ dueDate: '2020-01-01', paidDate: '2020-01-01' })), false);

console.log('\nrestore refuses non-backups (must not wipe data):');
const before = JSON.stringify(Store.state);
const rejects = (label: string, text: string): void => {
  let threw = false;
  try { Store.importJSON(text); } catch { threw = true; }
  check(label + ' rejected', threw, true);
  check(label + ' left data untouched', JSON.stringify(Store.state) === before, true);
};
rejects('an array', '[1,2,3]');
rejects('an empty object', '{}');
rejects("another app's export", '{"users":[],"settings":{"theme":"dark"}}');
rejects('a bare string', '"hello"');
rejects('null', 'null');
check('a real backup is accepted', Store.importJSON(before).income, Store.state.income.length);

console.log('\nmonthly equivalent:');
check('monthly 85.00 -> 85.00/mo', Store.monthlyEquivalent({ frequency: 'Monthly', expected: 8500 }), 8500);
check('quarterly 60.00 -> 20.00/mo', Store.monthlyEquivalent({ frequency: 'Quarterly', expected: 6000 }), 2000);
check('yearly 600.00 -> 50.00/mo', Store.monthlyEquivalent({ frequency: 'Yearly', expected: 60000 }), 5000);
check('half-yearly 300.00 -> 50.00/mo', Store.monthlyEquivalent({ frequency: 'Half-yearly', expected: 30000 }), 5000);
check('one-off counts as 0/mo', Store.monthlyEquivalent({ frequency: 'One-off', expected: 50000 }), 0);

/* ---------------- accounts carry every flow, not just movements ---------- */
console.log('\naccounts as real balances:');
const base = 100000 + 50000 + 60000 - 15000;
check('starting balance', Store.accountBalance(accId), base);

Store.upsert('income', { id: 'i9', date: '2026-07-05', source: 'Bonus', category: 'Bonus', amount: 100000, accountId: accId, method: 'Bank Transfer', notes: '' });
check('income raises the account it was paid into', Store.accountBalance(accId), base + 100000);

Store.upsert('purchases', { id: 'p9', date: '2026-07-06', item: 'Shoes', category: 'Clothing', amount: 20000, accountId: accId, method: 'Card', notes: '' });
check('a purchase lowers it', Store.accountBalance(accId), base + 100000 - 20000);

Store.upsert('bills', { id: 'b9', name: 'Gym', category: 'Subscriptions', period: '2026-07', dueDate: '2026-07-20', amount: 5000, accountId: accId, status: 'unpaid', paidDate: '' });
check('an unpaid bill is a commitment, not a withdrawal', Store.accountBalance(accId), base + 100000 - 20000);
Store.upsert('bills', { id: 'b9', status: 'paid', paidDate: '2026-07-20' });
check('paying it takes the money out', Store.accountBalance(accId), base + 100000 - 20000 - 5000);

Store.upsert('accounts', { id: 'acc_visa', name: 'Visa', type: 'Current Account', opening: 200000, target: 0, notes: '' });
Store.upsert('savingsTx', { id: 's9', date: '2026-07-25', direction: 'transfer', fromAccountId: 'acc_visa', accountId: 'acc_holiday', amount: 40000, notes: '' });
check('a transfer leaves the account it came from', Store.accountBalance('acc_visa'), 200000 - 40000);
check('and lands in the one it went to', Store.accountBalance('acc_holiday'), 25000 + 40000);
check('card to pot counts as saving', Store.summary('2026-07').savedIn, 60000 + 25000 + 40000);

Store.upsert('savingsTx', { id: 's10', date: '2026-07-26', direction: 'transfer', fromAccountId: accId, accountId: 'acc_holiday', amount: 10000, notes: '' });
check('pot to pot is not new saving', Store.summary('2026-07').savedIn, 60000 + 25000 + 40000);

/* ---------------- gold ---------------- */
console.log('\ngold:');
// One troy ounce is 31.1034768 g, so at $3110.34768/oz a gram is exactly $100;
// at 10 pounds to the dollar that is E£1000.00 a gram.
check('spot to price per gram', Store.goldGramFromSpot(3110.34768, 10), 100000);
Store.recordGoldPrice({ date: '2026-07-29', usdPerOz: 3110.34768, egpPerUsd: 10, source: 'test' });
check('one snapshot stored', Store.state.goldPrices.length, 1);
Store.recordGoldPrice({ date: '2026-07-29', usdPerOz: 3110.34768, egpPerUsd: 10, source: 'test' });
check('a second reading the same day replaces it', Store.state.goldPrices.length, 1);
check('the shop premium starts at 2%', Store.state.settings.goldPremium, 2);
check('which lifts the bourse price', Store.goldPricePerGram(24), 102000);

Store.state.settings.goldPremium = 0;
check('24k is the whole price', Store.goldPricePerGram(24), 100000);
check('21k is 21 parts of 24', Store.goldPricePerGram(21), 87500);
check('18k is three quarters', Store.goldPricePerGram(18), 75000);

Store.state.settings.goldPremium = 5;
check('a shop premium lifts every karat', Store.goldPricePerGram(21), 91875);
Store.state.settings.goldManualPrice = 200000;
check('your own price is used exactly as typed', Store.goldPricePerGram(24), 200000);
check('and still splits by karat', Store.goldPricePerGram(21), 175000);
Store.state.settings.goldManualPrice = 0;
Store.state.settings.goldPremium = 0;

Store.upsert('gold', { id: 'g1', date: '2026-07-10', direction: 'buy', karat: 21, grams: 10, amount: 800000, accountId: 'acc_visa', dealer: 'Souq', notes: '' });
Store.upsert('gold', { id: 'g2', date: '2026-07-20', direction: 'sell', karat: 21, grams: 2, amount: 180000, accountId: 'acc_visa', dealer: '', notes: '' });
check('grams held net off sales', Store.goldHoldings(), [{ karat: 21, grams: 8, value: 8 * 87500 }]);
check('pure gold equivalent', Math.round(Store.goldSummary().pure * 1000) / 1000, 7);
check('worth today', Store.goldValue(), 700000);
check('what it cost, net of the sale', Store.goldInvested(), 800000 - 180000);
check('gain', Store.goldSummary().gain, 700000 - 620000);
check('buying gold takes money out of the account that paid',
  Store.accountBalance('acc_visa'), 200000 - 40000 - 800000 + 180000);

/* ---------------- the date field's parser ---------------- */
console.log('\ndate parsing (the native picker is not used):');
const parse = (text: string) => DatePicker.parse(text, '2026-07-10');
check('day and month', parse('5/8'), '2026-08-05');
check('day month short year', parse('5-8-26'), '2026-08-05');
check('dots', parse('5.8.2026'), '2026-08-05');
check('iso straight through', parse('2026-08-05'), '2026-08-05');
check('no separators', parse('05082026'), '2026-08-05');
check('six digits', parse('050826'), '2026-08-05');
check('a bare day means the month on screen', parse('5'), '2026-07-05');
check('empty means empty', parse(''), '');
check('an impossible day is refused', parse('31/02/2026'), null);
check('so is nonsense', parse('hello'), null);
check('leap day is fine', parse('29/02/2028'), '2028-02-29');
check('and is not in a common year', parse('29/02/2026'), null);
check('display is dd/mm/yyyy', DatePicker.display('2026-08-05'), '05/08/2026');

// Roll back everything generated above so the export assertions below run
// against the seed set. The price history is deliberately kept: it proves the
// Gold sheet carries a series even when no gold is held.
Store.state.bills = Store.state.bills.filter((b) => ['b1', 'b2', 'b3', 'b4'].includes(b.id));
Store.state.income = Store.state.income.filter((r) => ['i1', 'i2', 'i3'].includes(r.id));
Store.state.purchases = Store.state.purchases.filter((r) => ['p1', 'p2'].includes(r.id));
Store.state.accounts = Store.state.accounts.filter((a) => [accId, 'acc_holiday'].includes(a.id));
Store.state.savingsTx = Store.state.savingsTx.filter((t) => ['s1', 's2', 's3', 's4'].includes(t.id));
Store.state.gold = [];

/* ---------------- build + parse ---------------- */
const bytes = build({ type: 'all' });
const file = join(outDir, filename({ type: 'all' }));
writeFileSync(file, bytes);
console.log(`\nwrote ${file} (${bytes.length} bytes)`);

const oracleDir = process.env.XLSX_ORACLE || join(here, '..');
const oraclePath = resolve(oracleDir, 'node_modules', 'xlsx', 'xlsx.mjs');
if (!existsSync(oraclePath)) {
  console.log('\nNo `xlsx` oracle found — skipping parser checks.');
  console.log('Run `npm run test:full` to install one and verify against a real parser.');
  process.exit(failures ? 1 : 0);
}
const XLSX = await import(pathToFileURL(oraclePath).href);
const wb = XLSX.read(readFileSync(file), { type: 'buffer', cellNF: true, cellStyles: true });
const grid = (name: string) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, blankrows: true });

console.log('\nworkbook:');
check('sheet names', wb.SheetNames, [
  'Summary', 'Income', 'Recurring Income', 'Bills', 'Recurring Bills', 'Purchases',
  'Utilities & Meters', 'Savings Accounts', 'Savings Transactions', 'Gold',
  'Monthly Breakdown', 'Category Breakdown'
]);

const inc = grid('Income');
check('income header', inc[0],
  ['Date', 'Source', 'Category', 'Amount', 'Method', 'Notes', 'Recurring', 'Paid Into']);
check('income sorted oldest first', inc[1][0], 46201); // 2026-06-28
// Rows are date-ascending: i1 (06-28), i3 (07-12), i2 (07-28).
check('income non-ascii source survives', inc[2][1], 'Café Ünïcode & Co');
check('a template-generated row is flagged', inc[3][6], 'Yes');
check('a hand-entered row is not', inc[1][6], undefined);

const recIn = grid('Recurring Income');
check('recurring income header', recIn[0].slice(0, 6),
  ['Source', 'Category', 'Frequency', 'Pay Day', 'Expected Amount', 'Income / Month']);
check('salary is 3200 a month', recIn[1][5], 3200);
check('quarterly rent spreads to 300 a month', recIn[2][5], 300);
check('active recurring income per month', recIn[4][5], 3500);
check('active recurring income per year', recIn[5][5], 42000);
check('income amount major units', inc[2][3], 450.5);
check('income notes keep XML metachars', inc[2][5], 'logo <design>');
check('income total formula', wb.Sheets['Income'].D6.f, 'SUM(D2:D4)');
check('income total cached value', wb.Sheets['Income'].D6.v, 3200 + 450.5 + 3200);

const bills = grid('Bills');
check('bills header has meter columns', bills[0].slice(6, 9), ['Units Used', 'Unit', 'Rate / Unit']);
check('unpaid bill shows OVERDUE once past due', bills[3][9], 'OVERDUE');
check('paid bill status', bills[1][9], 'Paid');
check('water unit label', bills[3][7], 'm³');

const util = grid('Utilities & Meters');
check('utilities lists only metered bills', util.length - 1, 3);
check('implied cost per unit cached', wb.Sheets['Utilities & Meters'].H3.v, 91.45 / 295);

const monthly = grid('Monthly Breakdown');
check('monthly rows', [monthly[1][0], monthly[2][0]], ['2026-06', '2026-07']);
check('july income', monthly[2][1], 3650.5);
check('july net formula', wb.Sheets['Monthly Breakdown'].F3.f, 'B3-E3');
check('july savings rate cached', Math.round(wb.Sheets['Monthly Breakdown'].J3.v * 10000) / 10000,
  Math.round((70000 / 365050) * 10000) / 10000);
// Every formula must ship a cached <v>, else the row reads as 0/blank before
// Excel recalculates.
// Layout: header(1), 2026-06(2), 2026-07(3), blank(4), Total(5), Average(6).
const mb = wb.Sheets['Monthly Breakdown'];
check('total row income cached (not 0)', mb.B5.v, (320000 + 320000 + 45050) / 100);
check('total row net saved cached', mb.I5.v, (50000 + 70000) / 100);
check('total row savings rate cached', Math.round(mb.J5.v * 10000) / 10000,
  Math.round((120000 / 685050) * 10000) / 10000);
check('average row cached', mb.B6.v, ((320000 + 320000 + 45050) / 2) / 100);
check('average row is a formula', mb.B6.f, 'AVERAGE(B2:B3)');
['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].forEach((col) => {
  [5, 6].forEach((row) => {
    const cell = mb[col + row];
    if (cell && cell.f && typeof cell.v !== 'number') {
      failures++;
      console.log(`  FAIL ${col}${row} formula has no cached value`);
    }
  });
});
console.log('  ok   every total-row formula carries a cached value');

const acc = grid('Savings Accounts');
check('emergency balance in sheet', acc[1][5], 1950);
check('progress percent format', (wb.Sheets['Savings Accounts'].H2.z || '').includes('%'), true);

const summary = grid('Summary');
check('summary title', summary[0][0], 'Income & Spending Report');
check('summary scope', summary[1][0], 'All time');
check('cross-sheet income formula', wb.Sheets.Summary.B6.f, 'SUM(Income!D2:D4)');
check('cross-sheet savings formula quotes the sheet name', wb.Sheets.Summary.B24.f, "SUM('Savings Accounts'!F2:F3)");
check('summary recurring income per month', wb.Sheets.Summary.B15.v, 3500);
check('summary recurring bills per month', wb.Sheets.Summary.B16.v, 85 + 20);
check('summary left over before purchases', wb.Sheets.Summary.B17.v, 3500 - 105);
check('summary net cached', wb.Sheets.Summary.B12.v, 6850.5 - 487.07);
check('summary outstanding cached', wb.Sheets.Summary.B9.v, 96.19);
check('currency format uses £', (wb.Sheets.Summary.B6.z || '').includes('£'), true);

/* month-scoped export */
const monthBytes = build({ type: 'month', period: '2026-07' });
const monthFile = join(outDir, filename({ type: 'month', period: '2026-07' }));
writeFileSync(monthFile, monthBytes);
const wb2 = XLSX.read(readFileSync(monthFile), { type: 'buffer', cellNF: true });
const inc2 = XLSX.utils.sheet_to_json(wb2.Sheets.Income, { header: 1, raw: true });
console.log('\nmonth scope:');
// Data rows carry a date serial in column A; the total row does not.
check('july export has 2 income rows', inc2.filter((r: unknown[], i: number) => i > 0 && typeof r[0] === 'number').length, 2);
check('july export excludes the june salary', inc2.some((r: unknown[]) => r[0] === 46201), false);
check('july scope label', XLSX.utils.sheet_to_json(wb2.Sheets.Summary, { header: 1, raw: true })[1][0], 'July 2026');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
