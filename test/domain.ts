/* Domain test: the pure layer on its own, with no workbook and no browser.

   These are the rules that used to be the caller's job to remember, or were not
   reachable from a test at all. Each one has cost real money-shaped bugs:
   a bill filed under the wrong month, a settings write nobody could observe,
   a state object edited in place that a signal would never notice.

   Run:  node test/domain.ts */

import { fourDigit, parse } from '../src/domain/date-parse.ts';
import { exportJSON, importJSON } from '../src/domain/backup.ts';
import { blankState, migrate, remove, updateSettings, upsert } from '../src/domain/records.ts';
import { catchUp, linkGeneratedTo } from '../src/domain/recurring.ts';
import { attachPersistence, app } from '../src/state/app.ts';
import { upsert as commitUpsert } from '../src/state/actions.ts';
import {
  accountBalance, accountsHeld, billCashDate, cashOnHand, debtOwed, debtSummaries,
  defaultSavingsAccount, lastAccountFor, summary, totalSavings
} from '../src/domain/selectors.ts';
import { borrow, owedAfter, payoffProgress, repay } from '../src/domain/debt.ts';
import { reconcile, reconciliation } from '../src/domain/reconcile.ts';
import {
  assumedSpending, forecast, goalForecasts, goalPurchase, goalQueue, HORIZON_MONTHS, moveGoal,
  saveGoal
} from '../src/domain/forecast.ts';
import type { AppState } from '../src/domain/types.ts';

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown): void => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  } else console.log(`  ok   ${label}`);
};

/* ---------------- the two-digit-year heuristic ---------------- */

/* Written against the current year rather than fixed dates, because the rule
   itself is relative: a two-digit year is this century unless that would put it
   more than twenty years in the future, in which case it is the last one. Hard
   numbers here would start failing on their own in 2047. */
console.log('two-digit years:');
const thisYear = new Date().getFullYear();
const twoDigit = (year: number): number => year % 100;

check('a year already past is this century', fourDigit(twoDigit(thisYear - 5)), thisYear - 5);
check('this year is this year', fourDigit(twoDigit(thisYear)), thisYear);
check('a few years ahead is this century', fourDigit(twoDigit(thisYear + 5)), thisYear + 5);
check('exactly twenty ahead is still this century', fourDigit(twoDigit(thisYear + 20)), thisYear + 20);
check('twenty-one ahead is read as the last century', fourDigit(twoDigit(thisYear + 21)), thisYear + 21 - 100);
check('a four-digit year is left alone', fourDigit(1987), 1987);

console.log('\ndate parsing, against the extracted module:');
const on = (text: string) => parse(text, '2026-07-10');
check('iso', on('2026-08-05'), '2026-08-05');
check('day month year, slashes', on('5/8/2026'), '2026-08-05');
check('day month year, dashes', on('5-8-2026'), '2026-08-05');
check('day month year, dots', on('5.8.2026'), '2026-08-05');
check('day month year, spaces', on('5 8 2026'), '2026-08-05');
check('day and month only, from the month on screen', on('5/8'), '2026-08-05');
check('eight digits', on('05082026'), '2026-08-05');
check('six digits', on('050826'), '2026-08-05');
check('a bare day', on('5'), '2026-07-05');
check('empty clears the field', on(''), '');
check('unreadable text is refused, not cleared', on('next tuesday'), null);
check('month 13 is refused', on('5/13/2026'), null);
check('a date with no context falls back to today', typeof parse('5'), 'string');

/* ---------------- bills derive their own period and status ---------------- */

console.log('\nbills normalise inside upsert:');
let state: AppState = blankState();

state = upsert(state, 'bills', {
  id: 'b1', name: 'Electricity', category: 'Electricity', dueDate: '2026-07-20', amount: 5000
}).state;
check('period comes from the due date', state.bills[0]?.period, '2026-07');
check('and an unpaid bill is unpaid', state.bills[0]?.status, 'unpaid');

// The bug this fixes: moving the due date used to leave the bill in the old
// month, so it vanished from both months' totals until something re-saved it.
state = upsert(state, 'bills', { id: 'b1', dueDate: '2026-09-03' }).state;
check('moving the due date moves the bill', state.bills[0]?.period, '2026-09');

state = upsert(state, 'bills', { id: 'b1', paidDate: '2026-09-01' }).state;
check('a paid date makes it paid', state.bills[0]?.status, 'paid');

state = upsert(state, 'bills', { id: 'b1', paidDate: '' }).state;
check('and clearing it makes it unpaid again', state.bills[0]?.status, 'unpaid');

// A status passed in by a caller is not trusted over the dates it contradicts.
state = upsert(state, 'bills', { id: 'b1', status: 'paid' }).state;
check('a status that disagrees with the dates loses', state.bills[0]?.status, 'unpaid');

