/* ui/tabs/Dashboard.tsx — the month at a glance. */

import { formatMoney, plural } from '../../domain/money.ts';
import { periodLabel } from '../../domain/period.ts';
import { goldSummary } from '../../domain/gold.ts';
import {
  accountBalance, billsIn, groupByCategory, incomeIn, purchasesIn, summary,
  totalSavings, trend, upcomingBills
} from '../../domain/selectors.ts';
import { app } from '../../state/app.ts';
import { period as routePeriod } from '../../state/route.ts';
import type { AppState, Bill, Category, Cents, Period, Purchase } from '../../domain/types.ts';
import { Figure, TargetProgress } from '../components/Figure.tsx';
import { Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { Table } from '../components/Table.tsx';

/** Bills already overdue plus everything falling due inside this window. */
const LOOKAHEAD_DAYS = 45;
const TREND_MONTHS = 6;
const MAX_CATEGORY_BARS = 8;

const SPENT_SWATCH = 'background:repeating-linear-gradient(45deg,var(--ink-faint) 0 2px,'
  + 'transparent 2px 4px);border:1px solid var(--ink-faint)';

function TrendChart({ state, period }: { state: AppState; period: Period }) {
  const data = trend(state, period, TREND_MONTHS);
  const max = Math.max(1, ...data.map((d) => Math.max(d.income, d.spent)));
  const money = (cents: Cents): string => formatMoney(cents, state.settings);
  const locale = state.settings.locale;

  return (
    <div>
      <div class="trend">
        {data.map((d) => (
          <div
            class="trend-col" key={d.period}
            title={`${periodLabel(d.period, locale)} — in ${money(d.income)}, out ${money(d.spent)}`}
          >
            <div class="trend-bars">
              <div class="trend-bar in" style={`height:${Math.max((d.income / max) * 100, 1)}%`} />
              <div class="trend-bar out" style={`height:${Math.max((d.spent / max) * 100, 1)}%`} />
            </div>
            <div class="trend-label">{`${d.period.slice(5)}/${d.period.slice(2, 4)}`}</div>
          </div>
        ))}
      </div>
      <div class="legend">
        <span><i style="background:var(--ink-strong)" />Income</span>
        <span><i style={SPENT_SWATCH} />Spent</span>
      </div>
    </div>
  );
}

function CategoryBars({ records, total, settings }: {
  records: ReadonlyArray<{ category?: Category; amount?: Cents }>;
  total: Cents;
  settings: AppState['settings'];
}) {
  const groups = groupByCategory(records).slice(0, MAX_CATEGORY_BARS);
  if (!groups.length) {
    return (
      <div class="empty">
        <strong>Nothing spent yet</strong>
        Add bills or purchases to see the breakdown.
      </div>
    );
  }
  const max = groups[0]!.amount || 1;
  return (
    <div class="bars">
      {groups.map((g) => (
        <div class="bar-row" key={g.category}>
          <div class="bar-name">{g.category}</div>
          <div class="bar-value">
            {formatMoney(g.amount, settings) + (total ? `  ${Math.round((g.amount / total) * 100)}%` : '')}
          </div>
          <div class="bar-track">
            <div class="bar-fill" style={`width:${(g.amount / max) * 100}%`} />
          </div>
        </div>
      ))}
    </div>
  );
}

function AccountsPanel({ state, goldValue, goldGrams }: {
  state: AppState;
  goldValue: Cents;
  goldGrams: number;
}) {
  if (!state.accounts.length) {
    return (
      <div class="empty">
        <strong>No accounts yet</strong>
        Add one on the Accounts tab.
      </div>
    );
  }

  return (
    <div class="stack-tight">
      {state.accounts.map((a) => {
        const balance = accountBalance(state, a.id);
        return (
          <div key={a.id}>
            <div class="bar-row">
              <div class="bar-name">{a.name}</div>
              <div class="bar-value">{formatMoney(balance, state.settings)}</div>
            </div>
            <TargetProgress balance={balance} target={a.target} settings={state.settings} />
          </div>
        );
      })}
      {goldValue ? (
        <div>
          <div class="bar-row">
            <div class="bar-name">{`Gold · ${goldGrams.toFixed(2)} g`}</div>
            <div class="bar-value">{formatMoney(goldValue, state.settings)}</div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function Dashboard() {
  const state = app.value;
  const period = routePeriod.value;

  const s = summary(state, period);
  const upcoming = upcomingBills(state, LOOKAHEAD_DAYS);
  const gold = goldSummary(state);
  const outgoings: Array<Bill | Purchase> = [...billsIn(state, period), ...purchasesIn(state, period)];
  const money = (cents: Cents): string => formatMoney(cents, state.settings);

  return (
    <div class="stack">
      <div class="figures">
        <Figure label="Income" value={money(s.income)}
          note={plural(incomeIn(state, period).length, 'entry', 'entries')} />
        <Figure label="Spent" value={money(s.spent)}
          note={`${plural(s.billCount, 'bill')}, ${plural(purchasesIn(state, period).length, 'purchase')}`} />
        <Figure label="Net" value={money(s.net)}
          note={s.net >= 0 ? 'kept this month' : 'overspent'} negative={s.net < 0} />
        <Figure label="Saved" value={money(s.savedNet)}
          note={s.income > 0 ? `${Math.round(s.savingsRate * 100)}% of income` : 'no income recorded'} />
      </div>

      {s.overdueCount ? (
        <div class="notice danger">
          <strong>{`${plural(s.overdueCount, 'bill')} overdue. `}</strong>
          Settle them on the Bills tab.
        </div>
      ) : null}

      <div class="two-col">
        <div class="stack">
          <Sheet>
            <SheetHead>
              <h2>Income vs spending</h2>
              <span class="muted spacer">{`last ${TREND_MONTHS} months`}</span>
            </SheetHead>
            <SheetBody><TrendChart state={state} period={period} /></SheetBody>
          </Sheet>
          <Sheet>
            <SheetHead>
              <h2>Where it went</h2>
              <span class="muted spacer">{periodLabel(period, state.settings.locale)}</span>
            </SheetHead>
            <SheetBody>
              <CategoryBars records={outgoings} total={s.spent} settings={state.settings} />
            </SheetBody>
          </Sheet>
        </div>

        <div class="stack">
          <Sheet>
            <SheetHead>
              <h2>Overdue &amp; due soon</h2>
              <span class="muted spacer">{`unpaid, through ${LOOKAHEAD_DAYS} days`}</span>
            </SheetHead>
            {upcoming.length
              ? (
                <SheetBody flush>
                  <Table headers={[{ label: 'Bill' }, { label: 'Due' }, { label: 'Amount', num: true }]}>
                    {upcoming.slice(0, 10).map((b) => (
                      <tr key={b.id}>
                        <td>
                          <div>{b.name}</div>
                          <span class={`status ${b.overdue ? 'overdue' : 'due'}`}>
                            {b.overdue ? 'Overdue' : 'Due'}
                          </span>
                        </td>
                        <td class="num">{b.dueDate}</td>
                        <td class="num">{money(b.amount)}</td>
                      </tr>
                    ))}
                  </Table>
                </SheetBody>
              )
              : (
                <div class="empty">
                  <strong>Nothing due</strong>
                  {`No overdue bills, none due in ${LOOKAHEAD_DAYS} days.`}
                </div>
              )}
          </Sheet>

          <Sheet>
            <SheetHead>
              <h2>Accounts</h2>
              <span class="muted spacer num">{money(totalSavings(state) + gold.value)}</span>
            </SheetHead>
            <SheetBody>
              <AccountsPanel state={state} goldValue={gold.value} goldGrams={gold.grams} />
            </SheetBody>
          </Sheet>
        </div>
      </div>
    </div>
  );
}
