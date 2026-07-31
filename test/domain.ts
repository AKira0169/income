/* Domain test: the pure layer on its own, with no workbook and no browser.

   These are the rules that used to be the caller's job to remember, or were not
   reachable from a test at all. Each one has cost real money-shaped bugs:
   a bill filed under the wrong month, a settings write nobody could observe,
   a state object edited in place that a signal would never notice.

   Run:  node test/domain.ts */

import { fourDigit, parse } from '../src/domain/date-parse.ts';
import { exportJSON, importJSON } from '../src/domain/backup.ts';
import { blankState, migrate, updateSettings, upsert } from '../src/domain/records.ts';
import { catchUp, linkGeneratedTo } from '../src/domain/recurring.ts';
import { attachPersistence, app } from '../src/state/app.ts';
import { upsert as commitUpsert } from '../src/state/actions.ts';
import { accountBalance, billCashDate, cashOnHand, totalSavings } from '../src/domain/selectors.ts';
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

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