const noDate = upsert(state, 'bills', { name: 'Guess', amount: 100 });
check('a bill with no due date lands in the current month',
  noDate.record.period, new Date().toISOString().slice(0, 7));

check('other collections are not normalised',
  Object.hasOwn(upsert(state, 'purchases', { item: 'x', amount: 1 }).record, 'status'), false);

/* ---------------- settings are written as a whole ---------------- */

console.log('\nsettings:');
const before = blankState();
const after = updateSettings(before, { currencySymbol: '£', goldPremium: 5 });
check('the named fields change', [after.settings.currencySymbol, after.settings.goldPremium], ['£', 5]);
check('the others are kept', after.settings.currencyCode, before.settings.currencyCode);
check('the original is untouched', before.settings.currencySymbol, 'E£');
check('the settings object is a new one', after.settings === before.settings, false);
check('and so is the state', after === before, false);

/* ---------------- writes are visible, i.e. they replace ---------------- */

/* A signal compares with ===. Anything that edits the state it was handed
   would notify nobody, and the screen would quietly disagree with the data —
   which is the entire failure mode this layer exists to make impossible. */
console.log('\nevery write returns a new state:');
const base = upsert(blankState(), 'accounts', {
  id: 'a1', name: 'Card', type: 'Current Account', opening: 0, target: 0, notes: ''
}).state;

const written = upsert(base, 'accounts', { id: 'a1', name: 'Renamed' });
check('the state object is replaced', written.state === base, false);
check('the collection array is replaced', written.state.accounts === base.accounts, false);
check('the record itself is replaced', written.state.accounts[0] === base.accounts[0], false);
check('the old state still reads the old value', base.accounts[0]?.name, 'Card');
check('collections that did not change are shared', written.state.income === base.income, true);

const withTemplate = upsert(base, 'billTemplates', {
  id: 't1', name: 'Rent', category: 'Rent', frequency: 'Monthly', expected: 100000,
  accountId: '', method: '', active: true, anchor: '2026-01', generatedThrough: '', notes: '',
  provider: '', dueDay: 1
}).state;

const swept = catchUp(withTemplate);
check('catchUp generates bills', swept.result.bills > 0, true);
check('and replaces the state', swept.state === withTemplate, false);
check('and the templates array', swept.state.billTemplates === withTemplate.billTemplates, false);
check('a second sweep changes nothing', catchUp(swept.state).state === swept.state, true);

const linked = linkGeneratedTo(swept.state, 'billTemplates', { id: 't1', accountId: 'a1' });
check('back-linking finds the generated bills', linked.linked > 0, true);
check('and replaces the bills array', linked.state.bills === swept.state.bills, false);
check('linking with nothing to link keeps the same state',
  linkGeneratedTo(linked.state, 'billTemplates', { id: 't1', accountId: 'a1' }).state === linked.state, true);

/* ---------------- one write per turn, not one per call ---------------- */

/* Every save rewrites the whole database. A run of writes inside one handler
   used to cost one rewrite each; they are coalesced into a microtask now. */
console.log('\nsaves are batched:');
let saves = 0;
attachPersistence({ save: () => { saves++; return true; } });

commitUpsert('accounts', { id: 'a1', name: 'Card', type: 'Current Account', opening: 0, target: 0, notes: '' });
commitUpsert('purchases', { id: 'p1', date: '2026-07-01', item: 'Tea', category: 'Groceries', amount: 500, accountId: 'a1', method: 'Cash', notes: '' });
commitUpsert('purchases', { id: 'p2', date: '2026-07-02', item: 'Bread', category: 'Groceries', amount: 300, accountId: 'a1', method: 'Cash', notes: '' });
check('nothing has been written yet, mid-turn', saves, 0);
check('but the state is already correct', app.peek().purchases.length, 2);

await Promise.resolve();
check('three writes cost one save', saves, 1);

commitUpsert('purchases', { id: 'p3', date: '2026-07-03', item: 'Milk', category: 'Groceries', amount: 200, accountId: 'a1', method: 'Cash', notes: '' });
await Promise.resolve();
check('a later turn saves again', saves, 2);

/* ---------------- goals are just another collection ---------------- */

/* Every persistence path is generic over COLLECTION_KEYS, so the whole of
   "adding a collection" is that the generic paths now see it. These check the
   generic paths really did pick it up rather than that a bespoke one works. */
console.log('\ngoals are a stored collection:');
check('a blank state has an empty goals list', blankState().goals, []);
check('the forecast settings have defaults',
  [blankState().settings.forecastSpendingAuto, blankState().settings.forecastSpending],
  [true, 0]);
check('a save written before goals existed still loads', migrate({ income: [] }).goals, []);

const noGoals = blankState();
const goalState = upsert(noGoals, 'goals', {
  name: 'RTX 5080', price: 4500000, priority: 1, boughtDate: '', notes: ''
}).state;
check('a new goal gets an id with the goals prefix',
  goalState.goals[0]?.id.startsWith('gol_'), true);
