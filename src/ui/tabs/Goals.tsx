/* ui/tabs/Goals.tsx — what you are saving for, and when you will have it.

   This tab deliberately ignores the month picker in the top bar. Every other
   tab shows the month you chose; a forecast from a month in the past is
   meaningless, so this one always projects from the real current month.

   The page is arranged as one answer and then its evidence. The headline is the
   next goal and its date; the plot under it is the same claim drawn, with every
   goal as a band as tall as its price; the table is the queue; and the month
   rows at the bottom are the figures the whole thing is derived from.

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
import type {
  AppState, Cents, Forecast, Goal, GoalForecast, Period, Settings
} from '../../domain/types.ts';
import { Editor } from '../components/Dialog.tsx';
import { Figure } from '../components/Figure.tsx';
import { ScopeToggle } from '../components/ScopeToggle.tsx';
import { AddSection, Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { EmptyRow, RowActions, Table } from '../components/Table.tsx';
import { toast } from '../components/Toast.tsx';
import { confirmDelete } from '../feedback.ts';
import { FIELDS } from '../fields.ts';

/** How much of the projection is on screen before you ask for the rest. */
const NEAR_MONTHS = 12;
const HORIZON_YEARS = Math.round(HORIZON_MONTHS / 12);

/* One month of runway past the last goal: enough that the last mark is not on
   the edge, and no more, because everything drawn past it is empty paper above
   the top band — the plot is about the goals, not about the far future. */
const PLOT_TAIL = 1;
/* Two months is the shortest plot worth drawing, and it is deliberately short.
   The vertical scale runs to the balance at the end, so every month drawn past
   the last goal pushes the ceiling further up and squashes the bands — which is
   how a goal a month away ends up as a sliver under an empty top half. The plot
   stops just after the last goal for that reason. */
const PLOT_MIN_MONTHS = 2;
/** A band shorter than this cannot hold its name without clipping it. */
const BAND_LABEL_MIN = 9;

const GOAL_COLUMNS = 5;
const GOAL_HEADERS = [
  { label: '', num: true }, { label: 'Goal' }, { label: 'Ready by' },
  { label: 'Saved' }, { label: '', actions: true }
];

const MONTH_HEADERS = [
  { label: 'Month' }, { label: 'In', num: true }, { label: 'Bills', num: true },
  { label: 'Spent', num: true }, { label: 'Surplus', num: true }, { label: 'Balance', num: true }
];

const BOUGHT_HEADERS = [
  { label: 'Goal' }, { label: 'Price', num: true }, { label: 'Bought on' }, { label: '', actions: true }
];

/** A new goal joins the back of the queue. */
const nextPriority = (state: AppState): number =>
  state.goals.reduce((max, g) => Math.max(max, g.priority || 0), 0) + 1;

/** “Aug 26” — the axis has no room for the long form periodLabel gives. */
function periodShort(period: Period, locale?: string): string {
  const [year = '0', month = '1'] = String(period).split('-');
  return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString(locale || 'en-US', { month: 'short', year: '2-digit' });
}

/** How far off, in words. */
const awayLabel = (months: number): string =>
  months === 0 ? 'ready now' : `${plural(months, 'month')} away`;

function Meter({ fraction }: { fraction: number }) {
  const pct = Math.min(100, Math.max(0, fraction * 100));
  return (
    <div class="meter" aria-hidden="true">
      <div style={`width:${pct}%`} />
    </div>
  );
}

/* ------------------------------------------------------------------- plot */

/* Money runs up the page and time runs across it. Each priced goal owns the
   band between what the goals ahead of it cost and what it costs on top of
   them — which is exactly the threshold the projection has to reach — so the
   bands stack to the whole queue and a goal's height *is* its price. The line
   is the projected balance, and a goal is yours where the line clears the top
   of its band.

   Everything is placed in percentages, so the only thing that has to survive
   being stretched is the line: the SVG is drawn in a square 0–100 space with
   preserveAspectRatio off, and the stroke is told not to scale with it. Labels
   are HTML rather than SVG text for the same reason — text inside a stretched
   viewBox is unreadable by the time the page is on a phone. */
