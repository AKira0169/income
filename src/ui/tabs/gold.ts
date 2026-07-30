/* ui/tabs/gold.ts — grams held by karat, valued against the live price. */

import { el } from '../../dom.ts';
import { isBusy, refresh } from '../../gold.ts';
import {
  GOLD_KARATS, goldHoldings, goldIn, goldPricePerGram, goldSummary, latestGoldPrice,
  parseMoney, periodLabel, plural, remove, save, sortByDateDesc, state, toMajor, upsert
} from '../../store.ts';
import type { GoldEntry } from '../../types.ts';
import { confirmDelete, followDate, toast } from '../feedback.ts';
import { FIELDS } from '../fields.ts';
import { accountName, money, percent } from '../format.ts';
import { addSection, openEditor } from '../forms.ts';
import { emptyRow, listRows, rowActions, table } from '../tables.ts';
import { isAllTime, isOpen, render, scopeToggle, toggle, view } from '../view.ts';
import { figure, settingRow } from '../widgets.ts';

const COLUMNS = 8;
/** Readings shown in the table, and the window the sparkline is drawn over. */
const HISTORY_ROWS = 14;
const SPARK_READINGS = 60;

function priceLine(): HTMLElement {
  const snapshot = latestGoldPrice();
  const manual = (Number(state.settings.goldManualPrice) || 0) > 0;
  const premium = Number(state.settings.goldPremium) || 0;

  if (!snapshot && !manual) {
    return el('div', { class: 'empty' }, [
      el('strong', { text: 'No price yet' }),
      state.settings.goldSync === false
        ? 'Price syncing is switched off. Turn it on below, or type a price in yourself.'
        : 'Press "Update price" to fetch today\'s rate, or type one in yourself below.'
    ]);
  }

  const note = manual
    ? 'Your own price, used exactly as typed'
    : `World spot × USD/EGP${premium ? ` + ${premium}% shop premium` : ''}` +
      ` · $${(snapshot?.usdPerOz ?? 0).toFixed(2)}/oz · E£${(snapshot?.egpPerUsd ?? 0).toFixed(2)}/$`;

  return el('div', {}, [
    el('div', { class: 'gold-prices' }, GOLD_KARATS.map((karat) =>
      el('div', { class: `gold-price${karat === 21 ? ' is-lead' : ''}` }, [
        el('div', { class: 'label', text: `${karat}k` }),
        el('div', { class: 'gold-price-value', text: money(goldPricePerGram(karat)) }),
        el('div', { class: 'muted', text: 'per gram' })
      ]))),
    el('p', { class: 'muted', style: 'margin:12px 0 0' },
      note + (manual || !snapshot ? '' : ` · taken ${snapshot.date}`))
  ]);
}

function priceSettings(): HTMLElement {
  const settings = state.settings;

  const sync = el('input', { type: 'checkbox' });
  sync.checked = settings.goldSync !== false;

  const premium = el('input', {
    type: 'number', step: '0.5', min: '0', max: '100',
    value: String(Number(settings.goldPremium) || 0)
  });

  const manual = el('input', {
    type: 'text', inputmode: 'decimal',
    value: Number(settings.goldManualPrice) ? toMajor(settings.goldManualPrice).toFixed(2) : '',
    placeholder: 'leave empty to use the synced price'
  });

  return el('div', {}, [
    el('p', { class: 'muted', style: 'margin-top:0' },
      'Gold is quoted worldwide in dollars per ounce. This app fetches that figure and the ' +
      'pound rate once a day and works out the price per gram — which is the bourse price, ' +
      'a little under what a shop quotes. The premium closes that gap. If the figure here ' +
      'ever drifts from the board in the shop, type theirs in and nothing is fetched at all.'),
    el('div', { class: 'form-grid' }, [
      settingRow('Update the price online', sync, 'Once a day, when you open the app'),
      settingRow('Shop premium %', premium, 'Starts at 2%, which matched the Cairo boards'),
      settingRow('Your own price for 24k (per gram)', manual, 'Overrides everything above')
    ]),
    el('div', { class: 'btn-row', style: 'margin-top:16px' }, [
      el('button', {
        class: 'primary', text: 'Save price settings',
        onclick: () => {
          settings.goldSync = sync.checked;
          settings.goldPremium = Number(premium.value) || 0;
          settings.goldManualPrice = parseMoney(manual.value);
          save();
          render();
          toast('Price settings saved');
        }
      })
    ])
  ]);
}