check('the state object is replaced rather than edited', goalState === noGoals, false);
check('and the state it was handed still has no goals', noGoals.goals.length, 0);

const restored = importJSON(exportJSON(goalState)).state;
check('goals survive a JSON backup and restore', restored.goals, goalState.goals);
check('price and priority come back as numbers',
  [typeof restored.goals[0]?.price, typeof restored.goals[0]?.priority],
  ['number', 'number']);

/* ---------------- balances as of a month ---------------- */

/* The fixture puts records deliberately on both sides of a 2026-07 cut-off.
   The far-future invariant below passes even when the date filter is wrong in
   every other case, so the hand-computed figure is the test that discriminates
   and the invariant is what pins the two readings together. */
console.log('\nbalances as of a month:');
let dated: AppState = upsert(blankState(), 'accounts', {
  id: 'a_d', name: 'Card', type: 'Current Account', opening: 100000, target: 0, notes: ''
}).state;
dated = upsert(dated, 'income', {
  id: 'i_now', date: '2026-07-05', source: 'Salary', category: 'Salary',
  amount: 50000, accountId: 'a_d', method: '', notes: ''
}).state;
dated = upsert(dated, 'income', {
  id: 'i_later', date: '2026-09-05', source: 'Salary', category: 'Salary',
  amount: 70000, accountId: 'a_d', method: '', notes: ''
}).state;
dated = upsert(dated, 'purchases', {
  id: 'p_now', date: '2026-07-09', item: 'Tea', category: 'Groceries',
  amount: 1000, accountId: 'a_d', method: '', notes: ''
}).state;
// Due in June, paid in August: cash left the account in August, not June.
dated = upsert(dated, 'bills', {
  id: 'b_late', name: 'Water', category: 'Water', provider: '', dueDate: '2026-06-10',
  amount: 3000, accountId: 'a_d', units: null, unitRate: null, paidDate: '2026-08-02',
  method: '', notes: ''
}).state;
// Paid, but with no paid date recorded. periodOf('') is '', which sorts before
// every real period — this must fall under its due date instead.
dated = upsert(dated, 'bills', {
  id: 'b_nodate', name: 'Internet', category: 'Internet', provider: '', dueDate: '2026-09-10',
  amount: 2000, accountId: 'a_d', units: null, unitRate: null, paidDate: '',
  method: '', notes: ''
}).state;
dated = { ...dated, bills: dated.bills.map((b) => (b.id === 'b_nodate' ? { ...b, status: 'paid' } : b)) };

// Second account with its own opening balance, to test multi-account summation.
dated = upsert(dated, 'accounts', {
  id: 'a_s', name: 'Savings', type: 'Savings', opening: 50000, target: 0, notes: ''
}).state;

// Transfer between accounts dated after the July cut-off: neither the total nor
// each account's balance at 2026-07 should change.
dated = upsert(dated, 'savingsTx', {
  id: 'tx_xfer', date: '2026-08-15', direction: 'transfer', amount: 10000,
  accountId: 'a_s', fromAccountId: 'a_d', notes: ''
}).state;

// Gold buy, also after the July cut-off. A buy is cash out, stored net, so a
// positive flows.gold means gold has cost the account.
dated = upsert(dated, 'gold', {
  id: 'g_buy', date: '2026-08-10', karat: 24, grams: 5, direction: 'buy',
  amount: 5000, accountId: 'a_d', pricePerGram: 1000, dealer: '', notes: ''
}).state;

check('the cash date of a bill paid late is the date it was paid',
  billCashDate({ dueDate: '2026-06-10', paidDate: '2026-08-02' }), '2026-08-02');
check('and a paid bill with no paid date falls under its due date',
  billCashDate({ dueDate: '2026-09-10', paidDate: '' }), '2026-09-10');

// 100,000 opening + 50,000 July income − 1,000 July purchase. The September
// income, the bill paid in August and the bill dated September are all after.
check('the balance as of July is hand-computable',
  accountBalance(dated, 'a_d', '2026-07'), 149000);
// Transfer and gold are both in August, so they're excluded at July cut-off.
// At September, they're included: 149k + 70k income - 3k bill - 10k transfer - 5k gold - 2k bill.
check('the September income is excluded until September',
  accountBalance(dated, 'a_d', '2026-09'), 149000 + 70000 - 3000 - 10000 - 5000 - 2000);
// August includes the bill payment and the transfer and gold, all of which take
// money out (transfer is -10k, gold is -5k).
check('a bill paid late counts in the month it was paid, not the month it was due',
  accountBalance(dated, 'a_d', '2026-08'), 149000 - 3000 - 10000 - 5000);

check('cash on hand adds every account together',
  cashOnHand(dated, '2026-07'), 149000 + 50000);
check('and a transfer moves money between accounts once the cut-off is past',
  accountBalance(dated, 'a_d', '2026-08'), 131000);
