/* ui/tabs/Purchases.tsx — one-off spending. */

import { useState } from 'preact/hooks';
import { countWithCorrections, formatMoney } from '../../domain/money.ts';
import { periodLabel } from '../../domain/period.ts';
import { isAdjustment } from '../../domain/reconcile.ts';
import { sortByDateDesc } from '../../domain/records.ts';
import { purchasesIn, sum } from '../../domain/selectors.ts';
import { remove, upsert } from '../../state/actions.ts';
import { app } from '../../state/app.ts';
import { period as routePeriod } from '../../state/route.ts';
import type { Purchase } from '../../domain/types.ts';
import { Editor } from '../components/Dialog.tsx';
import { ScopeToggle } from '../components/ScopeToggle.tsx';
import { AddSection, Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { AccountCell, EmptyRow, listRows, RowActions, Table } from '../components/Table.tsx';
import { confirmDelete, followDate } from '../feedback.ts';
import { toast } from '../components/Toast.tsx';
import { FIELDS } from '../fields.ts';

const COLUMNS = 7;

const HEADERS = [
  { label: 'Date' }, { label: 'Item' }, { label: 'Category' }, { label: 'Amount', num: true },
  { label: 'Account' }, { label: 'Notes' }, { label: '', actions: true }
];

export function Purchases() {
  const state = app.value;
  const period = routePeriod.value;
  const [allTime, setAllTime] = useState(false);
  const [editing, setEditing] = useState<Purchase | null>(null);

  const records = sortByDateDesc(allTime ? state.purchases : purchasesIn(state, period), 'date');
  const total = sum(records, (r) => r.amount);
  const corrections = records.filter(isAdjustment).length;
  const money = (cents: number): string => formatMoney(cents, state.settings);
  const label = periodLabel(period, state.settings.locale);

  const row = (r: Purchase) => (
    <tr key={r.id}>
      <td class="num">{r.date}</td>
      <td>
        <div>{r.item}</div>
        {/* Written by the app rather than typed in: reconciling this account
            found spending that had happened and was never entered. */}
        {isAdjustment(r) ? <span class="cell-sub">Correction</span> : null}
      </td>
      <td class="muted">{r.category}</td>
      <td class="num">{money(r.amount)}</td>
      <AccountCell record={r} state={state} />
      <td class="truncate muted" title={r.notes || ''}>{r.notes || ''}</td>
      <RowActions
        onEdit={() => setEditing(r)}
        onDelete={() => { if (confirmDelete('purchase')) remove('purchases', r.id); }}
      />
    </tr>
  );

  return (
    <div class="stack">
      <AddSection
        title="Purchases"
        addLabel="Add purchase"
        fields={FIELDS.purchase}
        state={state}
        forceOpen={!records.length}
        onInvalid={() => toast('Fill in the required fields')}
        onSubmit={(data) => {
          upsert('purchases', data);
          followDate(String(data.date ?? ''), 'Purchase added');
        }}
      />

      <Sheet>
        <SheetHead>
          <h2>{allTime ? 'All purchases' : label}</h2>
          <span class="muted">{countWithCorrections(records.length, corrections, 'item')}</span>
          <div class="spacer"><ScopeToggle allTime={allTime} onChange={setAllTime} /></div>
          <span class="num">{money(total)}</span>
        </SheetHead>
        <SheetBody flush>
          <Table headers={HEADERS}>
            {records.length
              ? listRows({ records, dateKey: 'date', colspan: COLUMNS, row, grouped: allTime, state })
              : (
                <EmptyRow
                  colspan={COLUMNS}
                  title={allTime ? 'Nothing bought yet' : `Nothing bought in ${label}`}
                  hint="Groceries, fuel, clothes — anything that is not a recurring bill."
                />
              )}
          </Table>
        </SheetBody>
      </Sheet>

      {editing ? (
        <Editor
          title="Edit purchase"
          fields={FIELDS.purchase}
          record={editing}
          state={state}
          onInvalid={() => toast('Fill in the required fields')}
          onSave={(data) => { upsert('purchases', data); toast('Saved'); }}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
