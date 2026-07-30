/* ui/tabs/Settings.tsx — currency, goals, backup and the danger zone. */

import { useRef, useState } from 'preact/hooks';
import { plural } from '../../domain/money.ts';
import { todayISO } from '../../domain/period.ts';
import { exportBytes, getBackend } from '../../data/sqlite.ts';
import { catchUp, clearAll, exportJSON, importJSON, updateSettings } from '../../state/actions.ts';
import { app } from '../../state/app.ts';
import { SettingRow } from '../components/Figure.tsx';
import { Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { toast } from '../components/Toast.tsx';
import { download } from '../feedback.ts';
import { SqlConsole } from './SqlConsole.tsx';

export function Settings() {
  const state = app.value;
  const settings = state.settings;
  const [sqlOpen, setSqlOpen] = useState(false);

  const symbol = useRef<HTMLInputElement>(null);
  const code = useRef<HTMLInputElement>(null);
  const locale = useRef<HTMLInputElement>(null);
  const goal = useRef<HTMLInputElement>(null);
  const auto = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLInputElement>(null);

  const recordCount = state.income.length + state.bills.length
    + state.purchases.length + state.savingsTx.length;

  /* Reads a chosen .json backup and restores it, leaving data untouched if the
     file turns out not to be one. */
  const onRestoreFile = (): void => {
    const file = restore.current?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const counts = importJSON(String(reader.result));
        toast(`Restored ${counts.income} income, ${counts.bills} bills, ${counts.purchases} purchases`);
      } catch (err) {
        alert(`That file could not be restored.\n\n${err instanceof Error ? err.message : String(err)}`);
      }
      if (restore.current) restore.current.value = '';
    };
    reader.readAsText(file);
  };

  return (
    <div class="stack">
      <Sheet>
        <SheetHead><h2>Currency &amp; goals</h2></SheetHead>
        <SheetBody>
          <div class="form-grid">
            <SettingRow label="Currency symbol" hint="Used on screen and in Excel">
              <input ref={symbol} type="text" maxLength={4} defaultValue={settings.currencySymbol} />
            </SettingRow>
            <SettingRow label="Currency code" hint="e.g. USD, GBP, EUR, NGN">
              <input ref={code} type="text" maxLength={5} defaultValue={settings.currencyCode} />
            </SettingRow>
            <SettingRow label="Number locale" hint="Controls digit grouping">
              <input ref={locale} type="text" placeholder="en-US" defaultValue={settings.locale} />
            </SettingRow>
            <SettingRow label="Savings goal" hint="% of income you aim to save">
              <input ref={goal} type="number" min="0" max="100" step="1"
                defaultValue={String(settings.savingsGoalRate)} />
            </SettingRow>
            <SettingRow
              label="Fill in recurring entries automatically"
              hint="Your recurring income and bills are entered for you each new month"
            >
              <input ref={auto} type="checkbox" defaultChecked={settings.autoGenerate !== false} />
            </SettingRow>
          </div>
          <div class="btn-row" style="margin-top:16px">
            <button
              class="primary"
              onClick={() => {
                updateSettings({
                  currencySymbol: symbol.current?.value || '',
                  currencyCode: code.current?.value || '',
                  locale: locale.current?.value || 'en-US',
                  savingsGoalRate: Number(goal.current?.value) || 0,
                  autoGenerate: !!auto.current?.checked
                });
                /* Switching it back on should catch up straight away rather
                   than waiting for the next time the app is opened. */
                const added = catchUp();
                toast(added.total
                  ? `Settings saved · ${plural(added.total, 'entry', 'entries')} added`
                  : 'Settings saved');
              }}
            >Save settings</button>
          </div>
        </SheetBody>
      </Sheet>

      <Sheet>
        <SheetHead>
          <h2>Your data</h2>
          <span class="muted spacer">
            {`${plural(recordCount, 'record')} · stored in SQLite via ${getBackend()}`}
          </span>
        </SheetHead>
        <SheetBody>
          <p class="muted" style="margin-top:0">
            The database lives inside this browser. Clearing browsing data or moving to another
            machine will lose it, so download a copy regularly.
          </p>
          <div class="btn-row">
            <button
              class="primary"
              onClick={() => {
                download(exportBytes(), `income-tracker-${todayISO()}.db`, 'application/x-sqlite3');
                toast('Database downloaded');
              }}
            >Download database (.db)</button>
            <button
              onClick={() => {
                download(exportJSON(), `income-tracker-backup-${todayISO()}.json`, 'application/json');
                toast('Backup downloaded');
              }}
            >Download backup (.json)</button>
            <button
              onClick={() => {
                const ok = confirm('Restoring replaces everything currently stored.\n\n'
                  + 'Download a backup first if you are unsure. Continue?');
                if (ok) restore.current?.click();
              }}
            >Restore from .json</button>
            <input
              ref={restore} type="file" accept=".json,application/json"
              style="display:none" onChange={onRestoreFile}
            />
          </div>
        </SheetBody>
      </Sheet>

      <Sheet>
        <SheetHead>
          <h2>Query your data</h2>
          <button
            class="spacer"
            aria-expanded={sqlOpen ? 'true' : 'false'}
            onClick={() => setSqlOpen(!sqlOpen)}
          >{sqlOpen ? 'Hide' : 'Open SQL console'}</button>
        </SheetHead>
        {sqlOpen ? <SheetBody><SqlConsole /></SheetBody> : null}
      </Sheet>

      <Sheet>
        <SheetHead><h2>Danger zone</h2></SheetHead>
        <SheetBody>
          <button
            class="danger"
            onClick={() => {
              const first = confirm('Erase every income, bill, purchase and savings record?\n\n'
                + 'This cannot be undone. Download a backup first if you are unsure.');
              if (!first) return;
              if (!confirm('Last chance — really erase everything?')) return;
              clearAll();
              toast('All data erased');
            }}
          >Erase all data</button>
        </SheetBody>
      </Sheet>
    </div>
  );
}