check('leaving the other account with the transfer in',
  accountBalance(dated, 'a_s', '2026-08'), 50000 + 10000);
check('but the total is unchanged by the transfer (it is internal)',
  cashOnHand(dated, '2026-08'), 131000 + 60000);
check('and far enough out it is exactly the undated total',
  cashOnHand(dated, '9999-12'), totalSavings(dated));
check('omitting the cut-off leaves the old behaviour alone',
  accountBalance(dated, 'a_d'), accountBalance(dated, 'a_d', '9999-12'));

// cashOnHand sums per account, so a row pointing at no account (or one since
// deleted) lands nowhere — untested until now.
const orphaned = upsert(dated, 'purchases', {
  id: 'p_orphan', date: '2026-07-12', item: 'Cash', category: 'Groceries',
  amount: 999999, accountId: 'nonexistent', method: '', notes: ''
}).state;
check('a record pointing at a deleted account contributes nothing to cashOnHand',
  cashOnHand(orphaned, '2026-07'), 149000 + 50000);

/* ---------------- the cash projection ---------------- */

/* The worked example from the spec, pinned to fixed periods so it never drifts
   with the real calendar: salary 18,000, four monthly bills totalling 5,700, a
   9,000 insurance premium every January, usual purchases 3,300. Accounts hold
   12,000 with 1,400 of bills unpaid, so the line starts at 10,600. */
console.log('\nthe cash projection:');
const FROM = '2026-07';

let world: AppState = upsert(blankState(), 'accounts', {
  id: 'a_f', name: 'Card', type: 'Current Account', opening: 1200000, target: 0, notes: ''
}).state;
world = upsert(world, 'incomeTemplates', {
  id: 'itp_pay', source: 'Acme', category: 'Salary', frequency: 'Monthly', payDay: 28,
  expected: 1800000, accountId: 'a_f', method: '', active: true, anchor: '2026-01',
  generatedThrough: '', notes: ''
}).state;
world = upsert(world, 'billTemplates', {
  id: 'tpl_fixed', name: 'Fixed bills', category: 'Rent', provider: '', frequency: 'Monthly',
  dueDay: 1, expected: 570000, accountId: 'a_f', method: '', active: true, anchor: '2026-01',
  generatedThrough: '', notes: ''
}).state;
world = upsert(world, 'billTemplates', {
  id: 'tpl_ins', name: 'Insurance', category: 'Insurance', provider: '', frequency: 'Yearly',
  dueDay: 15, expected: 900000, accountId: 'a_f', method: '', active: true, anchor: '2026-01',
  generatedThrough: '', notes: ''
}).state;
// Unpaid and dated in the starting month: a commitment the bank has not taken.
world = upsert(world, 'bills', {
  id: 'b_out', name: 'Mobile', category: 'Mobile', provider: '', dueDate: '2026-07-20',
  amount: 140000, accountId: 'a_f', units: null, unitRate: null, paidDate: '', method: '', notes: ''
}).state;

const line = forecast(world, { from: FROM, spending: 330000 });

check('the starting line subtracts unpaid bills dated in or before this month',
  [line.start, line.outstanding], [1060000, 140000]);
check('the projection never includes the starting month', line.months[0]?.period, '2026-08');
check('and runs to the horizon', line.months.length, HORIZON_MONTHS);

const at = (period: string) => line.months.find((m) => m.period === period);
check('a plain month is income less bills less spending',
  [at('2026-08')?.bills, at('2026-08')?.surplus, at('2026-08')?.balance],
  [570000, 900000, 1960000]);
check('the yearly premium lands in January and nowhere else',
  [at('2026-12')?.bills, at('2027-01')?.bills, at('2027-02')?.bills],
  [570000, 1470000, 570000]);
check('so January eats the whole surplus', at('2027-01')?.surplus, 0);
check('and November is where 45,000 is first covered',
  line.months.find((m) => m.balance >= 4500000)?.period, '2026-11');

/* A hand-entered future bill must not also be projected from its template, and
   one already paid must not be deducted a second time — cashOnHand has it. */
let entered = upsert(world, 'bills', {
  id: 'b_sep', templateId: 'tpl_fixed', name: 'Fixed bills', category: 'Rent', provider: '',
  dueDate: '2026-09-01', amount: 600000, accountId: 'a_f', units: null, unitRate: null,
  paidDate: '', method: '', notes: ''
}).state;
check('a hand-entered future bill replaces its template, it does not add to it',
  forecast(entered, { from: FROM, spending: 330000 }).months.find((m) => m.period === '2026-09')?.bills,
  600000);

entered = upsert(entered, 'bills', { id: 'b_sep', paidDate: '2026-07-15' }).state;
check('and one already paid is not deducted twice',
  forecast(entered, { from: FROM, spending: 330000 }).months.find((m) => m.period === '2026-09')?.bills,
  0);

