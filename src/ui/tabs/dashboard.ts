/* ui/tabs/dashboard.ts — the month at a glance. */

import { el } from '../../dom.ts';
import type { Child } from '../../dom.ts';
import {
  accountBalance, billsIn, goldSummary, groupByCategory, incomeIn, periodLabel,
  plural, purchasesIn, state, summary, totalSavings, trend, upcomingBills
} from '../../store.ts';
import type { Bill, Cents, Category, Period, Purchase } from '../../domain/types.ts';
import { money } from '../format.ts';
import { table } from '../tables.ts';
import { view } from '../view.ts';
import { figure, targetProgress } from '../widgets.ts';

/** Bills already overdue plus everything falling due inside this window. */
const LOOKAHEAD_DAYS = 45;
const TREND_MONTHS = 6;
const MAX_CATEGORY_BARS = 8;

function trendChart(period: Period): HTMLDivElement {
  const data = trend(period, TREND_MONTHS);
  const max = Math.max(1, ...data.map((d) => Math.max(d.income, d.spent)));

  return el('div', {}, [
    el('div', { class: 'trend' }, data.map((d) => el('div', {
      class: 'trend-col',
      title: `${periodLabel(d.period)} — in ${money(d.income)}, out ${money(d.spent)}`
    }, [
      el('div', { class: 'trend-bars' }, [
        el('div', { class: 'trend-bar in', style: `height:${Math.max((d.income / max) * 100, 1)}%` }),
        el('div', { class: 'trend-bar out', style: `height:${Math.max((d.spent / max) * 100, 1)}%` })
      ]),
      el('div', { class: 'trend-label', text: `${d.period.slice(5)}/${d.period.slice(2, 4)}` })
    ]))),
    el('div', { class: 'legend' }, [
      el('span', {}, [el('i', { style: 'background:var(--ink-strong)' }), 'Income']),
      el('span', {}, [
        el('i', { style: 'background:repeating-linear-gradient(45deg,var(--ink-faint) 0 2px,transparent 2px 4px);border:1px solid var(--ink-faint)' }),
        'Spent'
      ])
    ])
  ]);
}

function categoryBars(records: ReadonlyArray<{ category?: Category; amount?: Cents }>, total: Cents): HTMLDivElement {
  const groups = groupByCategory(records).slice(0, MAX_CATEGORY_BARS);
  if (!groups.length) {
    return el('div', { class: 'empty' }, [
      el('strong', { text: 'Nothing spent yet' }),
      'Add bills or purchases to see the breakdown.'
    ]);
  }
  const max = groups[0]!.amount || 1;
  return el('div', { class: 'bars' }, groups.map((g) => el('div', { class: 'bar-row' }, [
    el('div', { class: 'bar-name', text: g.category }),
    el('div', { class: 'bar-value', text: money(g.amount) + (total ? `  ${Math.round((g.amount / total) * 100)}%` : '') }),
    el('div', { class: 'bar-track' }, [
      el('div', { class: 'bar-fill', style: `width:${(g.amount / max) * 100}%` })
    ])
  ])));
}

function accountsPanel(goldValue: Cents, goldGrams: number): Child {
  if (!state.accounts.length) {
    return el('div', { class: 'empty' }, [
      el('strong', { text: 'No accounts yet' }),
      'Add one on the Accounts tab.'
    ]);
  }

  const rows: Child[] = state.accounts.map((a) => {
    const balance = accountBalance(a.id);
    return el('div', {}, [
      el('div', { class: 'bar-row' }, [
        el('div', { class: 'bar-name', text: a.name }),
        el('div', { class: 'bar-value', text: money(balance) })
      ]),
      targetProgress(balance, a.target)
    ]);
  });

  if (goldValue) {
    rows.push(el('div', {}, [
      el('div', { class: 'bar-row' }, [
        el('div', { class: 'bar-name', text: `Gold · ${goldGrams.toFixed(2)} g` }),
        el('div', { class: 'bar-value', text: money(goldValue) })
      ])
    ]));
  }

  return el('div', { class: 'stack-tight' }, rows);
}

export function renderDashboard(): HTMLElement {
  const period = view.period;
  const s = summary(period);
  const upcoming = upcomingBills(LOOKAHEAD_DAYS);
  const gold = goldSummary();
  const outgoings: Array<Bill | Purchase> = [...billsIn(period), ...purchasesIn(period)];

  return el('div', { class: 'stack' }, [
    el('div', { class: 'figures' }, [
      figure('Income', money(s.income), plural(incomeIn(period).length, 'entry', 'entries')),
      figure('Spent', money(s.spent),
        `${plural(s.billCount, 'bill')}, ${plural(purchasesIn(period).length, 'purchase')}`),
      figure('Net', money(s.net), s.net >= 0 ? 'kept this month' : 'overspent', s.net < 0),
      figure('Saved', money(s.savedNet),
        s.income > 0 ? `${Math.round(s.savingsRate * 100)}% of income` : 'no income recorded')
    ]),

    s.overdueCount ? el('div', { class: 'notice danger' }, [
      el('strong', { text: `${plural(s.overdueCount, 'bill')} overdue. ` }),
      'Settle them on the Bills tab.'
    ]) : null,

    el('div', { class: 'two-col' }, [
      el('div', { class: 'stack' }, [
        el('section', { class: 'sheet' }, [
          el('div', { class: 'sheet-head' }, [
            el('h2', { text: 'Income vs spending' }),
            el('span', { class: 'muted spacer', text: `last ${TREND_MONTHS} months` })
          ]),
          el('div', { class: 'sheet-body' }, [trendChart(period)])
        ]),
        el('section', { class: 'sheet' }, [
          el('div', { class: 'sheet-head' }, [
            el('h2', { text: 'Where it went' }),
            el('span', { class: 'muted spacer', text: periodLabel(period) })
          ]),
          el('div', { class: 'sheet-body' }, [categoryBars(outgoings, s.spent)])
        ])
      ]),

      el('div', { class: 'stack' }, [
        el('section', { class: 'sheet' }, [
          el('div', { class: 'sheet-head' }, [
            el('h2', { text: 'Overdue & due soon' }),
            el('span', { class: 'muted spacer', text: `unpaid, through ${LOOKAHEAD_DAYS} days` })
          ]),
          upcoming.length
            ? el('div', { class: 'sheet-body flush' }, [table(
              [{ label: 'Bill' }, { label: 'Due' }, { label: 'Amount', num: true }],
              upcoming.slice(0, 10).map((b) => el('tr', {}, [
                el('td', {}, [
                  el('div', { text: b.name }),
                  el('span', {
                    class: `status ${b.overdue ? 'overdue' : 'due'}`,
                    text: b.overdue ? 'Overdue' : 'Due'
                  })
                ]),
                el('td', { class: 'num', text: b.dueDate }),
                el('td', { class: 'num', text: money(b.amount) })
              ]))
            )])
            : el('div', { class: 'empty' }, [
              el('strong', { text: 'Nothing due' }),
              `No overdue bills, none due in ${LOOKAHEAD_DAYS} days.`
            ])
        ]),

        el('section', { class: 'sheet' }, [
          el('div', { class: 'sheet-head' }, [
            el('h2', { text: 'Accounts' }),
            el('span', { class: 'muted spacer num', text: money(totalSavings() + gold.value) })
          ]),
          el('div', { class: 'sheet-body' }, [accountsPanel(gold.value, gold.grams)])
        ])
      ])
    ])
  ]);
}
