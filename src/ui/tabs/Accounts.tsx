/* ui/tabs/Accounts.tsx — every place money sits, and what moved it there.

   A balance is arithmetic you can check, so each card shows the flows it is
   made of rather than just the total. */

import { useState } from 'preact/hooks';
import { formatMoney, plural } from '../../domain/money.ts';
import { periodLabel } from '../../domain/period.ts';
import { sortByDateDesc } from '../../domain/records.ts';
import {
  accountBalance, accountFlows, accountName, isSavingsAccount, savingsBalance,
  savingsTxIn, totalSavings
} from '../../domain/selectors.ts';
import { goldSummary } from '../../domain/gold.ts';
import { remove, upsert } from '../../state/actions.ts';
import { app } from '../../state/app.ts';
import { period as routePeriod } from '../../state/route.ts';
import type { Account, AppState, SavingsTx } from '../../domain/types.ts';
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

export function Accounts() {
  const state = app.value;
  const period = routePeriod.value;
  const [allTime, setAllTime] = useState(false);
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [editingTx, setEditingTx] = useState<SavingsTx | null>(null);

  const accounts = state.accounts;
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

  return (
    <div class="stack">
      <div class="figures">
        <Figure label="Across all accounts" value={money(totalSavings(state))}
          note={plural(accounts.length, 'account')} />
        <Figure label="In savings pots" value={money(savingsBalance(state))}
          note={plural(accounts.filter(isSavingsAccount).length, 'pot')} />
        <Figure label="Gold" value={money(gold.value)}
          note={gold.value ? `${gold.pure.toFixed(2)} g of pure gold` : 'none held'} />
        <Figure label="Total worth" value={money(totalSavings(state) + gold.value)}
          note="accounts and gold together" />
      </div>

      <Sheet>
        <SheetHead>
          <h2>Accounts, cards &amp; pots</h2>
          <span class="muted spacer">
            Every income, purchase and paid bill moves one of these balances.
          </span>
          <button class="primary" onClick={() => setEditing('new')}>Add account</button>
        </SheetHead>
        <SheetBody>
          {accounts.length
            ? <div class="accounts">{accounts.map(card)}</div>
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