function GoalPlot({ line, goals, settings }: {
  line: Forecast;
  goals: readonly GoalForecast[];
  settings: Settings;
}) {
  const money = (cents: Cents): string => formatMoney(cents, settings, { round: true });
  const locale = settings.locale;

  /* Numbered by queue position, not by position among the priced ones: the
     number on a mark is the number in the table, which is the whole reason it
     is legible when two goals land a month apart. */
  const priced = goals
    .map((g, i) => ({ g, rank: i + 1 }))
    .filter((b) => (b.g.goal.price || 0) > 0);
  const reach = priced.filter((b) => b.g.monthsAway !== null).map((b) => b.g);
  const beyond = priced.filter((b) => b.g.monthsAway === null).map((b) => b.g);
  const last = reach.reduce((max, g) => Math.max(max, g.monthsAway ?? 0), 0);

  /* `last` is 0 for two opposite situations, and they want opposite plots. If
     nothing is reachable there is no landing to stop at, so the plot runs the
     near months to show the climb toward the goals that are off the top. If
     everything is already covered there is no "when" left to draw at all —
     drawing it anyway sets the ceiling twelve months of surplus above bands
     that are all below today's balance, which is the sliver this plot exists
     to avoid. The tab leaves the panel out in that case. */
  const span = Math.min(
    line.months.length,
    last ? Math.max(PLOT_MIN_MONTHS, last + PLOT_TAIL) : NEAR_MONTHS
  );
  if (span < 1 || (!beyond.length && !last)) return null;

  /* Point 0 is today's cash, so the line starts where you actually are rather
     than at the end of next month. */
  const balances = [line.start, ...line.months.slice(0, span).map((m) => m.balance)];
  const steps = balances.length - 1;
  const floor = Math.min(0, ...balances);
  const ceiling = Math.max(...balances, ...reach.map((g) => g.threshold));
  // A little headroom, so the top band and the line's end are not on the edge.
  const range = ((ceiling - floor) || 1) * 1.06;
  const y = (value: Cents): number => ((value - floor) / range) * 100;

  const points = balances
    .map((b, i) => `${(i / steps) * 100},${100 - y(b)}`)
    .join(' ');

  /* Where the line reaches a given balance, interpolated inside the month that
     gets there — 0 if it starts there, 100 if it never does. A mark placed at
     this x for a goal's own threshold sits on the line and on the top of its
     band at once, which is the whole claim the picture is making. */
  const crossAt = (value: Cents): number => {
    if ((balances[0] ?? 0) >= value) return 0;
    for (let i = 1; i <= steps; i++) {
      const before = balances[i - 1] ?? 0;
      const after = balances[i] ?? 0;
      if (after < value) continue;
      const share = after === before ? 1 : (value - before) / (after - before);
      return ((i - 1 + Math.min(1, Math.max(0, share))) / steps) * 100;
    }
    return 100;
  };

  const crossing = (g: GoalForecast): number | null =>
    (g.monthsAway === null || g.monthsAway > steps) ? null : crossAt(g.threshold);

  const tickEvery = steps <= 6 ? 1 : steps <= 12 ? 2 : steps <= 30 ? 6 : 12;
  const ticks = [];
  for (let i = 0; i <= steps; i += tickEvery) {
    const period = i === 0 ? '' : line.months[i - 1]?.period;
    ticks.push({
      at: (i / steps) * 100,
      label: i === 0 ? 'now' : (period ? periodShort(period, locale) : ''),
      first: i === 0,
      last: i + tickEvery > steps
    });
  }

  const endBalance = balances[steps] ?? line.start;
  const endPeriod = line.months[steps - 1]?.period ?? line.startPeriod;

  return (
    <div>
      <div
        class="plot" role="img"
        aria-label={`Your projected balance over the next ${plural(span, 'month')}, with each goal drawn as a band as tall as its price. The figures are in the table below.`}
      >
        {priced.map(({ g, rank }, i) => {
          const bottom = y(g.reserved);
          /* A band whose top is off the scale is drawn without one. Clamping it
             to the ceiling would put a rule across the plot that the line ends
             just under, which reads as "nearly there" for a goal that is
             nowhere near. No lid, no promise. */
          const open = g.threshold > floor + range;
          const height = (open ? 100 : y(g.threshold)) - bottom;
          if (height <= 0) return null;
          /* The label goes on whichever side of the plot the line does not
             cross the band's own mid-height on. The line only ever climbs
             through a band once, so the far side of that crossing is always
             free — which is what stops a long goal name being struck through
             by the line on a plot where the band is cleared early. */
          const mid = (g.reserved + Math.min(g.threshold, floor + range)) / 2;
          const right = crossAt(mid) < 50;
          return (
            <div
              key={g.goal.id}
              class={`band${i % 2 ? ' is-alt' : ''}${open ? ' is-open' : ''}${right ? ' is-right' : ''}`}
              style={`bottom:${bottom}%;height:${height}%`}
            >
              {height >= BAND_LABEL_MIN ? (
                <span class="band-name">
                  <span class="band-rank num">{rank}</span>
                  {g.goal.name}
                  <span class="band-price num">{money(g.goal.price || 0)}</span>
                </span>
              ) : null}
            </div>
          );
        })}

        {floor < 0 ? (
          <div class="plot-zero" style={`bottom:${y(0)}%`}><span>0</span></div>
        ) : null}

        <svg class="plot-line" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline
            points={points} fill="none" stroke="currentColor" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"
          />
        </svg>

        {priced.map(({ g, rank }) => {
          const at = crossing(g);
          return at === null ? null : (
            <div
              key={g.goal.id} class="plot-mark"
              style={`left:${at}%;bottom:${y(g.threshold)}%`}
            >{rank}</div>
          );
        })}
      </div>

      <div class="plot-axis">
        {ticks.map((t) => (
          <div
            key={t.at}
            class={`plot-tick${t.first ? ' is-first' : ''}${t.last ? ' is-last' : ''}`}
            style={`left:${t.at}%`}
          >{t.label}</div>
        ))}
      </div>

      <div class="plot-note">
        <span>{`You have `}<span class="num">{money(line.start)}</span>{` today`}</span>
        {beyond.length ? (
          <span>{`${beyond.map((g) => g.goal.name).join(', ')} — past ${HORIZON_YEARS} years at this rate`}</span>
        ) : null}
        <span><span class="num">{money(endBalance)}</span>{` by ${periodLabel(endPeriod, locale)}`}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- tab */

export function Goals() {
  const state = app.value;
  const [allMonths, setAllMonths] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);

  const money = (cents: Cents): string => formatMoney(cents, state.settings);
  /* Ledger columns and figures are exact; a line of prose is not a column, and
     four sets of decimals in one sentence are read as noise rather than as
     precision. */
  const round = (cents: Cents): string => formatMoney(cents, state.settings, { round: true });
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

  /* How far the projection ends up short, so an unreachable goal says something
     more useful than "no". */
  const shortfall = (g: GoalForecast): Cents => {
    const end = line.months[line.months.length - 1]?.balance ?? line.start;
    return Math.max(g.threshold - end, 0);
  };

  const priced = goals.filter((g) => (g.goal.price || 0) > 0);
  const beyond = priced.filter((g) => g.monthsAway === null);
  const finishes = priced.reduce<Period | ''>(
    (latest, g) => (g.reachedIn > latest ? g.reachedIn : latest), ''
  );

  /* Nothing left to plot once every goal is covered by what you already have —
     the same test the plot itself makes, kept here so the panel goes with it
     rather than being left as an empty heading. */
  const landsLater = priced.some((g) => (g.monthsAway ?? 0) > 0);
  const showPlot = priced.length > 0 && (landsLater || beyond.length > 0);

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

  /* ---------------------------------------------------------- the headline */

  const head = goals[0];
  const headPrice = head?.goal.price || 0;

  const headWhen = (): string => {
    if (!head) return '';
    if (!headPrice) return 'Needs a price';
    if (head.monthsAway === null) return `Past ${HORIZON_YEARS} years`;
    if (head.monthsAway === 0) return 'Ready now';
    return periodLabel(head.reachedIn, locale);
  };

  const headSub = (): string => {
    if (!head) return '';
    if (!headPrice) return 'Add what it costs and this says when you will have it.';
    if (head.monthsAway === null) {
      return `${round(shortfall(head))} short of it by the end of the projection.`;
    }
    const left = Math.max(headPrice - head.saved, 0);
    return left
      ? `${round(head.saved)} of ${round(headPrice)} · ${round(left)} to go`
      : `${round(headPrice)} put by — it is covered`;
  };

  const headline = head ? (
    <header class="headline">
      <div class="label">
        {head.monthsAway === null || !headPrice
          ? 'Next up'
          : `Next up · ${awayLabel(head.monthsAway)}`}
      </div>
      <div class="headline-row">
        <h1 class="headline-name">{head.goal.name}</h1>
        <div class={headPrice && head.monthsAway !== null ? 'headline-when' : 'headline-when is-far'}>
          {headWhen()}
        </div>
      </div>
      {headPrice ? <Meter fraction={head.saved / headPrice} /> : null}
      <div class="headline-sub">{headSub()}</div>
    </header>
  ) : null;

  /* ------------------------------------------------------------- the queue */

  const readyBy = (g: GoalForecast) => {
    const price = g.goal.price || 0;
    if (!price) return { main: '—', sub: 'add a price' };
    if (g.monthsAway === null) {
      return { main: `Past ${HORIZON_YEARS} years`, sub: `${round(shortfall(g))} short` };
    }
    if (g.monthsAway === 0) return { main: 'Ready now', sub: 'covered by what you have' };
    return { main: periodLabel(g.reachedIn, locale), sub: awayLabel(g.monthsAway) };
  };

  /* A goal behind another is not at 0% for want of trying — nothing is put
     toward it until the one ahead is covered. Saying so is the difference
     between a queue and a list of failures. */
  const savedSub = (g: GoalForecast, i: number): string => {
    const price = g.goal.price || 0;
    if (!price) return 'no price yet';
    if (g.saved > 0) return `${round(g.saved)} of ${round(price)}`;
    const ahead = goals[i - 1]?.goal.name;
    return ahead ? `${round(price)} · starts after ${ahead}` : round(price);
  };

  const goalRow = (g: GoalForecast, i: number) => {
    const price = g.goal.price || 0;
    const when = readyBy(g);
    return (
      <tr key={g.goal.id}>
        <td class="num muted">{i + 1}</td>
        <td class="cell-goal">
          <div>{g.goal.name}</div>
          {g.goal.notes ? <span class="cell-sub">{g.goal.notes}</span> : null}
        </td>
        <td class="cell-when">
          <div>{when.main}</div>
          <span class="cell-sub">{when.sub}</span>
        </td>
        <td class="cell-saved">
          {price ? <Meter fraction={g.saved / price} /> : null}
          <span class="cell-sub">{savedSub(g, i)}</span>
        </td>
        <td class="actions">
          {goals.length > 1 ? (
            <>
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
            </>
          ) : null}
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

  /* The month a goal lands in, marked on the row that pays for it. */
  const landings = new Map<Period, string[]>();
  for (const g of goals) {
    if (!g.reachedIn || g.reachedIn === line.startPeriod) continue;
    landings.set(g.reachedIn, [...(landings.get(g.reachedIn) ?? []), g.goal.name]);
  }

  return (
    <div class="stack">
      {avgSurplus < 0 ? (
        <div class="notice danger">
          <strong>You are spending more than you earn. </strong>
          {`About ${money(-avgSurplus)} more than comes in each month, averaged across the projection.`}
        </div>
      ) : null}

      {headline}

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
          label="Whole list by"
          value={!priced.length ? '—' : (beyond.length ? `Past ${HORIZON_YEARS} years` : periodLabel(finishes, locale))}
          note={!priced.length
            ? 'add a price to a goal'
            : (beyond.length
              ? `${priced.length - beyond.length} of ${plural(priced.length, 'goal')} land within ${HORIZON_YEARS} years`
              : (queue.length > priced.length
                ? `${plural(queue.length - priced.length, 'goal')} still ${queue.length - priced.length === 1 ? 'needs' : 'need'} a price`
                : `${plural(queue.length, 'goal')} in the queue`))}
        />
      </div>

      {showPlot ? (
        <Sheet>
          <SheetHead>
            <h2>When each goal lands</h2>
            <span class="muted spacer">
              Each goal is a band as tall as its price. You can buy it where the line clears the top.
            </span>
          </SheetHead>
          <SheetBody>
            <GoalPlot line={line} goals={goals} settings={state.settings} />
          </SheetBody>
        </Sheet>
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
          <div class="assume-row">
            <span>Recurring income</span>
            <span class="num">{`+${money(next?.income ?? 0)}`}</span>
          </div>
          <div class="assume-row">
            <span>Recurring bills</span>
            <span class="num">{`−${money(next?.bills ?? 0)}`}</span>
          </div>
          <div class="assume-row">
            <span>Usual purchases</span>
            <span class="num">{`−${money(next?.spending ?? 0)}`}</span>
          </div>
          <div class="assume-control">
            <label class="check">
              <input
                type="checkbox" name="forecastSpendingAuto" defaultChecked={auto}
                onChange={(e) => updateSettings({
                  forecastSpendingAuto: (e.target as HTMLInputElement).checked
                })}
              />
              {`Average the last ${SPENDING_WINDOW} complete months`}
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
          <div class="assume-row is-total">
            <strong>Left over each month</strong>
            <span class="num">{money(next?.surplus ?? 0)}</span>
          </div>
          <p class="muted">
            Not every month is the same — a yearly premium lands in its own month. The table
            below has the real figures.
          </p>
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
            {rows.map((m) => {
              const ready = landings.get(m.period);
              return (
                <tr
                  key={m.period}
                  title={m.other
                    ? `Includes ${money(m.other)} of gold and outside movements`
                    : undefined}
                >
                  <td>
                    <div>{periodLabel(m.period, locale)}</div>
                    {ready ? <span class="cell-sub is-landing">{`${ready.join(', ')} ready`}</span> : null}
                  </td>
                  <td class="num">{money(m.income)}</td>
                  <td class="num">{money(m.bills)}</td>
                  <td class="num">{money(m.spending)}</td>
                  <td class={m.surplus < 0 ? 'num is-negative' : 'num'}>{money(m.surplus)}</td>
                  <td class="num">{money(m.balance)}</td>
                </tr>
              );
            })}
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
