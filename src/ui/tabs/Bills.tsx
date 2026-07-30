/* ui/tabs/Bills.tsx — the monthly job: what is due, and what you actually paid.

   Amount and units are editable straight in the table. When the real bill
   arrives you are correcting one number, and opening a dialog to do that would
   be the slowest possible way to record it.

   This is the tab the rewrite was for. The old draw() cleared #app and rebuilt
   it on every write, so committing an inline edit destroyed the input you were
   typing in — Enter was special-cased to blur() first just to make it less
   jarring. Preact diffs instead, so the row updates around the field and the
   focus, the caret and the scroll position all stay where they were. */

import { useState } from 'preact/hooks';
import { METERED } from '../../domain/catalog.ts';
import { formatMoney, parseMoney, plural, toMajor } from '../../domain/money.ts';
import { dueDateFor, monthlyEquivalent, periodLabel, todayISO } from '../../domain/period.ts';
import { accountName, billsIn, lastAccountFor, sum } from '../../domain/selectors.ts';
import { billIsOverdue } from '../../domain/recurring.ts';
import { generateBills, linkGeneratedTo, remove, upsert } from '../../state/actions.ts';
import { app } from '../../state/app.ts';
import { period as routePeriod } from '../../state/route.ts';
import type { Bill, BillTemplate } from '../../domain/types.ts';
import { Editor } from '../components/Dialog.tsx';
import { RecurringSection } from '../components/RecurringSection.tsx';
import { ScopeToggle } from '../components/ScopeToggle.tsx';
import { Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { EmptyRow, listRows, RowActions, Table } from '../components/Table.tsx';
import { toast } from '../components/Toast.tsx';
import { confirmDelete } from '../feedback.ts';
import { FIELDS } from '../fields.ts';

const COLUMNS = 8;

const HEADERS = [
  { label: 'Bill' }, { label: 'Category' }, { label: 'Due' }, { label: 'Amount', num: true },
  { label: 'Units', num: true }, { label: 'Unit' }, { label: 'Status' }, { label: '', actions: true }
];

const TEMPLATE_HEADERS = [
  { label: 'Bill' }, { label: 'Category' }, { label: 'Provider' }, { label: 'How often' },
  { label: 'Due day', num: true }, { label: 'Typical', num: true }, { label: 'Per month', num: true },
  { label: 'Status' }, { label: '', actions: true }
];

interface InlineProps {
  value: string;
  label: string;
  onCommit: (raw: string) => void;
  width?: string;
  placeholder?: string;
}

/* Uncontrolled, and committed on `change` — which is to say on blur or Enter,
   not on every keystroke. Enter blurs rather than submitting anything, because
   there is no form here to submit. */
function InlineNumber({ value, label, onCommit, width, placeholder }: InlineProps) {
  return (
    <input
      type="text" inputMode="decimal" aria-label={label}
      style={`width:${width ?? '90px'};text-align:right;padding:4px 8px`}
      placeholder={placeholder ?? ''}
      defaultValue={value}
      onChange={(e) => onCommit((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
      }}
    />
  );
}

function emptyHint(all: boolean, hasTemplates: boolean): string {
  if (all) return 'Every bill you record, in any month, is listed here.';
  return hasTemplates
    ? 'Nothing is due from your recurring bills this month.'
    : 'Set your bills up once below — electricity, water, internet — and each month fills itself in.';
}

export function Bills() {
  const state = app.value;
  const period = routePeriod.value;
  const [allTime, setAllTime] = useState(false);
  const [editing, setEditing] = useState<Bill | 'new' | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<BillTemplate | null>(null);

  // Newest first when reading history, soonest first when working a month.
  const bills = (allTime ? state.bills.slice() : billsIn(state, period).slice()).sort((a, b) =>
    allTime
      ? String(b.dueDate).localeCompare(String(a.dueDate))
      : String(a.dueDate).localeCompare(String(b.dueDate)));

  const total = sum(bills, (b) => b.amount);
  const paid = sum(bills.filter((b) => b.status === 'paid'), (b) => b.amount);
  const templates = state.billTemplates;
  const money = (cents: number): string => formatMoney(cents, state.settings);
  const label = periodLabel(period, state.settings.locale);

  const row = (b: Bill) => {
    const unit = METERED[b.category];
    const overdue = billIsOverdue(b);
    const sub = [b.provider || '', b.accountId ? `from ${accountName(state, b.accountId)}` : '']
      .filter(Boolean).join(' · ');

    return (
      <tr key={b.id}>
        <td>
          <div>{b.name}</div>
          {sub ? <span class="cell-sub">{sub}</span> : null}
        </td>
        <td class="muted">{b.category}</td>
        <td class="num">{b.dueDate || '—'}</td>
        <td class="num">
          <InlineNumber
            value={b.amount ? toMajor(b.amount).toFixed(2) : ''}
            label={`${b.name} amount`}
            onCommit={(raw) => upsert('bills', { id: b.id, amount: parseMoney(raw) })}
          />
        </td>
        <td class="num">
          {unit
            ? (
              <InlineNumber
                value={b.units === null || b.units === undefined ? '' : String(b.units)}
                label={`${b.name} units used`}
                width="72px"
                placeholder={unit}
                onCommit={(raw) => upsert('bills', { id: b.id, units: raw.trim() === '' ? null : Number(raw) })}
              />
            )
            : <span class="faint">—</span>}
        </td>
        <td class="muted">{unit || ''}</td>
        <td>
          <span class={`status ${b.status === 'paid' ? 'paid' : (overdue ? 'overdue' : 'due')}`}>
            {b.status === 'paid' ? 'Paid' : (overdue ? 'Overdue' : 'Unpaid')}
          </span>
        </td>
        <td class="actions">
          <button
            class="quiet small"
            onClick={() => upsert('bills', b.status === 'paid'
              ? { id: b.id, paidDate: '' }
              : { id: b.id, paidDate: todayISO() })}
          >{b.status === 'paid' ? 'Unpay' : 'Mark paid'}</button>
          <button class="quiet small" onClick={() => setEditing(b)}>Edit</button>
          <button
            class="quiet small danger"
            onClick={() => { if (confirmDelete('bill')) remove('bills', b.id); }}
          >Delete</button>
        </td>
      </tr>
    );
  };

  const templateRow = (t: BillTemplate) => (
    <tr key={t.id}>
      <td>
        <div>{t.name}</div>
        {t.accountId ? <span class="cell-sub">{`from ${accountName(state, t.accountId)}`}</span> : null}
      </td>
      <td class="muted">{t.category}</td>
      <td class="muted">{t.provider || '—'}</td>
      <td class="muted">{t.frequency || 'Monthly'}</td>
      <td class="num">{t.dueDay || 1}</td>
      <td class="num">{money(t.expected)}</td>
      <td class="num" title="Spread across the year">{money(monthlyEquivalent(t))}</td>
      <td>
        <span class={`status ${t.active ? 'paid' : ''}`}>{t.active ? 'Active' : 'Paused'}</span>
      </td>
      <RowActions
        onEdit={() => setEditingTemplate(t)}
        onDelete={() => { if (confirmDelete('recurring bill')) remove('billTemplates', t.id); }}
      />
    </tr>
  );

  return (
    <div class="stack">
      {/* This month's bills lead, because that is the monthly job. */}
      <Sheet>
        <SheetHead>
          <h2>{allTime ? 'All bills' : label}</h2>
          <span class="muted">{`${money(paid)} paid of ${money(total)}`}</span>
          <div class="spacer"><ScopeToggle allTime={allTime} onChange={setAllTime} /></div>
          {!allTime ? (
            <button
              onClick={() => {
                const made = generateBills(period);
                toast(made ? `Added ${plural(made, 'bill')}` : 'Already up to date');
              }}
            >Generate from recurring</button>
          ) : null}
          <button class="primary" onClick={() => setEditing('new')}>Add bill</button>
        </SheetHead>
        <SheetBody flush>
          <Table headers={HEADERS}>
            {bills.length
              ? listRows({ records: bills, dateKey: 'dueDate', colspan: COLUMNS, row, grouped: allTime, state })
              : (
                <EmptyRow
                  colspan={COLUMNS}
                  title={allTime ? 'No bills recorded yet' : `No bills for ${label}`}
                  hint={emptyHint(allTime, templates.length > 0)}
                />
              )}
          </Table>
        </SheetBody>
      </Sheet>

      <RecurringSection<BillTemplate>
        title="Recurring bills"
        noun="bill"
        collection="billTemplates"
        fields={FIELDS.billTemplate}
        saveLabel="Save recurring bill"
        saved="Recurring bill saved"
        hint={'Set each bill up once here — what it is, how often, and the typical amount. Each new '
          + 'month it appears above on its own; type in the real figure when the bill arrives.'}
        headers={TEMPLATE_HEADERS}
        templates={templates}
        row={templateRow}
        state={state}
        period={period}
      />

      {editing ? (
        <Editor
          title={editing === 'new' ? 'Add bill' : 'Edit bill'}
          fields={FIELDS.bill}
          record={editing === 'new'
            ? {
              templateId: null, name: '', category: 'Other', provider: '',
              dueDate: dueDateFor(period, new Date().getDate()),
              amount: 0, accountId: lastAccountFor(state, 'bills'),
              units: null, unitRate: null, paidDate: '', method: '', notes: ''
            }
            : editing}
          state={state}
          onInvalid={() => toast('Fill in the required fields')}
          /* Period and status are derived from the dates inside upsert(), so
             neither is passed in and neither can be forgotten. */
          onSave={(data) => { upsert('bills', data); toast('Saved'); }}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {editingTemplate ? (
        <Editor
          title="Edit recurring bill" fields={FIELDS.billTemplate} record={editingTemplate} state={state}
          onInvalid={() => toast('Fill in the required fields')}
          onSave={(data) => {
            const linked = linkGeneratedTo('billTemplates', upsert('billTemplates', data));
            toast(linked
              ? `Saved · ${plural(linked, 'past bill')} linked to ${accountName(app.peek(), String(data.accountId ?? ''))}`
              : 'Saved');
          }}
          onClose={() => setEditingTemplate(null)}
        />
      ) : null}
    </div>
  );
}
