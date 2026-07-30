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
  /** Unfolded regardless — a screen with nothing on it yet has nothing to
      de-clutter, and the form is the only thing worth showing. */
  forceOpen?: boolean;
}

export function AddSection({
  title, addLabel, fields, state, onSubmit, onInvalid, summary, forceOpen
}: AddSectionProps) {
  const [asked, setAsked] = useState(false);
  /* Bumped after each save. It is the form's key, so the fields are remounted
     from their defaults — the panel stays open and empty, ready for the next
     entry, which is what the old rebuild-everything draw did by accident. */
  const [generation, setGeneration] = useState(0);
  const open = asked || !!forceOpen;

  return (
    <Sheet>
      <SheetHead>
        <h2>{title}</h2>
        {summary}
        <div class="spacer" />
        <button
          class={open ? 'quiet' : 'primary'}
          aria-expanded={open ? 'true' : 'false'}
          onClick={() => setAsked(!asked)}
        >{open ? 'Cancel' : addLabel}</button>
      </SheetHead>
      {open ? (
        <div class="disclosure-body">
          <Form
            key={generation} fields={fields} state={state} onInvalid={onInvalid}
            onSubmit={(data) => { onSubmit(data); setGeneration(generation + 1); }}
          >
            <div class="btn-row" style="margin-top:16px">
              <button class="primary" type="submit">{addLabel}</button>
              <button type="button" onClick={() => setAsked(false)}>Close</button>
            </div>
          </Form>
        </div>
      ) : null}
    </Sheet>
  );
}
