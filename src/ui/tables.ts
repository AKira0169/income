/* ui/tables.ts — the ledger tables every tab is built from. */

import { el } from '../dom.ts';
import type { Child } from '../dom.ts';
import { periodLabel, periodOf } from '../store.ts';
import type { Cents } from '../domain/types.ts';
import { accountName, money } from './format.ts';
import { isAllTime } from './view.ts';

export interface Column {
  label: string;
  /** Right-aligned, for money and other figures. */
  num?: boolean;
  actions?: boolean;
}

export type Header = Column | string;

const headerCell = (h: Header): HTMLTableCellElement => {
  const col: Column = typeof h === 'string' ? { label: h } : h;
  return el('th', {
    class: col.num ? 'num' : (col.actions ? 'actions' : null),
    text: col.label
  });
};

export function table(headers: readonly Header[], rows: Child): HTMLDivElement {
  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, headers.map(headerCell))]),
      el('tbody', {}, rows)
    ])
  ]);
}

export function emptyRow(colspan: number, title: string, hint: string): HTMLTableRowElement {
  return el('tr', {}, [
    el('td', { colspan }, [el('div', { class: 'empty' }, [el('strong', { text: title }), hint])])
  ]);
}

export function rowActions(onEdit: () => void, onDelete: () => void): HTMLTableCellElement {
  return el('td', { class: 'actions' }, [
    el('button', { class: 'quiet small', text: 'Edit', onclick: onEdit }),
    el('button', { class: 'quiet small danger', text: 'Delete', onclick: onDelete })
  ]);
}

/** The account cell, with how the money moved underneath it. */
export function accountCell(record: { accountId?: string; method?: string }): HTMLTableCellElement {
  const name = accountName(record.accountId);
  return el('td', {}, [
    name ? el('div', { text: name }) : el('span', { class: 'faint', text: 'not linked' }),
    record.method ? el('span', { class: 'cell-sub', text: record.method }) : null
  ]);
}

/** Rows for a history table: the same rows as the monthly view, with a ruled
    heading and running total before each new month. */
export function monthGrouped<T extends object>(
  records: readonly T[],
  dateKey: keyof T & string,
  colspan: number,
  rowFn: (record: T) => HTMLTableRowElement,
  pick?: (record: T) => Cents
): HTMLTableRowElement[] {
  const read = (r: T): Record<string, unknown> => r as Record<string, unknown>;
  const amount = pick ?? ((r: T) => Number(read(r).amount) || 0);

  const totals = new Map<string, Cents>();
  for (const r of records) {
    const p = periodOf(String(read(r)[dateKey] ?? ''));
    totals.set(p, (totals.get(p) ?? 0) + amount(r));
  }

  const out: HTMLTableRowElement[] = [];
  let current: string | null = null;
  for (const r of records) {
    const p = periodOf(String(read(r)[dateKey] ?? ''));
    if (p !== current) {
      current = p;
      out.push(el('tr', { class: 'group-row' }, [
        el('td', { colspan }, [
          el('span', { text: p ? periodLabel(p) : 'No date' }),
          el('span', { class: 'group-total num', text: money(totals.get(p) ?? 0) })
        ])
      ]));
    }
    out.push(rowFn(r));
  }
  return out;
}

/** Rows in a list, month-grouped when the list is showing all time. */
export function listRows<T extends object>(
  key: string,
  records: readonly T[],
  dateKey: keyof T & string,
  colspan: number,
  rowFn: (record: T) => HTMLTableRowElement,
  pick?: (record: T) => Cents
): HTMLTableRowElement[] {
  return isAllTime(key)
    ? monthGrouped(records, dateKey, colspan, rowFn, pick)
    : records.map(rowFn);
}
