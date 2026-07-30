/* ui/forms.ts — the form engine every editor and add-panel is built from.

   A form is declared as a list of field specs and read back as a plain object,
   so a screen never touches an input directly. */

import { el } from '../dom.ts';
import * as DatePicker from '../datepicker.ts';
import {
  byId, catchUp, isSavingsAccount, linkGeneratedTo, monthlyEquivalent, parseMoney,
  plural, state, sum, toMajor, upsert
} from '../store.ts';
import type { MonthlyEquivalentInput } from '../store.ts';
import type { CollectionKey, Id } from '../types.ts';
import { toast } from './feedback.ts';
import { money } from './format.ts';
import { table } from './tables.ts';
import type { Header } from './tables.ts';
import { isOpen, render, toggle, view } from './view.ts';

export type FieldType = 'text' | 'select' | 'account' | 'date' | 'money' | 'number' | 'checkbox';

export interface FieldSpec {
  key: string;
  label: string;
  /** Defaults to a plain text input. */
  type?: FieldType;
  required?: boolean;
  /** Spans both columns of the form grid. */
  wide?: boolean;
  placeholder?: string;
  options?: readonly string[];
  /** Display labels for option values, e.g. `21` -> `21k — usual here`. */
  labels?: Readonly<Record<string, string>>;
  /** A literal, or a function evaluated when the form is built. */
  def?: unknown;
  min?: number;
  step?: string | number;
}

export type FormData = Record<string, unknown>;

/** A record on its way into a form. Domain types are interfaces, which carry no
    index signature, so fields are read through one widening cast here instead
    of at every screen that opens an editor. */
export type Editable = object;

const fieldsOf = (record: Editable | null | undefined): Record<string, unknown> =>
  (record ?? {}) as Record<string, unknown>;

export interface Form {
  node: HTMLDivElement;
  /** The values, or null when a required field is empty. */
  read(): FormData | null;
  focusFirst(): void;
}

interface Option { value: string; label: string }

/* Selects are built from {value,label} pairs so an account can show its name
   while storing its id, without a second pass to relabel the options. */
const toOptions = (values: readonly string[] = [], labels?: Readonly<Record<string, string>>): Option[] =>
  values.map((v) => ({ value: v, label: labels?.[v] ?? v }));

function accountOptions(spec: FieldSpec): Option[] {
  const list: Option[] = state.accounts.map((a) => ({ value: a.id, label: a.name }));
  if (!spec.required) {
    list.unshift({ value: '', label: list.length ? '— not linked —' : '— no accounts yet —' });
  }
  return list;
}

/** The account you last used for this kind of record. Nearly every entry goes
    to the same place as the one before it, so this is the right default. */
export function lastAccountFor(collection: CollectionKey): Id | '' {
  const list = state[collection] as ReadonlyArray<{ accountId?: Id | '' }>;
  for (let i = list.length - 1; i >= 0; i--) {
    const id = list[i]?.accountId;
    if (id && byId('accounts', id)) return id;
  }
  return state.accounts[0]?.id ?? '';
}

/** Where money put aside tends to go: the first savings-type account. */
export function defaultSavingsAccount(): Id | '' {
  const pot = state.accounts.find(isSavingsAccount) ?? state.accounts[0];
  return pot?.id ?? '';
}

const resolveDefault = (def: unknown): unknown => (typeof def === 'function' ? def() : def);

let fieldSeq = 0;
const nextFieldId = (key: string): string => `f_${key}_${++fieldSeq}`;