/* The outflow-vanishes bug: a bill due before the start but paid later is
   covered neither by `outstanding` (it's paid) nor by cashOnHand at the
   starting line (the cash hasn't moved yet) — it must still land somewhere. */
const lateOutflowLine = forecast(
  upsert(world, 'bills', {
    id: 'b_late_paid', name: 'Repair', category: 'Other', provider: '', dueDate: '2026-05-15',
    amount: 80000, accountId: 'a_f', units: null, unitRate: null, paidDate: '2026-09-02',
    method: '', notes: ''
  }).state,
  { from: FROM, spending: 330000 }
);
check('a bill due before the start but paid later is not dropped from the projection',
  (lateOutflowLine.months.find((m) => m.period === '2026-09')?.bills ?? 0) > 0, true);
check('and lands in the month it was paid, on top of the regular bills',
  lateOutflowLine.months.find((m) => m.period === '2026-09')?.bills, 570000 + 80000);

const paidEarlyLine = forecast(
  upsert(world, 'bills', {
    id: 'b_paid_early', name: 'Repair', category: 'Other', provider: '', dueDate: '2026-10-15',
    amount: 45000, accountId: 'a_f', units: null, unitRate: null, paidDate: '2026-08-05',
    method: '', notes: ''
  }).state,
  { from: FROM, spending: 330000 }
);
check('a bill due after the start but paid earlier lands in the month it was paid',
  paidEarlyLine.months.find((m) => m.period === '2026-08')?.bills, 570000 + 45000);
check('not in the month it was due',
  paidEarlyLine.months.find((m) => m.period === '2026-10')?.bills, 570000);

const filled = upsert(world, 'income', {
  id: 'i_sep', templateId: 'itp_pay', date: '2026-09-28', source: 'Acme', category: 'Salary',
  amount: 1900000, accountId: 'a_f', method: '', notes: ''
}).state;
check('a hand-filled month is counted once, not twice',
  forecast(filled, { from: FROM, spending: 330000 }).months.find((m) => m.period === '2026-09')?.income,
  1900000);

/* ---------------- assumed spending ---------------- */

console.log('\nassumed spending:');
check('no purchases at all is 0, not NaN', assumedSpending(blankState(), FROM), 0);

let spent: AppState = blankState();
for (const [id, date, amount] of [
  ['s1', '2026-04-04', 300000],   // outside the three-month window
  ['s2', '2026-05-04', 600000],
  ['s3', '2026-06-04', 300000],
  ['s4', '2026-07-04', 999999]    // the current month, still running
] as const) {
  spent = upsert(spent, 'purchases', {
    id, date, item: 'Shop', category: 'Groceries', amount, accountId: '', method: '', notes: ''
  }).state;
}
// April, May and June: (300,000 + 600,000 + 300,000) / 3. July is ignored.
check('the last three complete months are averaged and the current one ignored',
  assumedSpending(spent, FROM), 400000);

let young: AppState = upsert(blankState(), 'purchases', {
  id: 's5', date: '2026-06-04', item: 'Shop', category: 'Groceries',
  amount: 300000, accountId: '', method: '', notes: ''
}).state;
check('a younger database divides by fewer months', assumedSpending(young, FROM), 300000);
young = upsert(young, 'purchases', {
  id: 's6', date: '2026-07-20', item: 'Shop', category: 'Groceries',
  amount: 900000, accountId: '', method: '', notes: ''
}).state;
check('and purchases only in the current month still average to 0',
  assumedSpending(upsert(blankState(), 'purchases', {
    id: 's7', date: '2026-07-20', item: 'Shop', category: 'Groceries',
    amount: 900000, accountId: '', method: '', notes: ''
  }).state, FROM), 0);
check('the younger figure is unchanged by a purchase in the current month',
  assumedSpending(young, FROM), 300000);

/* ---------------- goals, funded in order ---------------- */

/* Reuses the worked example: the line starts at 10,600 and gains 9,000 a month
   apart from the January insurance month. 45,000 lands in November; a second
   goal of 20,000 needs 65,000, which the January premium pushes out to March. */
console.log('\ngoals, funded in order:');
let planned = world;
for (const [id, name, price, priority] of [
  ['gol_a', 'RTX 5080', 4500000, 1],
  ['gol_b', 'New phone', 2000000, 2]
] as const) {
  planned = upsert(planned, 'goals', { id, name, price, priority, boughtDate: '', notes: '' }).state;
}

const plannedLine = forecast(planned, { from: FROM, spending: 330000 });
const [first, second] = goalForecasts(planned, plannedLine);

check('the first goal needs only its own price', [first?.reserved, first?.threshold], [0, 4500000]);
check('and lands in November', [first?.reachedIn, first?.monthsAway], ['2026-11', 4]);
check('the second reserves the first price on top of its own',
  [second?.reserved, second?.threshold], [4500000, 6500000]);
