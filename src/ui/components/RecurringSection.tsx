/* ui/components/RecurringSection.tsx — the "set it up once" panel, shared by
   Income and Bills.

   Recurring definitions are edited rarely, so the panel stays folded away
   behind its own summary line — how many there are and what they come to a
   month, which is the figure worth seeing without opening anything. */

import { useState } from 'preact/hooks';
import { formatMoney, plural } from '../../domain/money.ts';
import { monthlyEquivalent } from '../../domain/period.ts';
import { sum } from '../../domain/selectors.ts';
import { catchUp, linkGeneratedTo, upsert } from '../../state/actions.ts';
import type { AppState, Period } from '../../domain/types.ts';
import type { FieldSpec } from '../fields.ts';
import { toast } from './Toast.tsx';
import { Form } from './Form.tsx';
import { Sheet, SheetBody, SheetHead } from './Sheet.tsx';
import { Table } from './Table.tsx';
import type { Header } from './Table.tsx';

/* Saving a recurring definition can quietly do two other things — fill in the
   months since it started, and adopt the entries it made before it had an
   account. Both are reported, because a balance that moved on its own is
   alarming when it is not explained. */
function templateToast(saved: string, added: number, linked: number): string {
  const parts = [saved];
  if (added) parts.push(`${plural(added, 'entry', 'entries')} added`);
  if (linked) parts.push(`${plural(linked, 'past entry', 'past entries')} linked`);
  return parts.join(' · ');
}

export interface RecurringSectionProps<T> {
  title: string;
  /** What one of these is called: "source", "bill". */
  noun: string;
  saveLabel: string;
  saved: string;
  hint: string;
  collection: 'incomeTemplates' | 'billTemplates';
  fields: readonly FieldSpec[];
  headers: readonly Header[];
  templates: readonly T[];
  row: (template: T) => preact.JSX.Element;
  state: AppState;
  period: Period;
}

export function RecurringSection<T extends { active: boolean; frequency?: never | string }>(
  props: RecurringSectionProps<T>
) {
  const { title, noun, saveLabel, saved, hint, collection, fields, headers, templates, row, state, period } = props;
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);

  const perMonth = sum(
    templates.filter((t) => t.active),
    (t) => monthlyEquivalent(t as { frequency?: never; expected?: number })
  );

  return (
    <Sheet>
      <SheetHead>
        <h2>{title}</h2>
        <span class="muted spacer">
          {templates.length
            ? `${plural(templates.length, noun)} · ${formatMoney(perMonth, state.settings)} a month`
            : 'none set up yet'}
        </span>
        <button aria-expanded={open ? 'true' : 'false'} onClick={() => setOpen(!open)}>
          {open ? 'Hide' : (templates.length ? 'Show' : 'Set up')}
        </button>
      </SheetHead>
      {open ? (
        <SheetBody flush>
          {templates.length ? <Table headers={headers}>{templates.map(row)}</Table> : null}
          <div class="disclosure-body">
            <p class="muted" style="margin-top:0">{hint}</p>
            <Form
              key={generation}
              fields={fields}
              state={state}
              onInvalid={() => toast('Fill in the required fields')}
              onSubmit={(data) => {
                /* The month on screen is where this commitment starts; nothing
                   is ever generated before it, and the sweep is reset so
                   changing the schedule refills from the anchor. */
                const template = upsert(collection, { ...data, anchor: period, generatedThrough: '' });
                const linked = linkGeneratedTo(collection, template);
                const added = catchUp();
                setGeneration(generation + 1);
                toast(templateToast(saved, added.total, linked));
              }}
            >
              <div class="btn-row" style="margin-top:16px">
                <button class="primary" type="submit">{saveLabel}</button>
              </div>
            </Form>
          </div>
        </SheetBody>
      ) : null}
    </Sheet>
  );
}
