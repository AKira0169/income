/* ui/tabs/SqlConsole.tsx — a read-only window onto the database underneath.

   The app cannot have a screen for every question, and the data is a real
   SQLite file, so the shortest honest answer is to let you ask it directly. */

import { useRef, useState } from 'preact/hooks';
import { query, TABLES } from '../../data/sqlite.ts';
import { Table } from '../components/Table.tsx';
import type { QueryResult } from '../../data/sqlite.ts';

/** Enough to read; anything larger belongs in the exported .db. */
const MAX_ROWS = 200;

const PLACEHOLDER = 'SELECT category, SUM(amount)/100.0 AS total\nFROM bills GROUP BY category ORDER BY total DESC';

type Outcome = { ok: true; result: QueryResult } | { ok: false; error: string } | null;

export function SqlConsole() {
  const input = useRef<HTMLTextAreaElement>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const run = (): void => {
    const sql = input.current?.value.trim() ?? '';
    if (!sql) { setOutcome(null); return; }
    try {
      setOutcome({ ok: true, result: query(sql) });
    } catch (err) {
      setOutcome({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div>
      <p class="muted" style="margin-top:0">
        Your records live in a real SQLite database. Query it here, or download the .db and open it
        in any SQLite tool. Read-only: only SELECT, WITH, PRAGMA and EXPLAIN run.
      </p>
      <div class="field">
        <label for="sql-input">SQL</label>
        <textarea id="sql-input" ref={input} class="sql" spellcheck={false} placeholder={PLACEHOLDER} />
      </div>
      <div class="btn-row" style="margin-top:12px">
        <button class="primary" onClick={run}>Run query</button>
        <span class="muted">{`Tables: ${Object.keys(TABLES).join(', ')}`}</span>
      </div>
      <div class="sql-out" style="margin-top:12px">
        {outcome === null ? null : !outcome.ok
          ? <div class="notice danger" style="margin:12px">{outcome.error}</div>
          : !outcome.result.rows.length
            ? <div class="empty">No rows returned.</div>
            : (
              <>
                <Table headers={outcome.result.columns.map((c) => ({ label: c }))}>
                  {outcome.result.rows.slice(0, MAX_ROWS).map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => <td key={j}>{cell === null ? '—' : String(cell)}</td>)}
                    </tr>
                  ))}
                </Table>
                {outcome.result.rows.length > MAX_ROWS ? (
                  <div class="muted" style="padding:8px 16px">
                    {`Showing the first ${MAX_ROWS} of ${outcome.result.rows.length} rows.`}
                  </div>
                ) : null}
              </>
            )}
      </div>
    </div>
  );
}
