/* ui/components/Field.tsx — one labelled control, from one field spec.

   Read the invariant at the top of Form.tsx before changing anything here: the
   initial value goes in as `defaultValue`, `defaultChecked` or a `selected`
   option, and nothing in this file ever writes `value` or `checked`. */

import { useId } from 'preact/hooks';
import { toMajor } from '../../domain/money.ts';
import type { AppState } from '../../domain/types.ts';
import type { FieldSpec } from '../fields.ts';
import { DatePicker } from './DatePicker.tsx';

interface Option { value: string; label: string }

/* Selects are built from {value,label} pairs so an account can show its name
   while storing its id, without a second pass to relabel the options. */
const toOptions = (
  values: readonly string[] = [],
  labels?: Readonly<Record<string, string>>
): Option[] => values.map((v) => ({ value: v, label: labels?.[v] ?? v }));

function accountOptions(spec: FieldSpec, state: AppState): Option[] {
  const list: Option[] = state.accounts.map((a) => ({ value: a.id, label: a.name }));
  if (!spec.required) {
    list.unshift({ value: '', label: list.length ? '— not linked —' : '— no accounts yet —' });
  }
  return list;
}

const resolveDefault = (def: unknown, state: AppState): unknown =>
  (typeof def === 'function' ? (def as (s: AppState) => unknown)(state) : def);

export interface FieldProps {
  spec: FieldSpec;
  /** The stored value, if this form is editing something. */
  value: unknown;
  state: AppState;
}

export function Field({ spec, value, state }: FieldProps) {
  const id = useId();
  const given = value !== undefined && value !== null && value !== '';
  const fallback = resolveDefault(spec.def, state);
  const required = spec.required ? true : undefined;

  let control: preact.JSX.Element;
  /* The date field carries its value on a hidden input, so its label has to
     point at the visible text box rather than at the named control. */
  let labelFor = id;

  if (spec.type === 'select' || spec.type === 'account') {
    const options = spec.type === 'account'
      ? accountOptions(spec, state)
      : toOptions(spec.options, spec.labels);
    /* Option values are always strings; a karat read back from SQLite is a
       number, and would otherwise look like an unknown option. */
    const initial = given ? String(value) : String(fallback ?? '');
    /* A category that has since been renamed away must still show, or editing
       an old record would silently retype it. */
    const extra = initial && !options.some((o) => o.value === initial)
      ? [{ value: initial, label: initial }]
      : [];

    control = (
      <select id={id} name={spec.key} required={required}>
        {[...extra, ...options].map((o) => (
          <option key={o.value} value={o.value} selected={o.value === initial}>{o.label}</option>
        ))}
      </select>
    );
  } else if (spec.type === 'date') {
    labelFor = `${id}-text`;
    control = (
      <DatePicker
        id={`${id}-text`}
        name={spec.key}
        label={spec.label}
        required={spec.required}
        initial={given ? String(value) : String(fallback ?? '')}
        locale={state.settings.locale}
      />
    );
  } else if (spec.type === 'money') {
    control = (
      <input
        id={id} name={spec.key} type="text" inputMode="decimal" required={required}
        placeholder={spec.placeholder ?? '0.00'}
        defaultValue={given ? toMajor(Number(value)).toFixed(2) : ''}
      />
    );
  } else if (spec.type === 'number') {
    control = (
      <input
        id={id} name={spec.key} type="number" required={required}
        step={spec.step ?? 'any'} min={spec.min}
        placeholder={spec.placeholder ?? ''}
        defaultValue={value === undefined || value === null ? '' : String(value)}
      />
    );
  } else if (spec.type === 'checkbox') {
    control = (
      <input
        id={id} name={spec.key} type="checkbox"
        defaultChecked={value === undefined ? spec.def !== false : !!value}
      />
    );
  } else {
    control = (
      <input
        id={id} name={spec.key} type="text" required={required}
        placeholder={spec.placeholder ?? ''}
        defaultValue={given ? String(value) : String(fallback ?? '')}
      />
    );
  }

  return (
    <div class={`field${spec.wide ? ' wide' : ''}`}>
      <label for={labelFor}>{spec.label}</label>
      {control}
    </div>
  );
}
