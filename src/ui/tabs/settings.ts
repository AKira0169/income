/* ui/tabs/settings.ts — currency, goals, backup and the danger zone. */

import { el } from '../../dom.ts';
import { getBackend, exportBytes } from '../../sqlite.ts';
import {
  catchUp, clearAll, exportJSON, importJSON, plural, save, state, todayISO
} from '../../store.ts';
import { download, toast } from '../feedback.ts';
import { isOpen, render, toggle } from '../view.ts';
import { settingRow } from '../widgets.ts';
import { renderSqlConsole } from './sql-console.ts';

/** Reads a chosen .json backup and restores it, leaving data untouched if the
    file turns out not to be one. */
function buildRestoreInput(): HTMLInputElement {
  const input = el('input', {
    type: 'file', accept: '.json,application/json', style: 'display:none'
  });

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = importJSON(String(reader.result));
        render();
        toast(`Restored ${result.income} income, ${result.bills} bills, ${result.purchases} purchases`);
      } catch (err) {
        alert(`That file could not be restored.\n\n${err instanceof Error ? err.message : String(err)}`);
      }
      input.value = '';
    };
    reader.readAsText(file);
  });

  return input;
}

export function renderSettings(): HTMLElement {
  const settings = state.settings;
  const recordCount = state.income.length + state.bills.length
    + state.purchases.length + state.savingsTx.length;

  const symbol = el('input', { type: 'text', value: settings.currencySymbol, maxlength: '4' });
  const code = el('input', { type: 'text', value: settings.currencyCode, maxlength: '5' });
  const locale = el('input', { type: 'text', value: settings.locale, placeholder: 'en-US' });
  const goal = el('input', {
    type: 'number', value: String(settings.savingsGoalRate), min: '0', max: '100', step: '1'
  });
  const auto = el('input', { type: 'checkbox' });
  auto.checked = settings.autoGenerate !== false;

  const restoreInput = buildRestoreInput();

  return el('div', { class: 'stack' }, [
    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [el('h2', { text: 'Currency & goals' })]),
      el('div', { class: 'sheet-body' }, [
        el('div', { class: 'form-grid' }, [
          settingRow('Currency symbol', symbol, 'Used on screen and in Excel'),
          settingRow('Currency code', code, 'e.g. USD, GBP, EUR, NGN'),
          settingRow('Number locale', locale, 'Controls digit grouping'),
          settingRow('Savings goal', goal, '% of income you aim to save'),
          settingRow('Fill in recurring entries automatically', auto,
            'Your recurring income and bills are entered for you each new month')
        ]),
        el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
          el('button', {
            class: 'primary', text: 'Save settings',
            onclick: () => {
              settings.currencySymbol = symbol.value || '';
              settings.currencyCode = code.value || '';
              settings.locale = locale.value || 'en-US';
              settings.savingsGoalRate = Number(goal.value) || 0;
              settings.autoGenerate = auto.checked;
              save();
              /* Switching it back on should catch up straight away rather than
                 waiting for the next time the app is opened. */
              const added = catchUp();
              render();
              toast(added.total
                ? `Settings saved · ${plural(added.total, 'entry', 'entries')} added`
                : 'Settings saved');
            }
          })
        ])
      ])
    ]),

    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: 'Your data' }),
        el('span', {
          class: 'muted spacer',
          text: `${plural(recordCount, 'record')} · stored in SQLite via ${getBackend()}`
        })
      ]),
      el('div', { class: 'sheet-body' }, [
        el('p', { class: 'muted', style: 'margin-top:0' },
          'The database lives inside this browser. Clearing browsing data or moving to another ' +
          'machine will lose it, so download a copy regularly.'),
        el('div', { class: 'btn-row' }, [
          el('button', {
            class: 'primary', text: 'Download database (.db)',
            onclick: () => {
              download(exportBytes(), `income-tracker-${todayISO()}.db`, 'application/x-sqlite3');
              toast('Database downloaded');
            }
          }),
          el('button', {
            text: 'Download backup (.json)',
            onclick: () => {
              download(exportJSON(), `income-tracker-backup-${todayISO()}.json`, 'application/json');
              toast('Backup downloaded');
            }
          }),
          el('button', {
            text: 'Restore from .json',
            onclick: () => {
              const ok = confirm('Restoring replaces everything currently stored.\n\n' +
                'Download a backup first if you are unsure. Continue?');
              if (ok) restoreInput.click();
            }
          }),
          restoreInput
        ])
      ])
    ]),

    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: 'Query your data' }),
        el('button', {
          class: 'spacer',
          'aria-expanded': isOpen('sql') ? 'true' : 'false',
          text: isOpen('sql') ? 'Hide' : 'Open SQL console',
          onclick: () => toggle('sql')
        })
      ]),
      isOpen('sql') ? el('div', { class: 'sheet-body' }, [renderSqlConsole()]) : null
    ]),

    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [el('h2', { text: 'Danger zone' })]),
      el('div', { class: 'sheet-body' }, [
        el('button', {
          class: 'danger', text: 'Erase all data',
          onclick: () => {
            const first = confirm('Erase every income, bill, purchase and savings record?\n\n' +
              'This cannot be undone. Download a backup first if you are unsure.');
            if (!first) return;
            if (!confirm('Last chance — really erase everything?')) return;
            clearAll();
            render();
            toast('All data erased');
          }
        })
      ])
    ])
  ]);
}
