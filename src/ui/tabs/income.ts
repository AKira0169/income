/* ui/tabs/income.ts — one-off income, and the recurring set-up behind it. */

import { el } from '../../dom.ts';
import {
  generateIncome, incomeIn, linkGeneratedTo, monthlyEquivalent, periodLabel,
  plural, remove, sortByDateDesc, state, sum, upsert
} from '../../store.ts';
import type { IncomeEntry, IncomeTemplate } from '../../types.ts';
import { confirmDelete, followDate, toast } from '../feedback.ts';
import { FIELDS } from '../fields.ts';
import { accountName, money } from '../format.ts';
import { addSection, openEditor, recurringSection } from '../forms.ts';
import { accountCell, emptyRow, listRows, rowActions, table } from '../tables.ts';
import { isAllTime, render, scopeToggle, view } from '../view.ts';

const COLUMNS = 7;

function incomeRow(r: IncomeEntry): HTMLTableRowElement {
  return el('tr', {}, [
    el('td', { class: 'num', text: r.date }),
    el('td', {}, [
      el('div', { text: r.source }),
      // Generated rows are marked so you can tell what the app filled in from
      // what you entered by hand.
      r.templateId ? el('span', { class: 'cell-sub', text: 'Recurring' }) : null
    ]),
    el('td', { class: 'muted', text: r.category }),
    el('td', { class: 'num', text: money(r.amount) }),
    accountCell(r),
    el('td', { class: 'truncate muted', title: r.notes || '', text: r.notes || '' }),
    rowActions(
      () => openEditor('Edit income', FIELDS.income, r, (d) => { upsert('income', d); }),
      () => { if (confirmDelete('income entry')) { remove('income', r.id); render(); } }
    )
  ]);
}

function templateRow(t: IncomeTemplate): HTMLTableRowElement {
  return el('tr', {}, [
    el('td', {}, [
      el('div', { text: t.source }),
      t.accountId ? el('span', { class: 'cell-sub', text: `into ${accountName(t.accountId)}` }) : null
    ]),
    el('td', { class: 'muted', text: t.category }),
    el('td', { class: 'muted', text: t.frequency || 'Monthly' }),
    el('td', { class: 'num', text: `day ${t.payDay || 1}` }),
    el('td', { class: 'num', text: money(t.expected) }),
    el('td', { class: 'num', title: 'Spread across the year', text: money(monthlyEquivalent(t)) }),
    el('td', {}, [
      el('span', { class: `status ${t.active ? 'paid' : ''}`, text: t.active ? 'Active' : 'Paused' })
    ]),
    rowActions(
      () => openEditor('Edit recurring income', FIELDS.incomeTemplate, t, (d) => {
        const linked = linkGeneratedTo('incomeTemplates', upsert('incomeTemplates', d));
        return linked
          ? `Saved · ${plural(linked, 'past entry', 'past entries')} linked to ${accountName(String(d.accountId ?? ''))}`
          : undefined;
      }),
      () => { if (confirmDelete('recurring income')) { remove('incomeTemplates', t.id); render(); } }
    )
  ]);
}

function emptyHint(all: boolean, hasTemplates: boolean): string {
  if (all) return 'Everything you add, in any month, is listed here.';
  return hasTemplates
    ? 'Nothing is due from your recurring income this month.'
    : 'Set your salary up once below and it will appear every month on its own.';
}

export function renderIncome(): HTMLElement {
  const period = view.period;
  const all = isAllTime('income');
  const records = sortByDateDesc(all ? state.income : incomeIn(period), 'date');
  const total = sum(records, (r) => r.amount);
  const templates = state.incomeTemplates;

  return el('div', { class: 'stack' }, [
    addSection('add-income', 'One-off income', 'Add income', FIELDS.income, (data) => {
      upsert('income', data);
      followDate(String(data.date ?? ''), 'Income added');
    }, !records.length && !templates.length),

    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: all ? 'All income' : periodLabel(period) }),
        el('span', { class: 'muted', text: plural(records.length, 'entry', 'entries') }),
        el('div', { class: 'spacer' }, [scopeToggle('income')]),
        !all && templates.length ? el('button', {
          text: 'Generate from recurring',
          onclick: () => {
            const made = generateIncome(period);
            render();
            toast(made ? `Added ${plural(made, 'entry', 'entries')}` : 'Already up to date');
          }
        }) : null,
        el('span', { class: 'num', text: money(total) })
      ]),
      el('div', { class: 'sheet-body flush' }, [table(
        [{ label: 'Date' }, { label: 'Source' }, { label: 'Category' }, { label: 'Amount', num: true },
          { label: 'Account' }, { label: 'Notes' }, { label: '', actions: true }],
        records.length
          ? listRows('income', records, 'date', COLUMNS, incomeRow)
          : [emptyRow(COLUMNS,
            all ? 'No income recorded yet' : `No income in ${periodLabel(period)}`,
            emptyHint(all, templates.length > 0))]
      )])
    ]),

    recurringSection<IncomeTemplate>({
      key: 'recurring-income',
      title: 'Recurring income',
      noun: 'source',
      collection: 'incomeTemplates',
      fields: FIELDS.incomeTemplate,
      saveLabel: 'Save recurring income',
      saved: 'Recurring income saved',
      hint: 'Set your salary — or any other regular payment — up once here. Each new month it is ' +
        'entered for you automatically, and you only touch it if the figure changes.',
      headers: [{ label: 'Source' }, { label: 'Category' }, { label: 'How often' },
        { label: 'Paid on', num: true }, { label: 'Amount', num: true }, { label: 'Per month', num: true },
        { label: 'Status' }, { label: '', actions: true }],
      templates,
      row: templateRow
    })
  ]);
}