export function buildForm(fields: readonly FieldSpec[], record?: Editable | null): Form {
  const inputs = new Map<string, { control: HTMLInputElement | HTMLSelectElement; spec: FieldSpec }>();
  const grid = el('div', { class: 'form-grid' });
  const source = fieldsOf(record);

  for (const f of fields) {
    const value = source[f.key];
    const id = nextFieldId(f.key);
    const fallback = resolveDefault(f.def);
    const given = value !== undefined && value !== null && value !== '';

    let control: HTMLInputElement | HTMLSelectElement;
    let mount: HTMLElement | null = null;

    if (f.type === 'select' || f.type === 'account') {
      const options = f.type === 'account' ? accountOptions(f) : toOptions(f.options, f.labels);
      const select = el('select', { name: f.key },
        options.map((o) => el('option', { value: o.value, text: o.label })));
      /* Option values are always strings; a karat read back from SQLite is a
         number, and would otherwise look like an unknown option. */
      const initial = given ? String(value) : String(fallback ?? '');
      /* A category that has since been renamed away must still show, or editing
         an old record would silently retype it. */
      if (initial && !options.some((o) => o.value === initial)) {
        select.appendChild(el('option', { value: initial, text: initial }));
      }
      select.value = initial || (options[0]?.value ?? '');
      control = select;
    } else if (f.type === 'date') {
      const picker = DatePicker.create({
        value: given ? String(value) : String(fallback ?? ''),
        id, name: f.key, required: f.required, label: f.label
      });
      control = picker.value;
      mount = picker.node;
    } else if (f.type === 'money') {
      control = el('input', {
        name: f.key, type: 'text', inputmode: 'decimal', placeholder: f.placeholder ?? '0.00',
        value: given ? toMajor(Number(value)).toFixed(2) : ''
      });
    } else if (f.type === 'number') {
      control = el('input', {
        name: f.key, type: 'number', step: f.step ?? 'any', min: f.min,
        placeholder: f.placeholder ?? '',
        value: value === undefined || value === null ? '' : String(value)
      });
    } else if (f.type === 'checkbox') {
      const box = el('input', { name: f.key, type: 'checkbox' });
      box.checked = value === undefined ? (f.def !== false) : !!value;
      control = box;
    } else {
      control = el('input', {
        name: f.key, type: 'text',
        placeholder: f.placeholder ?? '',
        value: given ? String(value) : String(fallback ?? '')
      });
    }

    if (f.required) control.setAttribute('required', '');
    /* The date field keeps its value on a hidden input, so the label points at
       the visible one the picker already carries the id on. */
    if (!mount) control.setAttribute('id', id);

    inputs.set(f.key, { control, spec: f });
    grid.appendChild(el('div', { class: `field${f.wide ? ' wide' : ''}` }, [
      el('label', { for: id, text: f.label }),
      mount ?? control
    ]));
  }

  function read(): FormData | null {
    const out: FormData = {};
    let valid = true;

    for (const [key, { control, spec }] of inputs) {
      if (spec.type === 'checkbox') {
        out[key] = (control as HTMLInputElement).checked;
        continue;
      }
      const raw = control.value;
      if (spec.type === 'money') {
        out[key] = parseMoney(raw);
        if (spec.required && !raw.trim()) valid = false;
      } else if (spec.type === 'number') {
        out[key] = raw.trim() === '' ? null : Number(raw);
      } else {
        const trimmed = raw.trim();
        out[key] = trimmed;
        if (spec.required && !trimmed) valid = false;
      }
    }
    return valid ? out : null;
  }

  function focusFirst(): void {
    grid.querySelector<HTMLElement>('input:not([type="hidden"]), select')?.focus();
  }

  return { node: grid, read, focusFirst };
}

/* ------------------------------------------------------------- containers */

/** An add-form that stays folded away until asked for. This is the main
    de-cluttering move: every tab opens on your data, not on a blank form. */
export function addSection(
  key: string,
  title: string,
  addLabel: string,
  fields: readonly FieldSpec[],
  onSubmit: (data: FormData) => void,
  forceOpen = false
): HTMLElement {
  const open = isOpen(key) || forceOpen;
  const form = open ? buildForm(fields, null) : null;

  return el('section', { class: 'sheet' }, [
    el('div', { class: 'sheet-head' }, [
      el('h2', { text: title }),
      el('div', { class: 'spacer' }),
      el('button', {
        class: open ? 'quiet' : 'primary',
        'aria-expanded': open ? 'true' : 'false',
        text: open ? 'Cancel' : addLabel,
        onclick: () => toggle(key)
      })
    ]),
    open && form ? el('div', { class: 'disclosure-body' }, [
      el('form', {
        onsubmit: (e: Event) => {
          e.preventDefault();
          const data = form.read();
          if (!data) { toast('Fill in the required fields'); return; }
          onSubmit(data);
          render();
        }
      }, [
        form.node,
        el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
          el('button', { class: 'primary', type: 'submit', text: addLabel }),
          el('button', { type: 'button', text: 'Close', onclick: () => toggle(key) })
        ])
      ])
    ]) : null
  ]);
}

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

export interface RecurringConfig<T> {
  key: string;
  title: string;
  noun: string;
  hint: string;
  saved: string;
  saveLabel: string;
  collection: 'incomeTemplates' | 'billTemplates';
  templates: readonly T[];
  headers: readonly Header[];
  fields: readonly FieldSpec[];
  row: (template: T) => HTMLTableRowElement;
}