/** A plain line of the daily readings — enough to see which way it is going. */
function sparkline(): HTMLElement | null {
  const history = state.goldPrices
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-SPARK_READINGS);
  if (history.length < 2) return null;

  const values = history.map((p) => p.egpPerGram24 || 0);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = (max - min) || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * 100;
    const y = 30 - ((v - min) / span) * 28 - 1;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  const ns = 'http://www.w3.org/2000/svg';
  const chart = document.createElementNS(ns, 'svg');
  chart.setAttribute('viewBox', '0 0 100 30');
  chart.setAttribute('preserveAspectRatio', 'none');
  chart.setAttribute('class', 'spark');
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `Gold price per gram, last ${history.length} readings`);

  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', points);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  chart.appendChild(line);

  return el('div', {}, [
    chart,
    el('div', { class: 'legend' }, [
      el('span', { text: `${history[0]!.date} · ${money(min)}` }),
      el('span', { text: `now · ${money(values[values.length - 1]!)}` })
    ])
  ]);
}

function goldRow(r: GoldEntry): HTMLTableRowElement {
  const sold = r.direction === 'sell';
  const grams = Number(r.grams) || 0;
  const name = accountName(r.accountId);

  return el('tr', {}, [
    el('td', { class: 'num', text: r.date }),
    el('td', {}, [
      el('span', { class: `status ${sold ? 'overdue' : 'paid'}`, text: sold ? 'Sold' : 'Bought' }),
      r.dealer ? el('span', { class: 'cell-sub', text: r.dealer }) : null
    ]),
    el('td', { class: 'num', text: `${Number(r.karat) || 24}k` }),
    el('td', { class: 'num', text: `${grams.toFixed(3)} g` }),
    el('td', { class: 'num', text: `${sold ? '+' : '−'}${money(r.amount)}` }),
    el('td', { class: 'num muted', text: grams ? `${money(Math.round((r.amount || 0) / grams))}/g` : '—' }),
    el('td', {}, [
      name ? el('div', { text: name }) : el('span', { class: 'faint', text: 'not linked' })
    ]),
    rowActions(
      () => openEditor('Edit gold entry', FIELDS.gold, r, (d) => {
        d.karat = Number(d.karat);
        upsert('gold', d);
      }),
      () => { if (confirmDelete('gold entry')) { remove('gold', r.id); render(); } }
    )
  ]);
}

