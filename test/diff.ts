/* Diff test: a write reaches the database and the screen as a diff, so the
   diff has to be exactly the change — nothing missing, nothing spurious — and
   applying it to the old state has to give the new one.

   Run:  node test/diff.ts */

import { borrow } from '../src/domain/debt.ts';
import { currentPeriod, shiftPeriod } from '../src/domain/period.ts';
import { blankState, remove, updateSettings, upsert } from '../src/domain/records.ts';
import { catchUp } from '../src/domain/recurring.ts';
import type { AppState } from '../src/domain/types.ts';
import { applyChanges } from '../src/wire.ts';
import { diffState, isEmptyDiff, sameJson } from '../server/diff.ts';
import { normalizeState } from '../server/schema.ts';
import { check, finish, title } from './support/check.ts';

/** The round trip every write makes: diff on the server, apply on the client. */
const replay = (before: AppState, after: AppState): AppState => applyChanges(before, diffState(before, after));
const same = (a: AppState, b: AppState): boolean => sameJson(normalizeState(a), normalizeState(b));

let s: AppState = blankState();
s = upsert(s, 'accounts', { id: 'a1', name: 'Card', type: 'Current Account', opening: 1000, target: 0, notes: '' }).state;
s = upsert(s, 'accounts', { id: 'a2', name: 'Pot', type: 'Savings', opening: 0, target: 0, notes: '' }).state;
s = upsert(s, 'savingsTx', { id: 't1', date: '2026-07-01', accountId: 'a2', fromAccountId: 'a1', direction: 'transfer', amount: 100, notes: '' }).state;

title('nothing changed');
check('the same state diffs to nothing', isEmptyDiff(diffState(s, s)), true);
const rewritten = upsert(s, 'accounts', { id: 'a1', name: 'Card' }).state;
check('rewriting a record with its own values is no change', isEmptyDiff(diffState(s, rewritten)), true);

title('one insert');
const added = upsert(s, 'purchases', { id: 'p1', date: '2026-07-02', item: 'Tea', amount: 250, accountId: 'a1' }).state;
const d1 = diffState(s, added);
check('only purchases changed', Object.keys(d1.changes), ['purchases']);
check('one upsert, no deletes', [d1.changes.purchases?.upserts.length, d1.changes.purchases?.deletes], [1, []]);
check('missing fields travel as null', d1.changes.purchases?.upserts[0]?.['notes'], null);
check('replaying gives the new state', same(replay(s, added), added), true);

title('a cascade');
const gone = remove(s, 'accounts', 'a2');
const d2 = diffState(s, gone);
check('the account and its movement are both deleted',
  [d2.changes.accounts?.deletes, d2.changes.savingsTx?.deletes], [['a2'], ['t1']]);
check('replaying gives the new state', same(replay(s, gone), gone), true);

title('composite writes');
const borrowed = borrow(s, { name: 'Bank', amount: 5000, date: '2026-07-03', intoAccountId: 'a1' });
const d3 = diffState(s, borrowed);
check('borrowing writes an account and a movement',
  [d3.changes.accounts?.upserts.length, d3.changes.savingsTx?.upserts.length], [1, 1]);
check('replaying gives the new state', same(replay(s, borrowed), borrowed), true);

const anchor = shiftPeriod(currentPeriod(), -2);
const withTemplate = upsert(s, 'billTemplates', {
  id: 'bt1', name: 'Rent', category: 'Rent', provider: '', frequency: 'Monthly', dueDay: 5,
  expected: 900, accountId: 'a1', method: '', active: true, anchor, generatedThrough: '', notes: ''
}).state;
const swept = catchUp(withTemplate).state;
const d4 = diffState(withTemplate, swept);
check('catch-up writes three bills and moves the template mark',
  [d4.changes.bills?.upserts.length, d4.changes.billTemplates?.upserts.length], [3, 1]);
check('replaying gives the new state', same(replay(withTemplate, swept), swept), true);

title('settings');
const patched = updateSettings(s, { savingsGoalRate: 30 });
const d5 = diffState(s, patched);
check('a settings change is carried whole', d5.settings?.savingsGoalRate, 30);
check('and no collection changed', Object.keys(d5.changes), []);
const reordered = { ...s, settings: Object.fromEntries(Object.entries(s.settings).reverse()) } as AppState;
check('key order alone is not a change', diffState(s, reordered).settings, null);

title('gold prices are not a user collection');
const priced: AppState = { ...s, goldPrices: [{ id: 'gpr_2026-07-01', date: '2026-07-01', usdPerOz: 1, egpPerUsd: 1, egpPerGram24: 1, source: '', fetchedAt: '' }] };
check('they never appear in a diff', isEmptyDiff(diffState(s, priced)), true);

title('a malformed import with a repeated id');
const twice = { ...s, purchases: [
  { id: 'p9', goalId: null, date: '2026-07-01', item: 'A', category: '', amount: 1, accountId: '', method: '', notes: '' },
  { id: 'p9', goalId: null, date: '2026-07-01', item: 'B', category: '', amount: 2, accountId: '', method: '', notes: '' }
] } as AppState;
check('is written once, last copy wins',
  diffState(s, twice).changes.purchases?.upserts.map((r) => r['item']), ['B']);

finish();
