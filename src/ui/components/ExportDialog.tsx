/* ui/components/ExportDialog.tsx — choosing what goes into the workbook. */

import { useLayoutEffect, useRef } from 'preact/hooks';
import { periodLabel } from '../../domain/period.ts';
import { snapshot } from '../../state/app.ts';
import { build, filename } from '../../workbook/build.ts';
import type { Scope } from '../../workbook/build.ts';
import type { Period, Settings } from '../../domain/types.ts';
import { download } from '../feedback.ts';
import { toast } from './Toast.tsx';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function ExportDialog({ period, settings, onClose }: {
  period: Period;
  settings: Settings;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const choice = useRef<HTMLSelectElement>(null);
  const year = period.slice(0, 4);

  useLayoutEffect(() => { dialog.current?.showModal(); }, []);

  const scopeFor = (value: string): Scope => {
    if (value === 'month') return { type: 'month', period };
    if (value === 'year') return { type: 'year', year };
    return { type: 'all' };
  };

  return (
    <dialog ref={dialog} onClose={onClose} onCancel={onClose}>
      <div class="dialog-head">Export to Excel</div>
      <div class="dialog-body">
        <div class="field">
          <label for="export-scope">What to include</label>
          <select id="export-scope" ref={choice}>
            <option value="month">{`This month — ${periodLabel(period, settings.locale)}`}</option>
            <option value="year">{`This year — ${year}`}</option>
            <option value="all">Everything (all time)</option>
          </select>
        </div>
        <p class="muted">
          One .xlsx workbook: summary, income, bills, recurring bills, purchases, utility meters,
          savings accounts and movements, a month-by-month breakdown and a category breakdown.
          Totals are live formulas.
        </p>
      </div>
      <div class="dialog-foot">
        <button type="button" onClick={onClose}>Cancel</button>
        <button
          class="primary" type="button"
          onClick={() => {
            const scope = scopeFor(choice.current?.value ?? 'all');
            try {
              download(build(snapshot(), scope), filename(scope), XLSX_MIME);
              toast('Workbook downloaded');
            } catch (err) {
              alert(`The export failed.\n\n${err instanceof Error ? err.message : String(err)}`);
            }
            onClose();
          }}
        >Download workbook</button>
      </div>
    </dialog>
  );
}
