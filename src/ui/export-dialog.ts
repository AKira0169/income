/* ui/export-dialog.ts — choosing what goes into the workbook. */

import { el } from '../dom.ts';
import { build, filename } from '../export.ts';
import type { Scope } from '../export.ts';
import { periodLabel } from '../store.ts';
import { download, toast } from './feedback.ts';
import { view } from './view.ts';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function openExportDialog(): void {
  const period = view.period;
  const year = period.slice(0, 4);

  const choice = el('select', {}, [
    el('option', { value: 'month', text: `This month — ${periodLabel(period)}` }),
    el('option', { value: 'year', text: `This year — ${year}` }),
    el('option', { value: 'all', text: 'Everything (all time)' })
  ]);

  const scopeFor = (value: string): Scope => {
    if (value === 'month') return { type: 'month', period };
    if (value === 'year') return { type: 'year', year };
    return { type: 'all' };
  };

  const dialog = el('dialog', {}, [
    el('div', { class: 'dialog-head', text: 'Export to Excel' }),
    el('div', { class: 'dialog-body' }, [
      el('div', { class: 'field' }, [el('label', { text: 'What to include' }), choice]),
      el('p', { class: 'muted' },
        'One .xlsx workbook: summary, income, bills, recurring bills, purchases, utility meters, ' +
        'savings accounts and movements, a month-by-month breakdown and a category breakdown. ' +
        'Totals are live formulas.')
    ]),
    el('div', { class: 'dialog-foot' }, [
      el('button', {
        type: 'button', text: 'Cancel',
        onclick: () => { dialog.close(); dialog.remove(); }
      }),
      el('button', {
        class: 'primary', type: 'button', text: 'Download workbook',
        onclick: () => {
          const scope = scopeFor(choice.value);
          try {
            download(build(scope), filename(scope), XLSX_MIME);
            toast('Workbook downloaded');
          } catch (err) {
            alert(`The export failed.\n\n${err instanceof Error ? err.message : String(err)}`);
          }
          dialog.close();
          dialog.remove();
        }
      })
    ])
  ]);

  document.body.appendChild(dialog);
  dialog.showModal();
}
