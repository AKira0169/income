/* ui/tabs/bills.ts — the monthly job: what is due, and what you actually paid.

   Amount and units are editable straight in the table. When the real bill
   arrives you are correcting one number, and opening a dialog to do that would
   be the slowest possible way to record it. */

import { el } from '../../dom.ts';
import {
  billIsOverdue, billsIn, dueDateFor, generateBills, linkGeneratedTo, METERED,
  monthlyEquivalent, normalizeBill, parseMoney, periodLabel, plural, remove,
  state, sum, toMajor, todayISO, upsert
} from '../../store.ts';
import type { Bill, BillTemplate } from '../../domain/types.ts';
import { confirmDelete, toast } from '../feedback.ts';
import { FIELDS } from '../fields.ts';
import { accountName, money } from '../format.ts';
import { lastAccountFor, openEditor, recurringSection } from '../forms.ts';
import { emptyRow, listRows, rowActions, table } from '../tables.ts';
import { isAllTime, render, scopeToggle, view } from '../view.ts';

const COLUMNS = 8;

interface InlineOptions {
  label?: string;
  width?: string;
  placeholder?: string;
}

function inlineNumber(
  value: string,
  onCommit: (raw: string) => void,
  opts: InlineOptions = {}
): HTMLInputElement {
  const input = el('input', {
    type: 'text', inputmode: 'decimal', value,
    'aria-label': opts.label ?? 'value',
    style: `width:${opts.width ?? '90px'};text-align:right;padding:4px 8px`,
    placeholder: opts.placeholder ?? ''
  });
  input.addEventListener('change', () => onCommit(input.value));
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });
  return input;
}

function billRow(b: Bill): HTMLTableRowElement {
  const unit = METERED[b.category];
  const overdue = billIsOverdue(b);
  const statusClass = b.status === 'paid' ? 'paid' : (overdue ? 'overdue' : 'due');
  const statusText = b.status === 'paid' ? 'Paid' : (overdue ? 'Overdue' : 'Unpaid');
  const sub = [b.provider || '', b.accountId ? `from ${accountName(b.accountId)}` : '']
    .filter(Boolean).join(' · ');

  return el('tr', {}, [
    el('td', {}, [
      el('div', { text: b.name }),
      sub ? el('span', { class: 'cell-sub', text: sub }) : null
    ]),
    el('td', { class: 'muted', text: b.category }),
    el('td', { class: 'num', text: b.dueDate || '—' }),
    el('td', { class: 'num' }, [
      inlineNumber(b.amount ? toMajor(b.amount).toFixed(2) : '', (raw) => {
        upsert('bills', { id: b.id, amount: parseMoney(raw) });
        render();
      }, { label: `${b.name} amount` })
    ]),
    el('td', { class: 'num' }, [
      unit
        ? inlineNumber(b.units === null || b.units === undefined ? '' : String(b.units), (raw) => {
          upsert('bills', { id: b.id, units: raw.trim() === '' ? null : Number(raw) });
          render();
        }, { width: '72px', placeholder: unit, label: `${b.name} units used` })
        : el('span', { class: 'faint', text: '—' })
    ]),
    el('td', { class: 'muted', text: unit || '' }),
    el('td', {}, [el('span', { class: `status ${statusClass}`, text: statusText })]),
    el('td', { class: 'actions' }, [
      el('button', {
        class: 'quiet small',
        text: b.status === 'paid' ? 'Unpay' : 'Mark paid',
        onclick: () => {
          upsert('bills', b.status === 'paid'
            ? { id: b.id, status: 'unpaid', paidDate: '' }
            : { id: b.id, status: 'paid', paidDate: todayISO() });
          render();
        }
      }),
      el('button', {
        class: 'quiet small', text: 'Edit',
        onclick: () => openEditor('Edit bill', FIELDS.bill, b, (d) => {
          upsert('bills', normalizeBill(d as Partial<Bill>, b.period));
        })
      }),
      el('button', {
        class: 'quiet small danger', text: 'Delete',
        onclick: () => { if (confirmDelete('bill')) { remove('bills', b.id); render(); } }
      })
    ])
  ]);
}

