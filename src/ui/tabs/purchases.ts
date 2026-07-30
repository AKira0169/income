/* ui/tabs/purchases.ts — one-off spending. */

import { el } from '../../dom.ts';
import { periodLabel, plural, purchasesIn, remove, sortByDateDesc, state, sum, upsert } from '../../store.ts';
import type { Purchase } from '../../domain/types.ts';
import { confirmDelete, followDate } from '../feedback.ts';
import { FIELDS } from '../fields.ts';
import { money } from '../format.ts';
import { addSection, openEditor } from '../forms.ts';
import { accountCell, emptyRow, listRows, rowActions, table } from '../tables.ts';
import { isAllTime, render, scopeToggle, view } from '../view.ts';

const COLUMNS = 7;

function purchaseRow(r: Purchase): HTMLTableRowElement {
  return el('tr', {}, [
    el('td', { class: 'num', text: r.date }),
    el('td', { text: r.item }),
    el('td', { class: 'muted', text: r.category }),
    el('td', { class: 'num', text: money(r.amount) }),
    accountCell(r),
    el('td', { class: 'truncate muted', title: r.notes || '', text: r.notes || '' }),
    rowActions(
      () => openEditor('Edit purchase', FIELDS.purchase, r, (d) => { upsert('purchases', d); }),
      () => { if (confirmDelete('purchase')) { remove('purchases', r.id); render(); } }
    )
  ]);
}

export function renderPurchases(): HTMLElement {
  const period = view.period;
  const all = isAllTime('purchases');
  const records = sortByDateDesc(all ? state.purchases : purchasesIn(period), 'date');
  const total = sum(records, (r) => r.amount);

  return el('div', { class: 'stack' }, [
    addSection('add-purchase', 'Purchases', 'Add purchase', FIELDS.purchase, (data) => {
      upsert('purchases', data);
      followDate(String(data.date ?? ''), 'Purchase added');
    }, !records.length),

    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: all ? 'All purchases' : periodLabel(period) }),
        el('span', { class: 'muted', text: plural(records.length, 'item') }),
        el('div', { class: 'spacer' }, [scopeToggle('purchases')]),
        el('span', { class: 'num', text: money(total) })
      ]),
      el('div', { class: 'sheet-body flush' }, [table(
        [{ label: 'Date' }, { label: 'Item' }, { label: 'Category' }, { label: 'Amount', num: true },
          { label: 'Account' }, { label: 'Notes' }, { label: '', actions: true }],
        records.length
          ? listRows('purchases', records, 'date', COLUMNS, purchaseRow)
          : [emptyRow(COLUMNS,
            all ? 'Nothing bought yet' : `Nothing bought in ${periodLabel(period)}`,
            'Groceries, fuel, clothes — anything that is not a recurring bill.')]
      )])
    ])
  ]);
}