check('so the January premium pushes it to March', second?.reachedIn, '2027-03');
check('progress is measured against the goal\'s own price',
  [first?.saved, Math.round((first?.progress ?? 0) * 100)], [1060000, 24]);
check('and a goal with nothing yet saved reads 0', [second?.saved, second?.progress], [0, 0]);

const priced = upsert(planned, 'goals', {
  id: 'gol_none', name: 'Something', price: 0, priority: 0, boughtDate: '', notes: ''
}).state;
const withoutPrice = goalForecasts(priced, forecast(priced, { from: FROM, spending: 330000 }));
check('a goal with no price gets no date', [withoutPrice[0]?.reachedIn, withoutPrice[0]?.monthsAway], ['', null]);
check('and never blocks a goal behind it', withoutPrice[1]?.threshold, 4500000);

const broke = goalForecasts(planned, forecast(planned, { from: FROM, spending: 3300000 }));
check('a negative surplus yields no date, not a date far away',
  [broke[0]?.reachedIn, broke[0]?.monthsAway], ['', null]);

const cheap = upsert(planned, 'goals', {
  id: 'gol_now', name: 'A cable', price: 100000, priority: -1, boughtDate: '', notes: ''
}).state;
const affordable = goalForecasts(cheap, forecast(cheap, { from: FROM, spending: 330000 }));
check('a goal you can already afford is 0 months away',
  [affordable[0]?.reachedIn, affordable[0]?.monthsAway], [FROM, 0]);

const bought = upsert(planned, 'goals', { id: 'gol_a', boughtDate: '2026-11-04' }).state;
check('a bought goal drops out of the funding queue',
  goalQueue(bought).map((g) => g.id), ['gol_b']);
// readAll() returns SQL NULL as null, so the test has to be falsy, not === ''.
const nulled = { ...planned, goals: planned.goals.map((g) => ({ ...g, boughtDate: null as unknown as '' })) };
check('and a null bought date read back off SQLite still counts as unbought',
  goalQueue(nulled).length, 2);

/* ---------------- buying one ---------------- */

/* The bug this covers: "Bought" stamped a date on the goal and stopped there,
   so the thing was ticked off the list while every account still read the same
   figure it had a moment before. Buying has to move money. */
console.log('\nbuying a goal:');

const paidFor = saveGoal(cheap, { id: 'gol_now', boughtDate: '2026-07-20' }, { accountId: 'a_f' });
const cablePurchase = goalPurchase(paidFor, 'gol_now');
check('buying records a purchase against the goal',
  [cablePurchase?.item, cablePurchase?.amount, cablePurchase?.accountId],
  ['A cable', 100000, 'a_f']);
check('and the money has actually left the accounts',
  [cashOnHand(cheap, '2026-07'), cashOnHand(paidFor, '2026-07')], [1200000, 1100000]);
check('so the projection starts from the smaller figure',
  forecast(paidFor, { from: FROM, spending: 330000 }).start, 1100000 - 140000);
check('and the goal is off the queue', goalQueue(paidFor).map((g) => g.id), ['gol_a', 'gol_b']);

check('saving a bought goal again corrects the purchase rather than paying twice',
  saveGoal(paidFor, { id: 'gol_now', price: 120000 }).purchases.length, 1);
check('and the corrected amount is what leaves the account',
  cashOnHand(saveGoal(paidFor, { id: 'gol_now', price: 120000 }), '2026-07'), 1080000);

const unbought = saveGoal(paidFor, { id: 'gol_now', boughtDate: '' });
check('clearing the date takes the purchase back out again',
  [unbought.purchases.length, cashOnHand(unbought, '2026-07')], [0, 1200000]);
check('and the goal rejoins the queue', goalQueue(unbought)[0]?.id, 'gol_now');

/* Deleting the wishlist entry is tidying a list, not a refund. */
const deleted = remove(paidFor, 'goals', 'gol_now');
check('deleting a bought goal leaves its purchase, orphaned',
  [deleted.purchases.length, deleted.purchases[0]?.goalId], [1, null]);
check('so the money it took out stays out', cashOnHand(deleted, '2026-07'), 1100000);

/* The Purchases tab writes this table through the generic upsert, and its field
   list has no goalId — so the link survives only because upsert merges the
   draft over the existing row. Pinned, because a field list that ever named
   goalId would quietly turn a bought goal back into a habit. */
const editedElsewhere = upsert(paidFor, 'purchases', {
  id: cablePurchase?.id, date: '2026-07-20', item: 'A cable', category: 'Goal',
  amount: 100000, accountId: 'a_f', method: 'Cash', notes: 'corner shop'
}).state;
check('editing a goal purchase on the Purchases tab leaves it tied to its goal',
  [goalPurchase(editedElsewhere, 'gol_now')?.method, editedElsewhere.purchases.length],
  ['Cash', 1]);
check('and it is still kept out of what you usually spend',
  assumedSpending(editedElsewhere, '2026-09'), 0);