/** The "set it once" panel, shared by income and bills. Recurring definitions
    are edited rarely, so it stays folded away behind its own summary line. */
export function recurringSection<T extends MonthlyEquivalentInput & { active: boolean }>(
  cfg: RecurringConfig<T>
): HTMLElement {
  const open = isOpen(cfg.key);
  const perMonth = sum(cfg.templates.filter((t) => t.active), monthlyEquivalent);
  const form = open ? buildForm(cfg.fields, null) : null;

  return el('section', { class: 'sheet' }, [
    el('div', { class: 'sheet-head' }, [
      el('h2', { text: cfg.title }),
      el('span', {
        class: 'muted spacer',
        text: cfg.templates.length
          ? `${plural(cfg.templates.length, cfg.noun)} · ${money(perMonth)} a month`
          : 'none set up yet'
      }),
      el('button', {
        'aria-expanded': open ? 'true' : 'false',
        text: open ? 'Hide' : (cfg.templates.length ? 'Show' : 'Set up'),
        onclick: () => toggle(cfg.key)
      })
    ]),
    open && form ? el('div', { class: 'sheet-body flush' }, [
      cfg.templates.length ? table(cfg.headers, cfg.templates.map(cfg.row)) : null,
      el('div', { class: 'disclosure-body' }, [
        el('p', { class: 'muted', style: 'margin-top:0' }, cfg.hint),
        el('form', {
          onsubmit: (e: Event) => {
            e.preventDefault();
            const data = form.read();
            if (!data) { toast('Fill in the required fields'); return; }
            // The month on screen is where this commitment starts; nothing is
            // ever generated before it.
            data.anchor = view.period;
            data.generatedThrough = null;
            const template = upsert(cfg.collection, data);
            const linked = linkGeneratedTo(cfg.collection, template);
            const added = catchUp();
            render();
            toast(templateToast(cfg.saved, added.total, linked));
          }
        }, [
          form.node,
          el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
            el('button', { class: 'primary', type: 'submit', text: cfg.saveLabel })
          ])
        ])
      ])
    ]) : null
  ]);
}

/** A modal editor for one existing record. `onSave` may return a message when
    the save did more than save. */
export function openEditor(
  title: string,
  fields: readonly FieldSpec[],
  record: Editable,
  onSave: (data: FormData) => string | void,
  afterBuild?: (dialog: HTMLDialogElement) => void
): void {
  const form = buildForm(fields, record);
  const dialog = el('dialog', {}, [
    el('form', {
      method: 'dialog',
      onsubmit: (e: Event) => {
        e.preventDefault();
        const data = form.read();
        if (!data) { toast('Fill in the required fields'); return; }
        // Editing keeps the record's id; an "add" editor is handed a literal
        // without one, so this leaves the field undefined and upsert() inserts.
        data.id = fieldsOf(record).id;
        const message = onSave(data);
        dialog.close();
        dialog.remove();
        render();
        toast(typeof message === 'string' && message ? message : 'Saved');
      }
    }, [
      el('div', { class: 'dialog-head', text: title }),
      el('div', { class: 'dialog-body' }, [form.node]),
      el('div', { class: 'dialog-foot' }, [
        el('button', {
          type: 'button', text: 'Cancel',
          onclick: () => { dialog.close(); dialog.remove(); }
        }),
        el('button', { class: 'primary', type: 'submit', text: 'Save changes' })
      ])
    ])
  ]);

  document.body.appendChild(dialog);
  afterBuild?.(dialog);
  dialog.showModal();
  form.focusFirst();
}

/* "From" only means anything for a transfer, so it is hidden otherwise rather
   than left on screen collecting a value nobody asked for. */
export function wireMovementForm(scope: ParentNode | null | undefined): void {
  if (!scope) return;
  const direction = scope.querySelector<HTMLSelectElement>('select[name="direction"]');
  const from = scope.querySelector<HTMLSelectElement>('select[name="fromAccountId"]');
  const to = scope.querySelector<HTMLSelectElement>('select[name="accountId"]');
  if (!direction || !from || !to) return;

  const fromField = from.closest<HTMLElement>('.field');
  const toLabel = to.closest('.field')?.querySelector('label');

  const sync = (): void => {
    const isTransfer = direction.value === 'transfer';
    if (fromField) fromField.style.display = isTransfer ? '' : 'none';
    if (toLabel) toLabel.textContent = direction.value === 'out' ? 'From account' : 'To account';
  };
  direction.addEventListener('change', sync);
  sync();
}