function templateRow(t: BillTemplate): HTMLTableRowElement {
  return el('tr', {}, [
    el('td', {}, [
      el('div', { text: t.name }),
      t.accountId ? el('span', { class: 'cell-sub', text: `from ${accountName(t.accountId)}` }) : null
    ]),
    el('td', { class: 'muted', text: t.category }),
    el('td', { class: 'muted', text: t.provider || '—' }),
    el('td', { class: 'muted', text: t.frequency || 'Monthly' }),
    el('td', { class: 'num', text: t.dueDay || 1 }),
    el('td', { class: 'num', text: money(t.expected) }),
    el('td', { class: 'num', title: 'Spread across the year', text: money(monthlyEquivalent(t)) }),
    el('td', {}, [
      el('span', { class: `status ${t.active ? 'paid' : ''}`, text: t.active ? 'Active' : 'Paused' })
    ]),
    rowActions(
      () => openEditor('Edit recurring bill', FIELDS.billTemplate, t, (d) => {
        const linked = linkGeneratedTo('billTemplates', upsert('billTemplates', d));
        return linked
          ? `Saved · ${plural(linked, 'past bill')} linked to ${accountName(String(d.accountId ?? ''))}`
          : undefined;
      }),
      () => { if (confirmDelete('recurring bill')) { remove('billTemplates', t.id); render(); } }
    )
  ]);
}

function emptyHint(all: boolean, hasTemplates: boolean): string {
  if (all) return 'Every bill you record, in any month, is listed here.';
  return hasTemplates
    ? 'Nothing is due from your recurring bills this month.'
    : 'Set your bills up once below — electricity, water, internet — and each month fills itself in.';
}

export function renderBills(): HTMLElement {
  const period = view.period;
  const all = isAllTime('bills');
  // Newest first when reading history, soonest first when working a month.
  const bills = (all ? state.bills.slice() : billsIn(period).slice()).sort((a, b) =>
    all
      ? String(b.dueDate).localeCompare(String(a.dueDate))
      : String(a.dueDate).localeCompare(String(b.dueDate)));

  const total = sum(bills, (b) => b.amount);
  const paid = sum(bills.filter((b) => b.status === 'paid'), (b) => b.amount);
  const templates = state.billTemplates;

  return el('div', { class: 'stack' }, [
    /* This month's bills lead, because that is the monthly job. */
    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: all ? 'All bills' : periodLabel(period) }),
        el('span', { class: 'muted', text: `${money(paid)} paid of ${money(total)}` }),
        el('div', { class: 'spacer' }, [scopeToggle('bills')]),
        !all ? el('button', {
          text: 'Generate from recurring',
          onclick: () => {
            const made = generateBills(period);
            render();
            toast(made ? `Added ${plural(made, 'bill')}` : 'Already up to date');
          }
        }) : null,
        el('button', {
          class: 'primary', text: 'Add bill',
          onclick: () => openEditor('Add bill', FIELDS.bill, {
            templateId: null, name: '', category: 'Other', provider: '',
            period, dueDate: dueDateFor(period, new Date().getDate()),
            amount: 0, accountId: lastAccountFor('bills'),
            units: null, unitRate: null, status: 'unpaid', paidDate: '', method: '', notes: ''
          }, (d) => {
            // The literal above carries no id, so upsert() inserts rather than
            // updating — this is the "Add bill" path.
            upsert('bills', normalizeBill(d as Partial<Bill>, period));
          })
        })
      ]),
      el('div', { class: 'sheet-body flush' }, [table(
        [{ label: 'Bill' }, { label: 'Category' }, { label: 'Due' }, { label: 'Amount', num: true },
          { label: 'Units', num: true }, { label: 'Unit' }, { label: 'Status' }, { label: '', actions: true }],
        bills.length
          ? listRows('bills', bills, 'dueDate', COLUMNS, billRow)
          : [emptyRow(COLUMNS,
            all ? 'No bills recorded yet' : `No bills for ${periodLabel(period)}`,
            emptyHint(all, templates.length > 0))]
      )])
    ]),

    recurringSection<BillTemplate>({
      key: 'recurring',
      title: 'Recurring bills',
      noun: 'bill',
      collection: 'billTemplates',
      fields: FIELDS.billTemplate,
      saveLabel: 'Save recurring bill',
      saved: 'Recurring bill saved',
      hint: 'Set each bill up once here — what it is, how often, and the typical amount. Each new ' +
        'month it appears above on its own; type in the real figure when the bill arrives.',
      headers: [{ label: 'Bill' }, { label: 'Category' }, { label: 'Provider' }, { label: 'How often' },
        { label: 'Due day', num: true }, { label: 'Typical', num: true }, { label: 'Per month', num: true },
        { label: 'Status' }, { label: '', actions: true }],
      templates,
      row: templateRow
    })
  ]);
}