/* An account chosen as "not linked" is an answer, and a second save must not
   quietly replace it with the default. */
const unlinked = saveGoal(cheap, { id: 'gol_now', boughtDate: '2026-07-20' }, { accountId: '' });
check('an unlinked purchase stays unlinked when the goal is saved again',
  goalPurchase(saveGoal(unlinked, { id: 'gol_now', price: 110000 }), 'gol_now')?.accountId, '');
check('while a first buy with nothing chosen falls back to the usual account',
  goalPurchase(saveGoal(cheap, { id: 'gol_now', boughtDate: '2026-07-20' }), 'gol_now')?.accountId,
  'a_f');

/* Averaging a goal into "what you usually spend" would raise the assumed figure
   by a third of its price for three months and push every goal behind it out. */
const habitual = upsert(blankState(), 'purchases', {
  id: 's_shop', date: '2026-06-04', item: 'Shop', category: 'Groceries',
  amount: 300000, accountId: '', method: '', notes: ''
}).state;
const splurged = saveGoal(
  upsert(habitual, 'goals', {
    id: 'gol_big', name: 'RTX 5080', price: 4500000, priority: 1, boughtDate: '', notes: ''
  }).state,
  { id: 'gol_big', boughtDate: '2026-06-11' }
);
check('a goal bought last month does not become part of what you usually spend',
  [assumedSpending(habitual, FROM), assumedSpending(splurged, FROM)], [300000, 300000]);
// On top of June's 300,000 of groceries — kept out of the average, counted here.
check('but it is still counted in a month the projection covers',
  forecast(splurged, { from: '2026-05', spending: 0 }).months
    .find((m) => m.period === '2026-06')?.spending,
  4500000 + 300000);
check('and a database holding nothing but a goal purchase averages to 0, not to it',
  assumedSpending(saveGoal(
    upsert(blankState(), 'goals', {
      id: 'gol_only', name: 'Phone', price: 2000000, priority: 1, boughtDate: '', notes: ''
    }).state,
    { id: 'gol_only', boughtDate: '2026-06-11' }
  ), FROM), 0);

/* ---------------- reordering the queue ---------------- */

console.log('\nreordering the funding queue:');
const moved = moveGoal(planned, 'gol_b', -1);
check('moving up swaps the pair in one new state', goalQueue(moved).map((g) => g.id), ['gol_b', 'gol_a']);
check('the state object is replaced', moved === planned, false);
check('and the original is untouched', goalQueue(planned).map((g) => g.id), ['gol_a', 'gol_b']);
check('moving down returns it', goalQueue(moveGoal(moved, 'gol_b', 1)).map((g) => g.id), ['gol_a', 'gol_b']);
// Identity, not deep equality: a no-op must hand back the very same object, or
// the signal redraws and the database is rewritten for nothing.
check('moving up from the top is a no-op', moveGoal(planned, 'gol_a', -1) === planned, true);
check('moving down from the bottom is a no-op', moveGoal(planned, 'gol_b', 1) === planned, true);
check('moving a goal that is not in the queue is a no-op',
  moveGoal(planned, 'nope', 1) === planned, true);
check('a delta of zero is a no-op too', moveGoal(planned, 'gol_a', 0) === planned, true);

/* ---------------- money you owe ---------------- */

/* The invariant the whole design rests on: borrowing changes what is in your
   accounts and leaves what you are worth exactly where it was. Everything the
   feature promises — that a goal is not funded out of a loan, that the
   projection does not offer you the lender's money — is that one line holding.
   Held as an account with a negative balance, it holds by arithmetic rather
   than by a rule someone has to remember to apply in five places. */
console.log('\nmoney you owe:');

let owing: AppState = upsert(blankState(), 'accounts', {
  id: 'a_card', name: 'Card', type: 'Current Account', opening: 1000000, target: 0, notes: ''
}).state;
owing = upsert(owing, 'accounts', {
  id: 'a_pot', name: 'Rainy day', type: 'Savings', opening: 0, target: 0, notes: ''
}).state;

const borrowed = borrow(owing, {
  name: 'Brother-in-law', amount: 300000, date: '2026-07-05', intoAccountId: 'a_card'
});
const debt = () => debtSummaries(borrowed)[0]!;

check('borrowing puts the money in the account it landed in',
  accountBalance(borrowed, 'a_card'), 1300000);
check('and records the same sum as owed',
  [debt().borrowed, debt().repaid, debt().owed, debt().settled], [300000, 0, 300000, false]);
check('so what you hold went up but what you are worth did not',
  [accountsHeld(borrowed), totalSavings(borrowed)], [1300000, 1000000]);
check('the debt is named after whoever lent it',
  debt().account.name, 'Brother-in-law');
check('and it is one account and one movement, not a table of its own',
  [borrowed.accounts.length, borrowed.savingsTx.length], [3, 1]);

