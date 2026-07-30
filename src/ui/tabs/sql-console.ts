/* ui/tabs/sql-console.ts — a read-only window onto the database underneath.

   The app cannot have a screen for every question, and the data is a real
   SQLite file, so the shortest honest answer is to let you ask it directly. */

import { append, clear, el } from '../../dom.ts';
import { query, TABLES } from '../../data/sqlite.ts';
import { table } from '../tables.ts';

/** Enough to read; anything larger belongs in the exported .db. */
const MAX_ROWS = 200;

export function renderSqlConsole(): HTMLElement {
  const input = el('textarea', {
    class: 'sql', spellcheck: 'false',
    placeholder: 'SELECT category, SUM(amount)/100.0 AS total\nFROM bills GROUP BY category ORDER BY total DESC'
  });
  const output = el('div', { class: 'sql-out', style: 'margin-top:12px' });

  function run(): void {
    clear(output);
    const sql = input.value.trim();
    if (!sql) return;

    try {
      const res = query(sql);
      if (!res.rows.length) {
        append(output, el('div', { class: 'empty', text: 'No rows returned.' }));
        return;
      }
      append(output, table(
        res.columns.map((c) => ({ label: c })),
        res.rows.slice(0, MAX_ROWS).map((row) =>
          el('tr', {}, row.map((cell) =>
            el('td', { text: cell === null ? '—' : String(cell) }))))
      ));
      if (res.rows.length > MAX_ROWS) {
        append(output, el('div', {
          class: 'muted', style: 'padding:8px 16px',
          text: `Showing the first ${MAX_ROWS} of ${res.rows.length} rows.`
        }));
      }
    } catch (err) {
      append(output, el('div', {
        class: 'notice danger', style: 'margin:12px',
        text: err instanceof Error ? err.message : String(err)
      }));
    }
  }

  return el('div', {}, [
    el('p', { class: 'muted', style: 'margin-top:0' },
      'Your records live in a real SQLite database. Query it here, or download the .db and open it ' +
      'in any SQLite tool. Read-only: only SELECT, WITH, PRAGMA and EXPLAIN run.'),
    el('div', { class: 'field' }, [el('label', { text: 'SQL' }), input]),
    el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
      el('button', { class: 'primary', text: 'Run query', onclick: run }),
      el('span', { class: 'muted', text: `Tables: ${Object.keys(TABLES).join(', ')}` })
    ]),
    output
  ]);
}
