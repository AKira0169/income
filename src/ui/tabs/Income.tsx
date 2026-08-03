/* ui/tabs/Income.tsx — one-off income, and the recurring set-up behind it. */

import { useState } from 'preact/hooks';
import { countWithCorrections, formatMoney, plural } from '../../domain/money.ts';
import { monthlyEquivalent, periodLabel } from '../../domain/period.ts';
import { isAdjustment } from '../../domain/reconcile.ts';
import { sortByDateDesc } from '../../domain/records.ts';
import { accountName, incomeIn, sum } from '../../domain/selectors.ts';
import { generateIncome, linkGeneratedTo, remove, upsert } from '../../state/actions.ts';
import { app } from '../../state/app.ts';
import { period as routePeriod } from '../../state/route.ts';
import type { IncomeEntry, IncomeTemplate } from '../../domain/types.ts';
import { Editor } from '../components/Dialog.tsx';
import { RecurringSection } from '../components/RecurringSection.tsx';
import { ScopeToggle } from '../components/ScopeToggle.tsx';
import { AddSection, Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { AccountCell, EmptyRow, listRows, RowActions, Table } from '../components/Table.tsx';
import { toast } from '../components/Toast.tsx';
import { confirmDelete, followDate } from '../feedback.ts';
import { FIELDS } from '../fields.ts';

const COLUMNS = 7;

const HEADERS = [
  { label: 'Date' }, { label: 'Source' }, { label: 'Category' }, { label: 'Amount', num: true },
  { label: 'Account' }, { label: 'Notes' }, { label: '', actions: true }
];

const TEMPLATE_HEADERS = [
  { label: 'Source' }, { label: 'Category' }, { label: 'How often' },
  { label: 'Paid on', num: true }, { label: 'Amount', num: true }, { label: 'Per month', num: true },
  { label: 'Status' }, { label: '', actions: true }
];

function emptyHint(all: boolean, hasTemplates: boolean): string {
  if (all) return 'Everything you add, in any month, is listed here.';
  return hasTemplates
    ? 'Nothing is due from your recurring income this month.'
    : 'Set your salary up once below and it will appear every month on its own.';
}

export function Income() {
  const state = app.value;
  const period = routePeriod.value;
  const [allTime, setAllTime] = useState(false);
  const [editing, setEditing] = useState<IncomeEntry | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<IncomeTemplate | null>(null);

  const records = sortByDateDesc(allTime ? state.income : incomeIn(state, period), 'date');
  const total = sum(records, (r) => r.amount);
  const corrections = records.filter(isAdjustment).length;
  const templates = state.incomeTemplates;
  const money = (cents: number): string => formatMoney(cents, state.settings);
  const label = periodLabel(period, state.settings.locale);

  const row = (r: IncomeEntry) => (
    <tr key={r.id}>
      <td class="num">{r.date}</td>
      <td>
        <div>{r.source}</div>
        {/* Generated rows are marked so you can tell what the app filled in
            from what you entered by hand. A correction is the other kind the
            app writes for you — reconciling this account found money that had
            arrived and was never entered. */}
        {r.templateId ? <span class="cell-sub">Recurring</span> : null}
        {isAdjustment(r) ? <span class="cell-sub">Correction</span> : null}
      </td>
      <td class="muted">{r.category}</td>
      <td class="num">{money(r.amount)}</td>
      <AccountCell record={r} state={state} />
      <td class="truncate muted" title={r.notes || ''}>{r.notes || ''}</td>
      <RowActions
        onEdit={() => setEditing(r)}
        onDelete={() => { if (confirmDelete('income entry')) remove('income', r.id); }}
      />
    </tr>
  );

  const templateRow = (t: IncomeTemplate) => (
    <tr key={t.id}>
      <td>
        <div>{t.source}</div>
        {t.accountId ? <span class="cell-sub">{`into ${accountName(state, t.accountId)}`}</span> : null}
      </td>
      <td class="muted">{t.category}</td>
      <td class="muted">{t.frequency || 'Monthly'}</td>
      <td class="num">{`day ${t.payDay || 1}`}</td>
      <td class="num">{money(t.expected)}</td>
      <td class="num" title="Spread across the year">{money(monthlyEquivalent(t))}</td>
      <td>
        <span class={`status ${t.active ? 'paid' : ''}`}>{t.active ? 'Active' : 'Paused'}</span>
      </td>
      <RowActions
        onEdit={() => setEditingTemplate(t)}
        onDelete={() => { if (confirmDelete('recurring income')) remove('incomeTemplates', t.id); }}
      />
    </tr>
  );

  return (
    <div class="stack">
      <AddSection
        title="One-off income"
        addLabel="Add income"
        fields={FIELDS.income}
        state={state}
        forceOpen={!records.length && !templates.length}
        onInvalid={() => toast('Fill in the required fields')}
        onSubmit={(data) => {
          upsert('income', data);
          followDate(String(data.date ?? ''), 'Income added');
        }}
      />

      <Sheet>
        <SheetHead>
          <h2>{allTime ? 'All income' : label}</h2>
          <span class="muted">
            {countWithCorrections(records.length, corrections, 'entry', 'entries')}
          </span>
          <div class="spacer"><ScopeToggle allTime={allTime} onChange={setAllTime} /></div>
          {!allTime && templates.length ? (
            <button
              onClick={() => {
                const made = generateIncome(period);
                toast(made ? `Added ${plural(made, 'entry', 'entries')}` : 'Already up to date');
              }}
            >Generate from recurring</button>
          ) : null}
          <span class="num">{money(total)}</span>
        </SheetHead>
        <SheetBody flush>
          <Table headers={HEADERS}>
            {records.length
              ? listRows({ records, dateKey: 'date', colspan: COLUMNS, row, grouped: allTime, state })
              : (
                <EmptyRow
                  colspan={COLUMNS}
                  title={allTime ? 'No income recorded yet' : `No income in ${label}`}
                  hint={emptyHint(allTime, templates.length > 0)}
                />
              )}
          </Table>
        </SheetBody>
      </Sheet>

      <RecurringSection<IncomeTemplate>
        title="Recurring income"
        noun="source"
        collection="incomeTemplates"
        fields={FIELDS.incomeTemplate}
        saveLabel="Save recurring income"
        saved="Recurring income saved"
        hint={'Set your salary — or any other regular payment — up once here. Each new month it is '
          + 'entered for you automatically, and you only touch it if the figure changes.'}
        headers={TEMPLATE_HEADERS}
        templates={templates}
        row={templateRow}
        state={state}
        period={period}
      />

      {editing ? (
        <Editor
          title="Edit income" fields={FIELDS.income} record={editing} state={state}
          onInvalid={() => toast('Fill in the required fields')}
          onSave={(data) => { upsert('income', data); toast('Saved'); }}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {editingTemplate ? (
        <Editor
          title="Edit recurring income" fields={FIELDS.incomeTemplate} record={editingTemplate} state={state}
          onInvalid={() => toast('Fill in the required fields')}
          onSave={(data) => {
            const linked = linkGeneratedTo('incomeTemplates', upsert('incomeTemplates', data));
            toast(linked
              ? `Saved · ${plural(linked, 'past entry', 'past entries')} linked to ${accountName(app.peek(), String(data.accountId ?? ''))}`
              : 'Saved');
          }}
          onClose={() => setEditingTemplate(null)}
        />
      ) : null}
    </div>
  );
}