/* The projection is the thing people act on, so this is the check that matters
   most: a loan sitting in the current account must not read as money to spend. */
check('the projection starts from what is yours, not from what is in the bank',
  forecast(borrowed, { from: '2026-07', spending: 0 }).start,
  forecast(owing, { from: '2026-07', spending: 0 }).start);

check('what is owed is dated, so it is not owed before it was borrowed',
  [debtOwed(borrowed, '2026-06'), debtOwed(borrowed, '2026-07')], [0, 300000]);

/* Borrowing into a pot is the case that would otherwise report a month where
   you saved three hundred thousand pounds of someone else's money. */
const intoPot = borrow(owing, {
  name: 'Brother-in-law', amount: 300000, date: '2026-07-05', intoAccountId: 'a_pot'
});
check('borrowing into a savings pot is not saving',
  [summary(intoPot, '2026-07').savedIn, summary(intoPot, '2026-07').savingsRate], [0, 0]);

/* Paying back. */
const partly = repay(borrowed, debt().account.id, {
  amount: 100000, date: '2026-08-03', fromAccountId: 'a_card'
});
const partial = debtSummaries(partly)[0]!;
check('repaying takes the cash out and the debt down together',
  [accountBalance(partly, 'a_card'), partial.owed], [1200000, 200000]);
check('and still leaves what you are worth where it started',
  totalSavings(partly), 1000000);
check('the card reads how much of it is behind you',
  [partial.borrowed, partial.repaid, Math.round(payoffProgress(partial) * 100)],
  [300000, 100000, 33]);
check('paying it back is not spending your savings either',
  summary(partly, '2026-08').savedOut, 0);

const settled = repay(partly, partial.account.id, {
  amount: 200000, date: '2026-09-01', fromAccountId: 'a_card'
});
check('paying the rest settles it',
  [debtSummaries(settled)[0]!.owed, debtSummaries(settled)[0]!.settled], [0, true]);
check('and every figure is back exactly where it began',
  [accountsHeld(settled), totalSavings(settled), debtOwed(settled)], [1000000, 1000000, 0]);

check('overpaying settles the debt rather than lending to them',
  owedAfter(partial, 500000), 0);

/* Borrowing again from the same person deepens the one debt rather than
   opening a second — which is only true because the sum is read back off the
   movements instead of written down once when the account was opened. */
const again = borrow(borrowed, {
  debtId: debt().account.id, name: 'ignored', amount: 50000,
  date: '2026-08-01', intoAccountId: 'a_card'
});
check('borrowing again adds to the same debt',
  [again.accounts.length, debtSummaries(again)[0]!.borrowed, debtSummaries(again)[0]!.owed],
  [3, 350000, 350000]);

check('repaying something that is not a debt is a no-op',
  repay(borrowed, 'a_card', { amount: 1, date: '2026-08-01', fromAccountId: 'a_pot' }) === borrowed,
  true);

/* A debt must never be what a blank form proposes, or an ordinary purchase
   would quietly land on the loan and deepen it. */
check('a debt is never the account a form defaults to',
  [lastAccountFor(borrowed, 'purchases'), defaultSavingsAccount(borrowed)], ['a_card', 'a_pot']);

/* ---------------- making an account agree with the real one ---------------- */

/* The problem: months of small card taps nobody enters, and a balance that has
   drifted away from the bank's with no entry available to close the gap. */
console.log('\nreconciling an account:');

const drifted = reconcile(owing, 'a_card', 940000, '2026-07-31');
check('a shortfall is recorded as spending that was never entered',
  [drifted.purchases.length, drifted.purchases[0]?.category, drifted.purchases[0]?.amount],
  [1, 'Adjustment', 60000]);
check('and the account now says what the bank says',
  accountBalance(drifted, 'a_card'), 940000);
check('reconciling the same figure again writes nothing',
  reconcile(drifted, 'a_card', 940000, '2026-08-01') === drifted, true);

const over = reconcile(owing, 'a_card', 1050000, '2026-07-31');
check('money over is recorded as income that arrived and was never entered',
  [over.income.length, over.income[0]?.category, over.income[0]?.amount],
  [1, 'Adjustment', 50000]);
check('and that account agrees too', accountBalance(over, 'a_card'), 1050000);

check('an account already telling the truth is left exactly as it was',
  reconcile(owing, 'a_card', 1000000, '2026-07-31') === owing, true);
check('the difference can be read before anything is written',
  reconciliation(owing, 'a_card', 940000).difference, -60000);

/* The mirror of the goal exclusion: a goal is kept out of the average because
   it does not repeat, and drift is put in because it does. If the app keeps
   finding you six hundred short, six hundred is part of what you spend. */
const drifting = reconcile(owing, 'a_card', 940000, '2026-06-20');
check('a correction counts towards what you usually spend',
  assumedSpending(drifting, '2026-07'), 60000);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
