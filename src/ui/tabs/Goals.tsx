/* ui/tabs/Goals.tsx — what you are saving for, and when you will have it.

   This tab deliberately ignores the month picker in the top bar. Every other
   tab shows the month you chose; a forecast from a month in the past is
   meaningless, so this one always projects from the real current month.

   The assumptions panel describes the *next* month, which is the first row of
   the projection. Bills of other frequencies make months differ, which is why
   that line carries a note and the month-by-month table below it is where the
   real figures are. */

import { useState } from 'preact/hooks';
import { formatMoney, parseMoney, plural, toMajor } from '../../domain/money.ts';
import { periodLabel, todayISO } from '../../domain/period.ts';
import {
  forecast, goalForecasts, goalQueue, HORIZON_MONTHS, SPENDING_WINDOW
} from '../../domain/forecast.ts';
import { sum } from '../../domain/selectors.ts';
import { moveGoal, remove, updateSettings, upsert } from '../../state/actions.ts';
import { app } from '../../state/app.ts';
import { goTab } from '../../state/route.ts';
import type { AppState, Cents, Goal, GoalForecast } from '../../domain/types.ts';
import { Editor } from '../components/Dialog.tsx';
import { Figure, TargetProgress } from '../components/Figure.tsx';
import { ScopeToggle } from '../components/ScopeToggle.tsx';
import { AddSection, Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { EmptyRow, RowActions, Table } from '../components/Table.tsx';
import { toast } from '../components/Toast.tsx';
import { confirmDelete } from '../feedback.ts';
import { FIELDS } from '../fields.ts';

/** How much of the projection is on screen before you ask for the rest. */
const NEAR_MONTHS = 12;
const HORIZON_YEARS = Math.round(HORIZON_MONTHS / 12);

const GOAL_COLUMNS = 7;
const GOAL_HEADERS = [
  { label: '', num: true }, { label: 'Goal' }, { label: 'Price', num: true },
  { label: 'Saved', num: true }, { label: 'Ready by' }, { label: 'Progress' },
  { label: '', actions: true }
];

const MONTH_HEADERS = [
  { label: 'Month' }, { label: 'In', num: true }, { label: 'Bills', num: true },
  { label: 'Spent', num: true }, { label: 'Surplus', num: true }, { label: 'Balance', num: true }
];

const BOUGHT_HEADERS = [
  { label: 'Goal' }, { label: 'Price', num: true }, { label: 'Bought' }, { label: '', actions: true }
];

/** A new goal joins the back of the queue. */
const nextPriority = (state: AppState): number =>
  state.goals.reduce((max, g) => Math.max(max, g.priority || 0), 0) + 1;

export function Goals() {
  const state = app.value;
  const [allMonths, setAllMonths] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);

  const money = (cents: Cents): string => formatMoney(cents, state.settings);
  const locale = state.settings.locale;

  const nothingSetUp = !state.accounts.length
    && !state.incomeTemplates.length
    && !state.billTemplates.length;

  const line = forecast(state);
  const goals = goalForecasts(state, line);
  const queue = goalQueue(state);
  const bought = state.goals.filter((g) => g.boughtDate);
  const next = line.months[0];
  const rows = allMonths ? line.months : line.months.slice(0, NEAR_MONTHS);
  const auto = state.settings.forecastSpendingAuto !== false;

  /* The overspend banner reads the whole projection's average, not just next
     month: a lumpy month — a yearly premium landing once — drags that one
     month negative without the position actually going backwards, and the
     projection line itself is never smoothed (that invariant belongs to the
     engine; this only reads its output). Averaging here is what stops the
     banner contradicting the goals table right above it. */
  const avgSurplus = line.months.length
    ? Math.round(sum(line.months, (m) => m.surplus) / line.months.length)
    : 0;

  const readyBy = (g: GoalForecast): string => {
    if (!(g.goal.price || 0)) return 'add a price';
    if (g.reachedIn) return periodLabel(g.reachedIn, locale);
    return `not within ${HORIZON_YEARS} years at this rate`;
  };

  /* How far the projection ends up short, so an unreachable goal says something
     more useful than "no". */
  const shortfall = (g: GoalForecast): Cents => {
    const end = line.months[line.months.length - 1]?.balance ?? line.start;
    return Math.max(g.threshold - end, 0);
  };

  if (nothingSetUp) {
    return (
      <div class="stack">
        <Sheet>
          <SheetHead><h2>Goals</h2></SheetHead>
          <SheetBody>
            <div class="empty">
              <strong>Set your recurring money up first</strong>
              A goal answers “when will I have enough”, which needs to know what comes in
              and what goes out each month.
              <div class="btn-row" style="margin-top:16px">
                <button onClick={() => goTab('income')}>Set up income</button>
                <button onClick={() => goTab('bills')}>Set up bills</button>
                <button onClick={() => goTab('savings')}>Add an account</button>
              </div>
            </div>
          </SheetBody>
        </Sheet>
      </div>
    );
  }

  const goalRow = (g: GoalForecast, i: number) => {
    const price = g.goal.price || 0;
    const short = price && !g.reachedIn ? shortfall(g) : 0;
    return (
      <tr key={g.goal.id}>
        <td class="num muted">{i + 1}</td>
        <td>
          <div>{g.goal.name}</div>
          {g.goal.notes ? <span class="cell-sub">{g.goal.notes}</span> : null}
        </td>
        <td class="num">{price ? money(price) : '—'}</td>
        <td class="num">{money(g.saved)}</td>
        <td title={short ? `${money(short)} short of ${money(g.threshold)} at the end of the projection` : undefined}>
          {readyBy(g)}
        </td>
        <td><TargetProgress balance={g.saved} target={price} settings={state.settings} /></td>
        <td class="actions">
          <button
            class="quiet small" disabled={i === 0}
            aria-label={`Move ${g.goal.name} up`}
            onClick={() => moveGoal(g.goal.id, -1)}
          >↑</button>
          <button
            class="quiet small" disabled={i === goals.length - 1}
            aria-label={`Move ${g.goal.name} down`}
            onClick={() => moveGoal(g.goal.id, 1)}
          >↓</button>
          <button
            class="quiet small"
            onClick={() => { upsert('goals', { id: g.goal.id, boughtDate: todayISO() }); toast('Marked as bought'); }}
          >Bought</button>
          <button class="quiet small" onClick={() => setEditing(g.goal)}>Edit</button>
          <button
            class="quiet small danger"
            onClick={() => { if (confirmDelete('goal')) remove('goals', g.goal.id); }}
          >Delete</button>
        </td>
      </tr>
    );
  };

  return (
    <div class="stack">
      <div class="figures">
        <Figure
          label="Spare each month" value={money(next?.surplus ?? 0)}
          note={(next?.surplus ?? 0) >= 0 ? 'after bills and usual spending' : 'short next month'}
          negative={(next?.surplus ?? 0) < 0}
        />
        <Figure
          label="On hand now" value={money(line.start)}
          note={line.outstanding ? `after ${money(line.outstanding)} of unpaid bills` : 'across every account'}
        />
        <Figure
          label="Next goal" value={queue[0]?.name ?? 'None yet'}
          note={goals[0] ? readyBy(goals[0]) : 'add one below'}
        />
      </div>

      {avgSurplus < 0 ? (
        <div class="notice danger">
          <strong>You are spending more than you earn. </strong>
          {`About ${money(-avgSurplus)} more than comes in each month, averaged across the projection.`}
        </div>
      ) : null}

      <Sheet>
        <SheetHead>
          <h2>Your goals</h2>
          <span class="muted spacer">
            Funded in order — the second starts once the first is covered.
          </span>
        </SheetHead>
        <SheetBody flush>
          <Table headers={GOAL_HEADERS}>
            {goals.length
              ? goals.map(goalRow)
              : (
                <EmptyRow
                  colspan={GOAL_COLUMNS}
                  title="Nothing on the list yet"
                  hint="Add what you are saving for and this says when you will have it."
                />
              )}
          </Table>
        </SheetBody>
      </Sheet>

      <AddSection
        title="Add a goal"
        addLabel="Add a goal"
        fields={FIELDS.goal}
        state={state}
        forceOpen={!state.goals.length}
        onInvalid={() => toast('Fill in the required fields')}
        onSubmit={(data) => {
          upsert('goals', { ...data, priority: nextPriority(state) });
          toast('Goal added');
        }}
      />

      <Sheet>
        <SheetHead>
          <h2>What this assumes</h2>
          <span class="muted spacer">{next ? periodLabel(next.period, locale) : ''}</span>
        </SheetHead>
        <SheetBody>
          <div class="bar-row">
            <div class="bar-name">Recurring income</div>
            <div class="bar-value num">{`+${money(next?.income ?? 0)}`}</div>
          </div>
          <div class="bar-row">
            <div class="bar-name">Recurring bills</div>
            <div class="bar-value num">{`−${money(next?.bills ?? 0)}`}</div>
          </div>
          <div class="muted">
            Not every month is the same — a yearly premium lands in its own month. The table
            below has the real figures.
          </div>
          <div class="bar-row">
            <div class="bar-name">Usual purchases</div>
            <div class="bar-value num">{`−${money(next?.spending ?? 0)}`}</div>
          </div>
          <div class="field">
            <label>
              <input
                type="checkbox" name="forecastSpendingAuto" defaultChecked={auto}
                onChange={(e) => updateSettings({
                  forecastSpendingAuto: (e.target as HTMLInputElement).checked
                })}
              />
              {` Average the last ${SPENDING_WINDOW} complete months`}
            </label>
            <input
              type="text" name="forecastSpending" aria-label="Use my own figure"
              placeholder="Use my own figure" disabled={auto}
              defaultValue={state.settings.forecastSpending ? String(toMajor(state.settings.forecastSpending)) : ''}
              onChange={(e) => updateSettings({
                forecastSpending: parseMoney((e.target as HTMLInputElement).value)
              })}
            />
          </div>
          <div class="bar-row">
            <div class="bar-name"><strong>Left over each month</strong></div>
            <div class="bar-value num">{money(next?.surplus ?? 0)}</div>
          </div>
        </SheetBody>
      </Sheet>

      <Sheet>
        <SheetHead>
          <h2>Month by month</h2>
          <span class="muted">{plural(rows.length, 'month')}</span>
          <div class="spacer">
            <ScopeToggle
              allTime={allMonths} onChange={setAllMonths}
              labels={[`${NEAR_MONTHS} months`, `${HORIZON_YEARS} years`]}
              group="How far ahead to show"
            />
          </div>
        </SheetHead>
        <SheetBody flush>
          <Table headers={MONTH_HEADERS}>
            {rows.map((m) => (
              <tr
                key={m.period}
                title={m.other
                  ? `Includes ${money(m.other)} of gold and outside movements`
                  : undefined}
              >
                <td>{periodLabel(m.period, locale)}</td>
                <td class="num">{money(m.income)}</td>
                <td class="num">{money(m.bills)}</td>
                <td class="num">{money(m.spending)}</td>
                <td class={m.surplus < 0 ? 'num is-negative' : 'num'}>{money(m.surplus)}</td>
                <td class="num">{money(m.balance)}</td>
              </tr>
            ))}
          </Table>
        </SheetBody>
      </Sheet>

      {bought.length ? (
        <Sheet>
          <SheetHead>
            <h2>Bought</h2>
            <span class="muted spacer">{plural(bought.length, 'goal')}</span>
          </SheetHead>
          <SheetBody flush>
            <Table headers={BOUGHT_HEADERS}>
              {bought.map((g) => (
                <tr key={g.id}>
                  <td>{g.name}</td>
                  <td class="num">{money(g.price || 0)}</td>
                  <td class="num">{g.boughtDate}</td>
                  <RowActions
                    onEdit={() => setEditing(g)}
                    onDelete={() => { if (confirmDelete('goal')) remove('goals', g.id); }}
                  />
                </tr>
              ))}
            </Table>
          </SheetBody>
        </Sheet>
      ) : null}

      {editing ? (
        <Editor
          title="Edit goal"
          fields={FIELDS.goal}
          record={editing}
          state={state}
          onInvalid={() => toast('Fill in the required fields')}
          onSave={(data) => { upsert('goals', data); toast('Saved'); }}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