export function renderGold(): HTMLElement {
  const period = view.period;
  const all = isAllTime('gold');
  const summary = goldSummary();
  const holdings = goldHoldings();
  const records = sortByDateDesc(all ? state.gold : goldIn(period), 'date');
  const history = sortByDateDesc(state.goldPrices, 'date').slice(0, HISTORY_ROWS);
  const spark = sparkline();

  return el('div', { class: 'stack' }, [
    el('div', { class: 'figures' }, [
      figure('Gold held', `${summary.grams.toFixed(2)} g`, `${summary.pure.toFixed(2)} g pure`),
      figure('Worth today', money(summary.value),
        summary.price ? `priced ${summary.price.date}` : 'no price yet'),
      figure('Paid for it', money(summary.invested), plural(state.gold.length, 'entry', 'entries')),
      figure(summary.gain >= 0 ? 'Gain' : 'Loss', money(summary.gain),
        summary.invested ? `${percent(summary.gainRate)} on what you paid` : 'nothing bought yet',
        summary.gain < 0)
    ]),

    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: 'Price per gram' }),
        el('span', { class: 'muted spacer' },
          state.settings.goldSync === false ? 'syncing off' : 'updated once a day'),
        el('button', {
          text: isBusy() ? 'Updating…' : 'Update price',
          disabled: isBusy(),
          onclick: () => {
            toast('Fetching today\'s price…');
            void refresh({ manual: true }).then((result) => {
              render();
              if (result.ok && result.partial) toast(`Price updated, partly — ${result.error}`);
              else if (result.ok) toast('Price updated');
              else toast(result.error || 'Could not update the price');
            });
          }
        }),
        el('button', {
          'aria-expanded': isOpen('gold-settings') ? 'true' : 'false',
          text: isOpen('gold-settings') ? 'Hide settings' : 'Price settings',
          onclick: () => toggle('gold-settings')
        })
      ]),
      el('div', { class: 'sheet-body' }, [priceLine()]),
      isOpen('gold-settings') ? el('div', { class: 'disclosure-body' }, [priceSettings()]) : null
    ]),

    el('div', { class: 'two-col' }, [
      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: 'What you hold' }),
          el('span', { class: 'muted spacer num', text: money(summary.value) })
        ]),
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Karat' }, { label: 'Grams', num: true }, { label: 'Price / g', num: true },
            { label: 'Worth', num: true }],
          holdings.length
            ? holdings.map((h) => el('tr', {}, [
              el('td', { text: `${h.karat}k` }),
              el('td', { class: 'num', text: h.grams.toFixed(3) }),
              el('td', { class: 'num muted', text: money(goldPricePerGram(h.karat)) }),
              el('td', { class: 'num', text: money(h.value) })
            ]))
            : [emptyRow(4, 'No gold held', 'Record what you bought below and it is valued at today\'s price.')]
        )])
      ]),

      el('section', { class: 'sheet' }, [
        el('div', { class: 'sheet-head' }, [
          el('h2', { text: 'Price history' }),
          el('span', { class: 'muted spacer', text: plural(state.goldPrices.length, 'reading') })
        ]),
        spark ? el('div', { class: 'sheet-body' }, [spark]) : null,
        el('div', { class: 'sheet-body flush' }, [table(
          [{ label: 'Date' }, { label: '24k / g', num: true }, { label: '$/oz', num: true },
            { label: 'E£/$', num: true }],
          history.length
            ? history.map((p) => el('tr', {}, [
              el('td', { class: 'num', text: p.date }),
              el('td', { class: 'num', text: money(p.egpPerGram24) }),
              el('td', { class: 'num muted', text: (p.usdPerOz || 0).toFixed(2) }),
              el('td', { class: 'num muted', text: (p.egpPerUsd || 0).toFixed(2) })
            ]))
            : [emptyRow(4, 'Nothing recorded yet', 'Each day you open the app, that day\'s price is kept here.')]
        )])
      ])
    ]),

    addSection('add-gold', 'Gold you bought or sold', 'Add gold', FIELDS.gold, (data) => {
      data.karat = Number(data.karat);
      const grams = Number(data.grams) || 0;
      const amount = Number(data.amount) || 0;
      data.pricePerGram = grams ? Math.round(amount / grams) : 0;
      upsert('gold', data);
      followDate(String(data.date ?? ''),
        data.direction === 'sell' ? 'Sale recorded' : 'Purchase recorded');
    }, !state.gold.length),

    el('section', { class: 'sheet' }, [
      el('div', { class: 'sheet-head' }, [
        el('h2', { text: all ? 'All gold entries' : periodLabel(period) }),
        el('span', { class: 'muted', text: plural(records.length, 'entry', 'entries') }),
        el('div', { class: 'spacer' }, [scopeToggle('gold')])
      ]),
      el('div', { class: 'sheet-body flush' }, [table(
        [{ label: 'Date' }, { label: 'Bought / sold' }, { label: 'Karat', num: true },
          { label: 'Grams', num: true }, { label: 'Amount', num: true }, { label: 'Per gram', num: true },
          { label: 'Account' }, { label: '', actions: true }],
        records.length
          ? listRows('gold', records, 'date', COLUMNS, goldRow)
          : [emptyRow(COLUMNS,
            all ? 'No gold recorded yet' : `Nothing in ${periodLabel(period)}`,
            'Every gram you buy is tracked against the live price.')]
      )])
    ])
  ]);
}
