/* ui/components/Sheet.tsx — the ruled panel every screen is made of, and the
   add-form that stays folded away inside it.

   The disclosure is the main de-cluttering move: every tab opens on your data,
   not on a blank form. Whether it is unfolded is component state now — the old
   string-keyed `view.open` map typed silently and outlived the screen. */

import { useState } from 'preact/hooks';
import type { AppState } from '../../domain/types.ts';
import type { FieldSpec } from '../fields.ts';
import { Form } from './Form.tsx';
import type { FormData } from './Form.tsx';

export function Sheet({ children }: { children: preact.ComponentChildren }) {
  return <section class="sheet">{children}</section>;
}

export function SheetHead({ children }: { children: preact.ComponentChildren }) {
  return <div class="sheet-head">{children}</div>;
}

export function SheetBody({ flush, children }: { flush?: boolean; children: preact.ComponentChildren }) {
  return <div class={flush ? 'sheet-body flush' : 'sheet-body'}>{children}</div>;
}

export interface AddSectionProps {
  title: string;
  addLabel: string;
  fields: readonly FieldSpec[];
  state: AppState;
  onSubmit: (data: FormData) => void;
  onInvalid?: () => void;
  /** Shown in the head between the title and the button. */
  summary?: preact.ComponentChildren;
}

export function AddSection({
  title, addLabel, fields, state, onSubmit, onInvalid, summary
}: AddSectionProps) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet>
      <SheetHead>
        <h2>{title}</h2>
        {summary}
        <div class="spacer" />
        <button
          class={open ? 'quiet' : 'primary'}
          aria-expanded={open ? 'true' : 'false'}
          onClick={() => setOpen(!open)}
        >{open ? 'Cancel' : addLabel}</button>
      </SheetHead>
      {open ? (
        <div class="disclosure-body">
          {/* Keyed on `open` so re-opening the panel starts from a clean form
              rather than from whatever was half-typed when it was closed. */}
          <Form
            key="add" fields={fields} state={state} onInvalid={onInvalid}
            onSubmit={(data) => { onSubmit(data); setOpen(false); }}
          >
            <div class="btn-row" style="margin-top:16px">
              <button class="primary" type="submit">{addLabel}</button>
              <button type="button" onClick={() => setOpen(false)}>Close</button>
            </div>
          </Form>
        </div>
      ) : null}
    </Sheet>
  );
}
