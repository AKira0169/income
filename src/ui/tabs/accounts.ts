/* ui/tabs/accounts.ts — every place money sits, and what moved it there.

   A balance is arithmetic you can check, so each card shows the flows it is
   made of rather than just the total. */

import { el } from '../../dom.ts';
import {
  accountBalance, accountFlows, goldSummary, isSavingsAccount, periodLabel, plural,
  remove, savingsBalance, savingsTxIn, sortByDateDesc, state, totalSavings, upsert
} from '../../store.ts';
import type { Account, SavingsTx } from '../../domain/types.ts';
import { confirmDelete, followDate, toast } from '../feedback.ts';
import { FIELDS, savingsFields } from '../fields.ts';
import { accountName, money } from '../format.ts';
import { addSection, openEditor, wireMovementForm } from '../forms.ts';
import { emptyRow, listRows, rowActions, table } from '../tables.ts';
import { isAllTime, render, scopeToggle, view } from '../view.ts';
import { figure, flowLine, targetProgress } from '../widgets.ts';

const COLUMNS = 6;

function accountCard(a: Account): HTMLDivElement {
  const flows = accountFlows(a.id);
  const balance = accountBalance(a.id);
  const lines = [
    flowLine('Opening', flows.opening, flows.opening < 0),
    flowLine('Income', flows.income),
    flowLine('Moved in', flows.savedIn),
    flowLine('Purchases', flows.purchases, true),
    flowLine('Bills paid', flows.bills, true),
    flowLine('Gold', flows.gold, true),
    flowLine('Moved out', flows.savedOut, true)
  ].filter((line): line is HTMLDivElement => line !== null);

  return el('div', { class: 'account' }, [
    el('div', { class: 'account-top' }, [
      el('div', {}, [
        el('div', { class: 'account-name', text: a.name }),
        el('div', { class: 'muted', text: a.type })
      ]),
      el('div', { class: 'actions', style: 'margin-left:auto' }, [
        el('button', {
          class: 'quiet small', text: 'Edit',
          onclick: () => openEditor('Edit account', FIELDS.account, a, (d) => { upsert('accounts', d); })
        }),
        el('button', {
          class: 'quiet small danger', text: 'Delete',
          onclick: () => {
            const ok = confirm(
              `Delete "${a.name}" and all of its movements? This cannot be undone.\n\n` +
              'Income, bills and purchases linked to it are kept, but stop counting towards any balance.');
            if (ok) { remove('accounts', a.id); render(); }
          }
        })
      ])
    ]),
    el('div', { class: `account-balance${balance < 0 ? ' is-negative' : ''}`, text: money(balance) }),
    targetProgress(balance, a.target, ' target'),
    lines.length
      ? el('div', { class: 'flows' }, lines)
      : el('div', { class: 'muted', text: 'Nothing has moved yet.' })
  ]);
}

function movementRow(t: SavingsTx): HTMLTableRowElement {
  const to = accountName(t.accountId) || '(deleted)';
  const transfer = t.direction === 'transfer';
  const out = t.direction === 'out';
  const where = transfer ? `${accountName(t.fromAccountId) || '(deleted)'} → ${to}` : to;
  const label = transfer ? 'Transfer' : (out ? 'Out' : 'In');
  const status = transfer ? 'due' : (out ? 'overdue' : 'paid');

  return el('tr', {}, [
    el('td', { class: 'num', text: t.date }),
    el('td', { text: where }),
    el('td', {}, [el('span', { class: `status ${status}`, text: label })]),
    el('td', { class: 'num', text: `${out ? '−' : '+'}${money(t.amount)}` }),
    el('td', { class: 'truncate muted', title: t.notes || '', text: t.notes || '' }),
    rowActions(
      () => openEditor('Edit movement', savingsFields(), t, (d) => {
        if (d.direction !== 'transfer') d.fromAccountId = '';
        upsert('savingsTx', d);
      }, (dialog) => wireMovementForm(dialog)),
      () => { if (confirmDelete('movement')) { remove('savingsTx', t.id); render(); } }
    )
  ]);
}

function movementLabel(direction: unknown): string {
  if (direction === 'transfer') return 'Transfer recorded';
  return direction === 'out' ? 'Withdrawal recorded' : 'Deposit recorded';
}

export function renderAccounts(): HTMLElement {
  const period = view.period;
  const all = isAllTime('movements');
  const accounts = state.accounts;
  const txs = sortByDateDesc(all ? state.savingsTx : savingsTxIn(period), 'date');
  const gold = goldSummary();

  let moveSection: HTMLElement | null = null;
  if (accounts.length) {
    moveSection = addSection('add-saving', 'Movements between accounts', 'Record movement',
      savingsFields(), (data) => {
        if (data.direction !== 'transfer') data.fromAccountId = '';
        else if (data.fromAccountId === data.accountId) {
          toast('A transfer needs two different accounts');
          return;
        }
        upsert('savingsTx', data);
        followDate(String(data.date ?? ''), movementLabel(data.direction));
      }, !txs.length);
    wireMovementForm(moveSection);
  }

  return el('div', { class: 'stack' }, [
    el('div', { class: 'figures' }, [
      figure('Across all accounts', money(totalSavings()), plural(accounts.length, 'account')),
      figure('In savings pots', money(savingsBalance()),
        plural(accounts.filter(isSavingsAccount).length, 'pot')),
      figure('Gold', money(gold.value),
        gold.value ? `${gold.pure.toFixed(2)} g of pure gold` : 'none held'),
      figure('Total worth', money(totalSavings() + gold.value), 'accounts and gold together')
    ]),

    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: 'Accounts, cards & pots' }),
        el('span', { class: 'muted spacer' },
          'Every income, purchase and paid bill moves one of these balances.'),
        el('button', {
          class: 'primary', text: 'Add account',
          onclick: () => openEditor('Add account', FIELDS.account,
            { name: '', type: 'Current Account', opening: 0, target: 0, notes: '' },
            (d) => { upsert('accounts', d); })
        })
      ]),
      el('div', { class: 'sheet-body' }, [
        accounts.length
          ? el('div', { class: 'accounts' }, accounts.map(accountCard))
          : el('div', { class: 'empty' }, [
            el('strong', { text: 'No accounts yet' }),
            'Add the card your salary lands on, and anywhere you put money aside. ' +
            'Every entry can then say which account it moved.'
          ])
      ])
    ]),

    moveSection,

    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: all ? 'All movements' : periodLabel(period) }),
        el('span', { class: 'muted', text: plural(txs.length, 'movement') }),
        el('div', { class: 'spacer' }, [scopeToggle('movements')])
      ]),
      el('div', { class: 'sheet-body flush' }, [table(
        [{ label: 'Date' }, { label: 'Account' }, { label: 'Movement' }, { label: 'Amount', num: true },
          { label: 'Notes' }, { label: '', actions: true }],
        txs.length
          ? listRows('movements', txs, 'date', COLUMNS, movementRow)
          : [emptyRow(COLUMNS,
            all ? 'No movements recorded yet' : `No movements in ${periodLabel(period)}`,
            accounts.length ? 'Record what you moved from one account to another.' : 'Add an account first.')]
      )])
    ])
  ]);
}
