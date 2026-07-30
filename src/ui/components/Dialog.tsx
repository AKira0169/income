/* ui/components/Dialog.tsx — the modal editor for one existing record.

   A native <dialog> opened with showModal(), so focus trapping, the backdrop
   and Escape are the browser's rather than ours. It is rendered only while
   something is being edited, which is what makes the escape hatches — Escape,
   the backdrop, Cancel — all end in the same place: onClose.

   It builds its own <form> rather than using <Form>, because the heading has to
   come above the fields and the fields have to sit inside the scrolling
   .dialog-body. The reading is the same function either way. */

import { useLayoutEffect, useRef } from 'preact/hooks';
import type { AppState } from '../../domain/types.ts';
import type { FieldSpec } from '../fields.ts';
import { FormGrid, readForm } from './Form.tsx';
import type { Editable, FormData } from './Form.tsx';

export interface EditorProps {
  title: string;
  fields: readonly FieldSpec[];
  /** The record being edited. An add-editor is handed a literal with no id, so
      upsert() inserts rather than updating. */
  record: Editable;
  state: AppState;
  onSave: (data: FormData) => void;
  onInvalid?: () => void;
  onClose: () => void;
}

export function Editor({ title, fields, record, state, onSave, onInvalid, onClose }: EditorProps) {
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    node.showModal();
    node.querySelector<HTMLElement>('input:not([type="hidden"]), select')?.focus();
  }, []);

  const id = (record as { id?: string }).id;

  return (
    <dialog ref={dialog} onClose={onClose} onCancel={onClose}>
      <form
        method="dialog"
        onSubmit={(e: Event) => {
          e.preventDefault();
          const data = readForm(e.currentTarget as HTMLFormElement, fields);
          if (!data) { onInvalid?.(); return; }
          // Editing keeps the record's id; an "add" editor was handed a literal
          // without one, so this leaves the field undefined.
          onSave({ ...data, id });
          onClose();
        }}
      >
        <div class="dialog-head">{title}</div>
        <div class="dialog-body">
          <FormGrid fields={fields} record={record} state={state} />
        </div>
        <div class="dialog-foot">
          <button type="button" onClick={onClose}>Cancel</button>
          <button class="primary" type="submit">Save changes</button>
        </div>
      </form>
    </dialog>
  );
}
