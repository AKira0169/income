/* ui/components/Table.tsx — the ledger tables every tab is built from. */

import { periodLabel, periodOf } from '../../domain/period.ts';
import { accountName } from '../../domain/selectors.ts';
import { formatMoney } from '../../domain/money.ts';
import type { AppState, Cents } from '../../domain/types.ts';

export interface Column {
  label: string;
  /** Right-aligned, for money and other figures. */
  num?: boolean;
  actions?: boolean;
}

export type Header = Column | string;

export function Table({ headers, children }: {
  headers: readonly Header[];
  children: preact.ComponentChildren;
}) {
  return (
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((h, i) => {
              const col: Column = typeof h === 'string' ? { label: h } : h;
              return (
                <th key={`${col.label}${i}`} class={col.num ? 'num' : (col.actions ? 'actions' : undefined)}>
                  {col.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyRow({ colspan, title, hint }: { colspan: number; title: string; hint: string }) {
  return (
    <tr>
      <td colSpan={colspan}>
        <div class="empty"><strong>{title}</strong>{hint}</div>
      </td>
    </tr>
  );
}

export function RowActions({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <td class="actions">
      <button class="quiet small" onClick={onEdit}>Edit</button>
      <button class="quiet small danger" onClick={onDelete}>Delete</button>
    </td>
  );
}

/** The account cell, with how the money moved underneath it. */
export function AccountCell({ record, state }: {
  record: { accountId?: string; method?: string };
  state: AppState;
}) {
  const name = accountName(state, record.accountId);
  return (
    <td>
      {name ? <div>{name}</div> : <span class="faint">not linked</span>}
      {record.method ? <span class="cell-sub">{record.method}</span> : null}
    </td>
  );
}

export interface ListRowsOptions<T> {
  records: readonly T[];
  dateKey: keyof T & string;
  colspan: number;
  row: (record: T) => preact.JSX.Element;
  /** Group by month with a running total. What "all time" turns on. */
  grouped: boolean;
  state: AppState;
  pick?: (record: T) => Cents;
}

/* Rows for a history table: the same rows as the monthly view, with a ruled
   heading and running total before each new month. Reading a list two ways —
   the month on screen, or the whole history — is what you go looking for when
   you want to know when something last happened. */
export function listRows<T extends object>(opts: ListRowsOptions<T>): preact.JSX.Element[] {
  const { records, dateKey, colspan, row, grouped, state, pick } = opts;
  if (!grouped) return records.map(row);

  const read = (r: T): Record<string, unknown> => r as Record<string, unknown>;
  const amount = pick ?? ((r: T) => Number(read(r).amount) || 0);
  const locale = state.settings.locale;

  const totals = new Map<string, Cents>();
  for (const r of records) {
    const p = periodOf(String(read(r)[dateKey] ?? ''));
    totals.set(p, (totals.get(p) ?? 0) + amount(r));
  }

  const out: preact.JSX.Element[] = [];
  let current: string | null = null;
  for (const r of records) {
    const p = periodOf(String(read(r)[dateKey] ?? ''));
    if (p !== current) {
      current = p;
      out.push(
        <tr class="group-row" key={`group-${p}`}>
          <td colSpan={colspan}>
            <span>{p ? periodLabel(p, locale) : 'No date'}</span>
            <span class="group-total num">{formatMoney(totals.get(p) ?? 0, state.settings)}</span>
          </td>
        </tr>
      );
    }
    out.push(row(r));
  }
  return out;
}
