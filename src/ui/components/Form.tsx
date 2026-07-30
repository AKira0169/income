/* ui/components/Form.tsx — the form engine every editor and add-panel uses.

   INVARIANT: these forms are uncontrolled, and every initial value goes in
   through `defaultValue` / `defaultChecked` / `<option selected>` — never
   `value` or `checked`.

   Preact rewrites a `value` prop on every render. A form that renders
   `value={initial}` while still reading the DOM on submit therefore eats what
   the user typed the moment anything else re-renders the page — and something
   always does: the gold price arrives from the network a second after boot, a
   save elsewhere replaces the state, a toast comes and goes. The browser suite
   cannot catch it, because it sets a value and submits in the same tick.

   Reading is by name off the form element rather than through refs. Every
   control already carries `name` — the browser suite selects on it — so
   form.elements is the shortest path from "what is on screen" to "what to
   save", and there is no second copy of the values to fall out of step. */

import { parseMoney } from '../../domain/money.ts';
import type { AppState } from '../../domain/types.ts';
import type { FieldSpec } from '../fields.ts';
import { Field } from './Field.tsx';

export type FormData = Record<string, unknown>;

/** A record on its way into a form. Domain types are interfaces, which carry no
    index signature, so fields are read through one widening cast here instead
    of at every screen that opens an editor. */
export type Editable = object;

const fieldsOf = (record: Editable | null | undefined): Record<string, unknown> =>
  (record ?? {}) as Record<string, unknown>;

/** Reads every declared field off the form. Returns null when a required field
    is empty, which is the caller's cue to say so rather than save a hole. */
export function readForm(form: HTMLFormElement, fields: readonly FieldSpec[]): FormData | null {
  const out: FormData = {};
  let valid = true;

  for (const spec of fields) {
    const control = form.elements.namedItem(spec.key);
    if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement)) continue;

    if (spec.type === 'checkbox') {
      out[spec.key] = (control as HTMLInputElement).checked;
      continue;
    }
    const raw = control.value;
    if (spec.type === 'money') {
      out[spec.key] = parseMoney(raw);
      if (spec.required && !raw.trim()) valid = false;
    } else if (spec.type === 'number') {
      out[spec.key] = raw.trim() === '' ? null : Number(raw);
    } else {
      const trimmed = raw.trim();
      out[spec.key] = trimmed;
      if (spec.required && !trimmed) valid = false;
    }
  }
  return valid ? out : null;
}

export interface FormGridProps {
  fields: readonly FieldSpec[];
  /** The record being edited, or nothing for an add-form. */
  record?: Editable | null;
  state: AppState;
  /** Rendered under the grid — the buttons, and anything else conditional. */
  children?: preact.ComponentChildren;
}

/** Just the grid of fields, for a form that supplies its own <form> element. */
export function FormGrid({ fields, record, state }: FormGridProps) {
  const source = fieldsOf(record);
  return (
    <div class="form-grid">
      {fields.map((spec) => (
        <Field key={spec.key} spec={spec} value={source[spec.key]} state={state} />
      ))}
    </div>
  );
}

export interface FormProps extends FormGridProps {
  /** Given the read values. Not called when a required field is empty. */
  onSubmit: (data: FormData) => void;
  /** Said when a required field is empty. */
  onInvalid?: () => void;
  /** Any control changing. For a form whose shape depends on one of its own
      answers — "from account" only means anything for a transfer. */
  onChange?: (e: Event) => void;
}

export function Form({ fields, record, state, onSubmit, onInvalid, onChange, children }: FormProps) {
  return (
    <form
      onChange={onChange}
      onSubmit={(e: Event) => {
        e.preventDefault();
        const data = readForm(e.currentTarget as HTMLFormElement, fields);
        if (!data) { onInvalid?.(); return; }
        onSubmit(data);
      }}
    >
      <FormGrid fields={fields} record={record} state={state} />
      {children}
    </form>
  );
}
