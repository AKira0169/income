/* ui/tabs/Accounts.tsx — every place money sits, what you owe against it, and
   what moved either.

   A balance is arithmetic you can check, so each card shows the flows it is
   made of rather than just the total. Debts get their own cards for the same
   reason, read the only way a debt makes sense — how deep it went, how much is
   behind you, what is left — rather than as an account with a minus sign. */

import { useState } from 'preact/hooks';
import { owedAfter, payoffProgress } from '../../domain/debt.ts';
import { formatMoney, parseMoney, plural } from '../../domain/money.ts';
import { periodLabel, todayISO } from '../../domain/period.ts';
import { sortByDateDesc } from '../../domain/records.ts';
import { reconciliation } from '../../domain/reconcile.ts';
import {
  accountBalance, accountFlows, accountName, debtOwed, debtSummaries, heldAccounts,
  isSavingsAccount, accountsHeld, savingsBalance, savingsTxIn, totalSavings
} from '../../domain/selectors.ts';
import { goldSummary } from '../../domain/gold.ts';
import { borrow, reconcile, remove, repay, upsert } from '../../state/actions.ts';
import { app } from '../../state/app.ts';
import { period as routePeriod } from '../../state/route.ts';
import type { Account, AppState, Cents, DebtSummary, SavingsTx } from '../../domain/types.ts';
import { Editor } from '../components/Dialog.tsx';
import { Figure, FlowLine, TargetProgress } from '../components/Figure.tsx';
import { ScopeToggle } from '../components/ScopeToggle.tsx';
import { AddSection, Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { EmptyRow, listRows, RowActions, Table } from '../components/Table.tsx';
import { toast } from '../components/Toast.tsx';
import { confirmDelete, followDate } from '../feedback.ts';
import { FIELDS, savingsFields } from '../fields.ts';
import type { FieldSpec } from '../fields.ts';
import type { FormData } from '../components/Form.tsx';

const COLUMNS = 6;

const HEADERS = [
  { label: 'Date' }, { label: 'Account' }, { label: 'Movement' }, { label: 'Amount', num: true },
  { label: 'Notes' }, { label: '', actions: true }
];

const BLANK_ACCOUNT = { name: '', type: 'Current Account', opening: 0, target: 0, notes: '' };

/** Opening a new debt, or borrowing more from someone you already owe. */
type BorrowTarget = 'new' | DebtSummary;

/* "From" only means anything for a transfer, so it is not on screen otherwise —
   the old form left it there with display:none and a hand-written listener
   juggling the label. Dropping the field is also what makes read() leave it
   out, so nothing has to remember to blank it. */
function movementFields(state: AppState, direction: string): FieldSpec[] {
  return savingsFields(state)
    .filter((f) => f.key !== 'fromAccountId' || direction === 'transfer')
    .map((f) => (f.key === 'accountId'
      ? { ...f, label: direction === 'out' ? 'From account' : 'To account' }
      : f));
}

const movementSaved = (direction: unknown): string => {
  if (direction === 'transfer') return 'Transfer recorded';
  return direction === 'out' ? 'Withdrawal recorded' : 'Deposit recorded';
};

/** Records the direction each movement form is currently set to, so the form
    can change shape as it is filled in. */
function useDirection(initial: string) {
  const [direction, setDirection] = useState(initial);
  const onChange = (e: Event): void => {
    const target = e.target as HTMLSelectElement;
    if (target?.name === 'direction') setDirection(target.value);
  };
  return { direction, setDirection, onChange };
}

/** Reads one money field out of a form as it is typed, for a dialog showing
    what its own answers would come to. */
function moneyAsTyped(e: Event, key: string): Cents | null {
  const control = (e.currentTarget as HTMLFormElement)?.elements.namedItem(key);
  return control instanceof HTMLInputElement ? parseMoney(control.value) : null;
}

export function Accounts() {
  const state = app.value;
  const period = routePeriod.value;
  const [allTime, setAllTime] = useState(false);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [editingTx, setEditingTx] = useState<SavingsTx | null>(null);
  const [borrowing, setBorrowing] = useState<BorrowTarget | null>(null);
  const [repaying, setRepaying] = useState<DebtSummary | null>(null);
  const [paying, setPaying] = useState<Cents>(0);
  const [reconciling, setReconciling] = useState<Account | null>(null);
  const [actual, setActual] = useState<Cents>(0);

  const accounts = state.accounts;
  const held = heldAccounts(state);
  const debts = debtSummaries(state);
  const owed = debtOwed(state);
  const txs = sortByDateDesc(allTime ? state.savingsTx : savingsTxIn(state, period), 'date');
  const gold = goldSummary(state);
  const money = (cents: number): string => formatMoney(cents, state.settings);
  const label = periodLabel(period, state.settings.locale);

  const add = useDirection(accounts.length > 1 ? 'transfer' : 'in');
  const edit = useDirection(editingTx?.direction ?? 'in');

  const saveMovement = (data: FormData): void => {
    if (data.direction !== 'transfer') data.fromAccountId = '';
    upsert('savingsTx', data);
  };

  /* Both debt dialogs need somewhere for the money to come from or go to, and
     a debt account is not it. Said once here rather than discovered as a
     silent no-op after the form has been filled in. */
  const needsAnAccount = (): boolean => {
    if (held.length) return false;
    toast('Add an account first — the money has to move somewhere');
    return true;
  };

  const card = (a: Account) => {
    const flows = accountFlows(state, a.id);
    const balance = accountBalance(state, a.id);
    const lines = [
      { label: 'Opening', amount: flows.opening, negative: flows.opening < 0 },
      { label: 'Income', amount: flows.income, negative: false },
      { label: 'Moved in', amount: flows.savedIn, negative: false },
      { label: 'Purchases', amount: flows.purchases, negative: true },
      { label: 'Bills paid', amount: flows.bills, negative: true },
      { label: 'Gold', amount: flows.gold, negative: true },
      { label: 'Moved out', amount: flows.savedOut, negative: true }
    ].filter((l) => l.amount);

    return (
      <div class="account" key={a.id}>
        <div class="account-top">
          <div>
            <div class="account-name">{a.name}</div>
            <div class="muted">{a.type}</div>
          </div>
          <div class="actions" style="margin-left:auto">
            <button
              class="quiet small"
              title="Make this agree with what the bank really says"
              onClick={() => { setActual(balance); setReconciling(a); }}
            >Reconcile</button>
            <button class="quiet small" onClick={() => setEditing(a)}>Edit</button>
            <button
              class="quiet small danger"
              onClick={() => {
                const ok = confirm(
                  `Delete "${a.name}" and all of its movements? This cannot be undone.\n\n`
                  + 'Income, bills and purchases linked to it are kept, but stop counting towards any balance.');
                if (ok) remove('accounts', a.id);
              }}
            >Delete</button>
          </div>
        </div>
        <div class={balance < 0 ? 'account-balance is-negative' : 'account-balance'}>{money(balance)}</div>
        <TargetProgress balance={balance} target={a.target} settings={state.settings} suffix=" target" />
        {lines.length
          ? (
            <div class="flows">
              {lines.map((l) => (
                <FlowLine key={l.label} label={l.label} amount={l.amount} settings={state.settings} negative={l.negative} />
              ))}
            </div>
          )
          : <div class="muted">Nothing has moved yet.</div>}
      </div>
    );
  };

  /* A debt reads the other way round from an account: the headline is what is
     left to pay, and the bar fills as you pay it rather than as it grows. */
  const debtCard = (d: DebtSummary) => {
    const pct = Math.round(payoffProgress(d) * 100);
    return (
      <div class="account is-debt" key={d.account.id}>
        <div class="account-top">
          <div>
            <div class="account-name">{d.account.name}</div>
            <div class="muted">{d.settled ? 'Settled' : `${money(d.repaid)} of ${money(d.borrowed)} paid back`}</div>
          </div>
          <div class="actions" style="margin-left:auto">
            {d.settled ? null : (
              <button
                class="quiet small"
                onClick={() => { if (!needsAnAccount()) { setPaying(0); setRepaying(d); } }}
              >Repay</button>
            )}
            <button
              class="quiet small"
              title="They lent you more"
              onClick={() => { if (!needsAnAccount()) setBorrowing(d); }}
            >Borrow more</button>
            <button class="quiet small" onClick={() => setEditing(d.account)}>Edit</button>
            <button
              class="quiet small danger"
              onClick={() => {
                const ok = confirm(
                  `Delete "${d.account.name}" and every movement against it? This cannot be undone.\n\n`
                  + 'The money you borrowed stays in whichever account it landed in, so your balances '
                  + 'will read higher by what you still owe.');
                if (ok) remove('accounts', d.account.id);
              }}
            >Delete</button>
          </div>
        </div>
        <div class={d.settled ? 'account-balance is-settled' : 'account-balance is-negative'}>
          {d.settled ? money(0) : money(d.owed)}
        </div>
        <div class="progress"><div style={`width:${pct}%`} /></div>
        <div class="muted">{d.settled ? 'Nothing left to pay' : `${pct}% paid back`}</div>
        {/* Signed against what is owed, not against the account's balance —
            the headline above is a debt, so the lines have to add up to it:
            borrowed raises it, paid back brings it down. */}
        <div class="flows">
          <FlowLine label="Borrowed" amount={d.borrowed} settings={state.settings} />
          <FlowLine label="Paid back" amount={d.repaid} settings={state.settings} negative />
        </div>
      </div>
    );
  };

  const movementRow = (t: SavingsTx) => {
    const to = accountName(state, t.accountId) || '(deleted)';
    const transfer = t.direction === 'transfer';
    const out = t.direction === 'out';
    const where = transfer ? `${accountName(state, t.fromAccountId) || '(deleted)'} → ${to}` : to;

    return (
      <tr key={t.id}>
        <td class="num">{t.date}</td>
        <td>{where}</td>
        <td>
          <span class={`status ${transfer ? 'due' : (out ? 'overdue' : 'paid')}`}>
            {transfer ? 'Transfer' : (out ? 'Out' : 'In')}
          </span>
        </td>
        <td class="num">{`${out ? '−' : '+'}${money(t.amount)}`}</td>
        <td class="truncate muted" title={t.notes || ''}>{t.notes || ''}</td>
        <RowActions
          onEdit={() => { edit.setDirection(t.direction); setEditingTx(t); }}
          onDelete={() => { if (confirmDelete('movement')) remove('savingsTx', t.id); }}
        />
      </tr>
    );
  };

  const drift = reconciling ? reconciliation(state, reconciling.id, actual) : null;

  return (
    <div class="stack">
      <div class="figures">
        <Figure label="Across all accounts" value={money(accountsHeld(state))}
          note={plural(held.length, 'account')} />
        <Figure label="In savings pots" value={money(savingsBalance(state))}
          note={plural(accounts.filter(isSavingsAccount).length, 'pot')} />
        {debts.length
          ? <Figure label="Owed" value={money(owed)} negative={owed > 0}
            note={owed > 0 ? plural(debts.filter((d) => !d.settled).length, 'debt') : 'all settled'} />
          : null}
        <Figure label="Gold" value={money(gold.value)}
          note={gold.value ? `${gold.pure.toFixed(2)} g of pure gold` : 'none held'} />
        <Figure label="Total worth" value={money(totalSavings(state) + gold.value)}
          note={owed > 0 ? 'accounts and gold, after what you owe' : 'accounts and gold together'} />
      </div>

      {/* Above the accounts on purpose. Borrowed money sits in a real balance,
          so it has to be recorded before that balance is reconciled against the
          bank — otherwise the loan is absorbed as income you never earned. */}
      <Sheet>
        <SheetHead>
          <h2>Money you owe</h2>
          <span class="muted spacer">
            {debts.length
              ? 'Taken off every total, so nothing here is offered to you as savings.'
              : 'Borrowed money is not yours. Record it and the rest of the app stops counting it.'}
          </span>
          <button onClick={() => { if (!needsAnAccount()) setBorrowing('new'); }}>Record a debt</button>
        </SheetHead>
        <SheetBody>
          {debts.length
            ? <div class="accounts">{debts.map(debtCard)}</div>
            : (
              <div class="empty">
                <strong>You owe nothing</strong>
                Money borrowed from family, a friend or anyone else goes here. It stays in
                whichever account it landed in, but stops counting as yours — so goals are
                not funded out of it and the projection does not promise it to you.
              </div>
            )}
        </SheetBody>
      </Sheet>

      <Sheet>
        <SheetHead>
          <h2>Accounts, cards &amp; pots</h2>
          <span class="muted spacer">
            Every income, purchase and paid bill moves one of these balances.
          </span>
          <button class="primary" onClick={() => setEditing('new')}>Add account</button>
        </SheetHead>
        <SheetBody>
          {held.length
            ? <div class="accounts">{held.map(card)}</div>
            : (
              <div class="empty">
                <strong>No accounts yet</strong>
                Add the card your salary lands on, and anywhere you put money aside.
                Every entry can then say which account it moved.
              </div>
            )}
        </SheetBody>
      </Sheet>

      {accounts.length ? (
        <AddSection
          title="Movements between accounts"
          addLabel="Record movement"
          fields={movementFields(state, add.direction)}
          state={state}
          forceOpen={!txs.length}
          onChange={add.onChange}
          onInvalid={() => toast('Fill in the required fields')}
          onSubmit={(data) => {
            if (data.direction === 'transfer' && data.fromAccountId === data.accountId) {
              toast('A transfer needs two different accounts');
              return;
            }
            saveMovement(data);
            followDate(String(data.date ?? ''), movementSaved(data.direction));
          }}
        />
      ) : null}

      <Sheet>
        <SheetHead>
          <h2>{allTime ? 'All movements' : label}</h2>
          <span class="muted">{plural(txs.length, 'movement')}</span>
          <div class="spacer"><ScopeToggle allTime={allTime} onChange={setAllTime} /></div>
        </SheetHead>
        <SheetBody flush>
          <Table headers={HEADERS}>
            {txs.length
              ? listRows({ records: txs, dateKey: 'date', colspan: COLUMNS, row: movementRow, grouped: allTime, state })
              : (
                <EmptyRow
                  colspan={COLUMNS}
                  title={allTime ? 'No movements recorded yet' : `No movements in ${label}`}
                  hint={accounts.length
                    ? 'Record what you moved from one account to another.'
                    : 'Add an account first.'}
                />
              )}
          </Table>
        </SheetBody>
      </Sheet>

      {borrowing ? (
        <Editor
          title={borrowing === 'new' ? 'Record a debt' : `Borrowed more from ${borrowing.account.name}`}
          /* Borrowing again from the same person asks everything except who:
             the card it was opened from has already answered that. */
          fields={borrowing === 'new'
            ? FIELDS.borrow
            : FIELDS.borrow.filter((f) => f.key !== 'name')}
          record={{ date: todayISO() }}
          state={state}
          saveLabel="Record it"
          onInvalid={() => toast('Fill in the required fields')}
          note={
            <div class="buy-note">
              <p class="muted">
                The money stays in the account it landed in, and the same sum is recorded
                as owed — so that balance stays right while your total, your savings rate
                and every goal stop counting it as yours.
              </p>
            </div>
          }
          onSave={(data) => {
            borrow({
              debtId: borrowing === 'new' ? undefined : borrowing.account.id,
              name: borrowing === 'new' ? String(data['name'] ?? '') : borrowing.account.name,
              amount: data['amount'] as Cents,
              date: String(data['date'] ?? ''),
              intoAccountId: String(data['intoAccountId'] ?? ''),
              notes: String(data['notes'] ?? '')
            });
            followDate(String(data['date'] ?? ''), 'Debt recorded');
          }}
          onClose={() => setBorrowing(null)}
        />
      ) : null}

      {repaying ? (
        <Editor
          title={`Pay back ${repaying.account.name}`}
          fields={FIELDS.repay}
          record={{ date: todayISO() }}
          state={state}
          saveLabel="Record the payment"
          onInvalid={() => toast('Fill in the required fields')}
          onInput={(e) => {
            const typed = moneyAsTyped(e, 'amount');
            if (typed !== null) setPaying(typed);
          }}
          note={
            <div class="buy-note">
              <div class="assume-row">
                <span>Owed now</span>
                <span class="num">{money(repaying.owed)}</span>
              </div>
              <div class="assume-row">
                <span>Paying back</span>
                <span class="num">{`−${money(paying)}`}</span>
              </div>
              <div class="assume-row is-total">
                <strong>Still owed after</strong>
                <span class="num">{money(owedAfter(repaying, paying))}</span>
              </div>
              <p class="muted">
                {owedAfter(repaying, paying) === 0 && paying > 0
                  ? 'That settles it.'
                  : 'Comes out of the account you name, and off what you owe.'}
              </p>
            </div>
          }
          onSave={(data) => {
            const amount = data['amount'] as Cents;
            repay(repaying.account.id, {
              amount,
              date: String(data['date'] ?? ''),
              fromAccountId: String(data['fromAccountId'] ?? ''),
              notes: String(data['notes'] ?? '')
            });
            const left = owedAfter(repaying, amount);
            toast(left ? `Paid · ${money(left)} still owed` : `${repaying.account.name} settled`);
          }}
          onClose={() => setRepaying(null)}
        />
      ) : null}

      {reconciling && drift ? (
        <Editor
          title={`Reconcile ${reconciling.name}`}
          fields={FIELDS.reconcile}
          record={{ date: todayISO(), actual: drift.tracked }}
          state={state}
          saveLabel="Correct it"
          onInvalid={() => toast('Fill in what the account really has')}
          onInput={(e) => {
            const typed = moneyAsTyped(e, 'actual');
            if (typed !== null) setActual(typed);
          }}
          note={
            <div class="buy-note">
              <div class="assume-row">
                <span>This app says</span>
                <span class="num">{money(drift.tracked)}</span>
              </div>
              <div class="assume-row">
                <span>You say it really has</span>
                <span class="num">{money(drift.actual)}</span>
              </div>
              <div class="assume-row is-total">
                <strong>Difference</strong>
                <span class={drift.difference < 0 ? 'num is-negative' : 'num'}>
                  {`${drift.difference > 0 ? '+' : ''}${money(drift.difference)}`}
                </span>
              </div>
              <p class="muted">
                {drift.difference === 0
                  ? 'They already agree. Nothing will be recorded.'
                  : drift.difference < 0
                    ? `${money(-drift.difference)} will be recorded as spending you never entered — a purchase under "Adjustment", which your usual monthly spending will then include.`
                    : `${money(drift.difference)} will be recorded as money that arrived and was never entered — income under "Adjustment".`}
              </p>
              {drift.difference > 0 ? (
                <div class="notice warn" style="margin-top:var(--s3)">
                  Money you borrowed and have not recorded yet is sitting in this balance,
                  and would be absorbed here as income you never earned. Record it under
                  <strong> Money you owe</strong> first, then reconcile.
                </div>
              ) : null}
            </div>
          }
          onSave={(data) => {
            const corrected = reconcile(
              reconciling.id, data['actual'] as Cents, String(data['date'] ?? '')
            );
            toast(corrected
              ? `Corrected by ${money(Math.abs(corrected))}`
              : 'Already agreed — nothing recorded');
          }}
          onClose={() => setReconciling(null)}
        />
      ) : null}

      {editing ? (
        <Editor
          title={editing === 'new' ? 'Add account' : 'Edit account'}
          fields={FIELDS.account}
          record={editing === 'new' ? BLANK_ACCOUNT : editing}
          state={state}
          onInvalid={() => toast('Fill in the required fields')}
          onSave={(data) => { upsert('accounts', data); toast('Saved'); }}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {editingTx ? (
        <Editor
          title="Edit movement"
          fields={movementFields(state, edit.direction)}
          record={editingTx}
          state={state}
          onChange={edit.onChange}
          onInvalid={() => toast('Fill in the required fields')}
          onSave={(data) => { saveMovement(data); toast('Saved'); }}
          onClose={() => setEditingTx(null)}
        />
      ) : null}
    </div>
  );
}
