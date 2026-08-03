/* domain/reconcile.ts — making an account agree with the real one.

   Every balance in this app is arithmetic over what you entered. Real life is
   not: a coffee, a tip, a top-up, twenty small card taps nobody would sit down
   and type in. After a few months the two numbers have drifted apart, and there
   is no entry you can make to close the gap — which is the point at which
   people stop trusting the app and stop using it.

   Reconciling is that entry. You read the balance off the bank, the app works
   out the difference, and writes the one row that makes its own figure true.

   It is a real record, not a fudge factor stored on the account. The money did
   move, so it moves a balance the same way everything else does, appears in its
   month's history, sits in a category you can total, and can be edited or
   deleted if you later find the receipt it stood in for. An account carrying a
   hidden correction would have been a second kind of number, and the one thing
   this app promises is that a balance is arithmetic you can check.

   Which table it lands in follows the direction, because the two directions are
   different events. Money missing is spending that was never entered, so it is
   a purchase — and it is deliberately an ordinary one, which means
   `assumedSpending` averages it in. That is the honest reading: if the app
   consistently finds you a few hundred short, a few hundred a month is what you
   actually spend, and a forecast built on the typed-in figure alone would keep
   promising money that never arrives. It is the mirror of the goal exclusion in
   forecast.ts — a goal is left out because it does not repeat, and drift is put
   in because it does.

   Money over is the rarer case and the opposite one: something arrived that was
   never recorded, so it is income. */

import { ADJUSTMENT_CATEGORY, ADJUSTMENT_LABEL } from './catalog.ts';
import { upsert } from './records.ts';
import { accountBalance } from './selectors.ts';
import type { AppState, Cents, Id, IsoDate, Reconciliation } from './types.ts';

/* What reconciling would do, worked out before anything is written, so the
   dialog can show the difference while it is still being typed and say the same
   number afterwards that it promised beforehand.

   `tracked` is the whole balance rather than the balance as of the date, so it
   is the very figure printed on the account card. Reconciling is answering "make
   this card match my bank", and measuring against a different cut-off would
   close the gap the user can see by an amount they cannot. */
export function reconciliation(state: AppState, accountId: Id, actual: Cents): Reconciliation {
  const tracked = accountBalance(state, accountId);
  return { accountId, tracked, actual, difference: actual - tracked };
}

/* Writes the correcting row. An account already telling the truth is left
   alone — returning the same state object, which is what the commit layer reads
   as "nothing to save" — rather than filing a purchase of nothing.

   The row is dated, so the correction lands in the month you noticed rather
   than smearing over the months it came from. That is the only honest choice
   available: the drift has no date of its own, because the entries it stands
   for were never made. */
export function reconcile(
  state: AppState, accountId: Id, actual: Cents, date: IsoDate
): AppState {
  const { difference } = reconciliation(state, accountId, actual);
  if (!difference) return state;

  if (difference < 0) {
    return upsert(state, 'purchases', {
      goalId: null,
      date,
      item: ADJUSTMENT_LABEL,
      category: ADJUSTMENT_CATEGORY,
      amount: -difference,
      accountId,
      method: 'Other',
      notes: 'Spending that was never entered, found by reconciling'
    }).state;
  }

  return upsert(state, 'income', {
    templateId: null,
    date,
    source: ADJUSTMENT_LABEL,
    category: ADJUSTMENT_CATEGORY,
    amount: difference,
    accountId,
    method: 'Other',
    notes: 'Money that arrived and was never entered, found by reconciling'
  }).state;
}
