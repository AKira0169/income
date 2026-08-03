/* domain/debt.ts — money you borrowed, and paying it back.

   A debt is an account with a negative balance, not a table of its own. That is
   the whole design, and everything else follows from it: borrowing is a
   transfer out of the lender's account into yours, repaying is the same
   transfer the other way, and the balance reaches zero exactly when you are
   square. Because every total in the app is already summed per account, the
   debt takes itself off your worth and out of the projection with no rule
   written anywhere to say so — which is the part a separate table would have
   had to reproduce in `cashOnHand`, in `forecast`, in the goal queue and in the
   workbook, and would eventually have got wrong in one of them.

   What this file adds on top is the two doors: recording a debt in one step
   instead of asking you to invent a negative account and move money out of it,
   and paying one down without having to remember which way round the transfer
   goes. Both are pure — state in, state out — like the rest of domain/.

   Two entries per debt, not one. The account is the obligation and outlives
   every payment; the movement is the day the cash actually moved. Collapsing
   them into one dated row would mean either a debt with no date or a payment
   with no balance. It also means borrowing again from the same person is just
   another movement against the same account, and `debtSummary` adds it up
   without being told. */

import { DEBT_TYPE } from './catalog.ts';
import { upsert } from './records.ts';
import { isDebtAccount } from './selectors.ts';
import type { AppState, Cents, DebtSummary, Id, IsoDate } from './types.ts';

/** Taking money from someone. */
export interface Borrowing {
  /** Who you owe — the account's name. Ignored when `debtId` names one. */
  name: string;
  amount: Cents;
  date: IsoDate;
  /* Required, for the reason buying a goal requires one: every balance in the
     app is summed per account, so money borrowed into no account would move
     nothing, and the debt would show against a card whose figure never rose. */
  /** The account the money landed in. */
  intoAccountId: Id;
  notes?: string;
  /** Set to add to a debt already open rather than start a second one. */
  debtId?: Id;
}

/** Paying some of it back. */
export interface Repayment {
  amount: Cents;
  date: IsoDate;
  /** The account the money came out of. */
  fromAccountId: Id;
  notes?: string;
}

/* Opens the debt if it is new, then moves the money.

   The account is written first so the transfer has something to name. Both go
   through the ordinary upsert, so a debt is an account you can rename, edit and
   delete like any other — and deleting it already takes its movements with it.

   Nothing here records the original sum anywhere: `debtSummary` reads it back
   off the movements, so borrowing a second time from the same person deepens
   the debt correctly instead of overwriting a figure written down once. */
export function borrow(state: AppState, taken: Borrowing): AppState {
  const existing = taken.debtId
    ? state.accounts.find((a) => a.id === taken.debtId && isDebtAccount(a))
    : null;

  /* Notes are only written on a new debt. Sending `notes: ''` on the second
     borrowing would blank what the first one said, because upsert merges the
     draft over the record and cannot tell "left out" from "cleared". */
  const opened = upsert(state, 'accounts', existing
    ? { id: existing.id }
    /* Every column written, none left undefined: the debt is an ordinary
       account row and has to survive the same round-trip through SQLite as one
       typed into the account form. `opening` stays 0 — what is owed is the
       movements, so a figure here as well would be counted twice. */
    : {
      name: taken.name, type: DEBT_TYPE, opening: 0, target: 0,
      notes: taken.notes ?? ''
    });

  return upsert(opened.state, 'savingsTx', {
    date: taken.date,
    direction: 'transfer',
    fromAccountId: opened.record.id,
    accountId: taken.intoAccountId,
    amount: taken.amount || 0,
    notes: taken.notes || `Borrowed from ${opened.record.name}`
  }).state;
}

/* Paying it back is the same movement in reverse: out of your account and into
   the debt, which brings its negative balance up towards zero. */
export function repay(state: AppState, debtId: Id, paid: Repayment): AppState {
  const account = state.accounts.find((a) => a.id === debtId);
  if (!account || !isDebtAccount(account)) return state;

  return upsert(state, 'savingsTx', {
    date: paid.date,
    direction: 'transfer',
    fromAccountId: paid.fromAccountId,
    accountId: debtId,
    amount: paid.amount || 0,
    notes: paid.notes || `Repaid ${account.name}`
  }).state;
}

/** What paying `amount` off would leave outstanding. Floored at zero: overpaying
    settles a debt, it does not turn the lender into your borrower. */
export function owedAfter(debt: DebtSummary, amount: Cents): Cents {
  return Math.max(0, debt.owed - (amount || 0));
}

/** How much of it is behind you, 0..1. A debt you have not paid into is 0, and
    one borrowed and never drawn is 1 rather than a division by zero. */
export function payoffProgress(debt: DebtSummary): number {
  if (debt.borrowed <= 0) return 1;
  return Math.min(1, Math.max(0, debt.repaid / debt.borrowed));
}
