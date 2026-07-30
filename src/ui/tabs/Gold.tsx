/* ui/tabs/Gold.tsx — grams held by karat, valued against the live price. */

import { useRef, useState } from 'preact/hooks';
import { GOLD_KARATS } from '../../domain/catalog.ts';
import { formatMoney, parseMoney, plural, toMajor } from '../../domain/money.ts';
import { periodLabel } from '../../domain/period.ts';
import { sortByDateDesc } from '../../domain/records.ts';
import { accountName } from '../../domain/selectors.ts';
import {
  goldHoldings, goldIn, goldPricePerGram, goldSummary, latestGoldPrice
} from '../../domain/gold.ts';
import { isBusy, refresh } from '../../data/gold-price.ts';
import { remove, updateSettings, upsert } from '../../state/actions.ts';
import { app } from '../../state/app.ts';
import { period as routePeriod } from '../../state/route.ts';
import type { AppState, GoldEntry } from '../../domain/types.ts';
import { Editor } from '../components/Dialog.tsx';
import { Figure, SettingRow } from '../components/Figure.tsx';
import { ScopeToggle } from '../components/ScopeToggle.tsx';
import { AddSection, Sheet, SheetBody, SheetHead } from '../components/Sheet.tsx';
import { EmptyRow, listRows, RowActions, Table } from '../components/Table.tsx';
import { toast } from '../components/Toast.tsx';
import { confirmDelete, followDate } from '../feedback.ts';
import { FIELDS } from '../fields.ts';

const COLUMNS = 8;
/** Readings shown in the table, and the window the sparkline is drawn over. */
const HISTORY_ROWS = 14;
const SPARK_READINGS = 60;

const HEADERS = [
  { label: 'Date' }, { label: 'Bought / sold' }, { label: 'Karat', num: true },
  { label: 'Grams', num: true }, { label: 'Amount', num: true }, { label: 'Per gram', num: true },
  { label: 'Account' }, { label: '', actions: true }
];

/* Whole percents read better, except near zero where rounding would report a
   real movement as no movement at all. */
function percent(rate: number): string {
  const value = rate * 100;
  const body = (Math.abs(value) < 9.5 && value !== 0) ? value.toFixed(1) : String(Math.round(value));
  return `${body}%`;
}

/** A plain line of the daily readings — enough to see which way it is going. */
function Sparkline({ state }: { state: AppState }) {
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

  const money = (cents: number): string => formatMoney(cents, state.settings);

  return (
    <div>
      <svg
        viewBox="0 0 100 30" preserveAspectRatio="none" class="spark" role="img"
        aria-label={`Gold price per gram, last ${history.length} readings`}
      >
        <polyline
          points={points} fill="none" stroke="currentColor"
          stroke-width="1" vector-effect="non-scaling-stroke"
        />
      </svg>
      <div class="legend">
        <span>{`${history[0]!.date} · ${money(min)}`}</span>
        <span>{`now · ${money(values[values.length - 1]!)}`}</span>
      </div>
    </div>
  );
}

function PriceLine({ state }: { state: AppState }) {
  const snapshot = latestGoldPrice(state);
  const manual = (Number(state.settings.goldManualPrice) || 0) > 0;
  const premium = Number(state.settings.goldPremium) || 0;

  if (!snapshot && !manual) {
    return (
      <div class="empty">
        <strong>No price yet</strong>
        {state.settings.goldSync === false
          ? 'Price syncing is switched off. Turn it on below, or type a price in yourself.'
          : 'Press "Update price" to fetch today\'s rate, or type one in yourself below.'}
      </div>
    );
  }

  const note = manual
    ? 'Your own price, used exactly as typed'
    : `World spot × USD/EGP${premium ? ` + ${premium}% shop premium` : ''}`
      + ` · $${(snapshot?.usdPerOz ?? 0).toFixed(2)}/oz · E£${(snapshot?.egpPerUsd ?? 0).toFixed(2)}/$`;

  return (
    <div>
      <div class="gold-prices">
        {GOLD_KARATS.map((karat) => (
          <div class={karat === 21 ? 'gold-price is-lead' : 'gold-price'} key={karat}>
            <div class="label">{`${karat}k`}</div>
            <div class="gold-price-value">{formatMoney(goldPricePerGram(state, karat), state.settings)}</div>
            <div class="muted">per gram</div>
          </div>
        ))}
      </div>
      <p class="muted" style="margin:12px 0 0">
        {note + (manual || !snapshot ? '' : ` · taken ${snapshot.date}`)}
      </p>
    </div>
  );
}

function PriceSettings({ state }: { state: AppState }) {
  const settings = state.settings;
  /* Remounted whenever the stored settings change, so the fields show what was
     saved — and never while they are being typed into, because a save is the
     only thing that changes them. */
  const key = `${settings.goldSync}|${settings.goldPremium}|${settings.goldManualPrice}`;
  const sync = useRef<HTMLInputElement>(null);
  const premium = useRef<HTMLInputElement>(null);
  const manual = useRef<HTMLInputElement>(null);

  return (
    <div key={key}>
      <p class="muted" style="margin-top:0">
        Gold is quoted worldwide in dollars per ounce. This app fetches that figure and the
        pound rate once a day and works out the price per gram — which is the bourse price,
        a little under what a shop quotes. The premium closes that gap. If the figure here
        ever drifts from the board in the shop, type theirs in and nothing is fetched at all.
      </p>
      <div class="form-grid">
        <SettingRow label="Update the price online" hint="Once a day, when you open the app">
          <input
            type="checkbox" ref={sync}
            defaultChecked={settings.goldSync !== false}
          />
        </SettingRow>
        <SettingRow label="Shop premium %" hint="Starts at 2%, which matched the Cairo boards">
          <input
            type="number" step="0.5" min="0" max="100" ref={premium}
            defaultValue={String(Number(settings.goldPremium) || 0)}
          />
        </SettingRow>
        <SettingRow label="Your own price for 24k (per gram)" hint="Overrides everything above">
          <input
            type="text" inputMode="decimal" ref={manual}
            placeholder="leave empty to use the synced price"
            defaultValue={Number(settings.goldManualPrice)
              ? toMajor(settings.goldManualPrice).toFixed(2) : ''}
          />
        </SettingRow>
      </div>
      <div class="btn-row" style="margin-top:16px">
        <button
          class="primary"
          onClick={() => {
            updateSettings({
              goldSync: !!sync.current?.checked,
              goldPremium: Number(premium.current?.value) || 0,
              goldManualPrice: parseMoney(manual.current?.value ?? '')
            });
            toast('Price settings saved');
          }}
        >Save price settings</button>
      </div>
    </div>
  );
}

export function Gold() {
  const state = app.value;
  const period = routePeriod.value;
  const [allTime, setAllTime] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editing, setEditing] = useState<GoldEntry | null>(null);
  /* isBusy() is a plain flag inside the fetcher rather than state, so the
     button needs its own reason to redraw while a fetch is in flight. */
  const [fetching, setFetching] = useState(false);

  const summary = goldSummary(state);
  const holdings = goldHoldings(state);
  const records = sortByDateDesc(allTime ? state.gold : goldIn(state, period), 'date');
  const history = sortByDateDesc(state.goldPrices, 'date').slice(0, HISTORY_ROWS);
  const money = (cents: number): string => formatMoney(cents, state.settings);
  const label = periodLabel(period, state.settings.locale);

  const row = (r: GoldEntry) => {
    const sold = r.direction === 'sell';
    const grams = Number(r.grams) || 0;
    const name = accountName(state, r.accountId);

    return (
      <tr key={r.id}>
        <td class="num">{r.date}</td>
        <td>
          <span class={`status ${sold ? 'overdue' : 'paid'}`}>{sold ? 'Sold' : 'Bought'}</span>
          {r.dealer ? <span class="cell-sub">{r.dealer}</span> : null}
        </td>
        <td class="num">{`${Number(r.karat) || 24}k`}</td>
        <td class="num">{`${grams.toFixed(3)} g`}</td>
        <td class="num">{`${sold ? '+' : '−'}${money(r.amount)}`}</td>
        <td class="num muted">{grams ? `${money(Math.round((r.amount || 0) / grams))}/g` : '—'}</td>
        <td>{name ? <div>{name}</div> : <span class="faint">not linked</span>}</td>
        <RowActions
          onEdit={() => setEditing(r)}
          onDelete={() => { if (confirmDelete('gold entry')) remove('gold', r.id); }}
        />
      </tr>
    );
  };

  return (
    <div class="stack">
      <div class="figures">
        <Figure label="Gold held" value={`${summary.grams.toFixed(2)} g`}
          note={`${summary.pure.toFixed(2)} g pure`} />
        <Figure label="Worth today" value={money(summary.value)}
          note={summary.price ? `priced ${summary.price.date}` : 'no price yet'} />
        <Figure label="Paid for it" value={money(summary.invested)}
          note={plural(state.gold.length, 'entry', 'entries')} />
        <Figure
          label={summary.gain >= 0 ? 'Gain' : 'Loss'} value={money(summary.gain)}
          note={summary.invested ? `${percent(summary.gainRate)} on what you paid` : 'nothing bought yet'}
          negative={summary.gain < 0}
        />
      </div>

      <Sheet>
        <SheetHead>
          <h2>Price per gram</h2>
          <span class="muted spacer">
            {state.settings.goldSync === false ? 'syncing off' : 'updated once a day'}
          </span>
          <button
            disabled={fetching || isBusy()}
            onClick={() => {
              setFetching(true);
              toast('Fetching today\'s price…');
              void refresh({ manual: true }).then((result) => {
                setFetching(false);
                if (result.ok && result.partial) toast(`Price updated, partly — ${result.error}`);
                else if (result.ok) toast('Price updated');
                else toast(result.error || 'Could not update the price');
              });
            }}
          >{fetching || isBusy() ? 'Updating…' : 'Update price'}</button>
          <button
            aria-expanded={settingsOpen ? 'true' : 'false'}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >{settingsOpen ? 'Hide settings' : 'Price settings'}</button>
        </SheetHead>
        <SheetBody><PriceLine state={state} /></SheetBody>
        {settingsOpen ? <div class="disclosure-body"><PriceSettings state={state} /></div> : null}
      </Sheet>

      <div class="two-col">
        <Sheet>
          <SheetHead>
            <h2>What you hold</h2>
            <span class="muted spacer num">{money(summary.value)}</span>
          </SheetHead>
          <SheetBody flush>
            <Table headers={[{ label: 'Karat' }, { label: 'Grams', num: true },
              { label: 'Price / g', num: true }, { label: 'Worth', num: true }]}
            >
              {holdings.length
                ? holdings.map((h) => (
                  <tr key={h.karat}>
                    <td>{`${h.karat}k`}</td>
                    <td class="num">{h.grams.toFixed(3)}</td>
                    <td class="num muted">{money(goldPricePerGram(state, h.karat))}</td>
                    <td class="num">{money(h.value)}</td>
                  </tr>
                ))
                : (
                  <EmptyRow colspan={4} title="No gold held"
                    hint="Record what you bought below and it is valued at today's price." />
                )}
            </Table>
          </SheetBody>
        </Sheet>

        <Sheet>
          <SheetHead>
            <h2>Price history</h2>
            <span class="muted spacer">{plural(state.goldPrices.length, 'reading')}</span>
          </SheetHead>
          <SheetBody><Sparkline state={state} /></SheetBody>
          <SheetBody flush>
            <Table headers={[{ label: 'Date' }, { label: '24k / g', num: true },
              { label: '$/oz', num: true }, { label: 'E£/$', num: true }]}
            >
              {history.length
                ? history.map((p) => (
                  <tr key={p.id}>
                    <td class="num">{p.date}</td>
                    <td class="num">{money(p.egpPerGram24)}</td>
                    <td class="num muted">{(p.usdPerOz || 0).toFixed(2)}</td>
                    <td class="num muted">{(p.egpPerUsd || 0).toFixed(2)}</td>
                  </tr>
                ))
                : (
                  <EmptyRow colspan={4} title="Nothing recorded yet"
                    hint="Each day you open the app, that day's price is kept here." />
                )}
            </Table>
          </SheetBody>
        </Sheet>
      </div>

      <AddSection
        title="Gold you bought or sold"
        addLabel="Add gold"
        fields={FIELDS.gold}
        state={state}
        forceOpen={!state.gold.length}
        onInvalid={() => toast('Fill in the required fields')}
        onSubmit={(data) => {
          data.karat = Number(data.karat);
          const grams = Number(data.grams) || 0;
          const amount = Number(data.amount) || 0;
          data.pricePerGram = grams ? Math.round(amount / grams) : 0;
          upsert('gold', data);
          followDate(String(data.date ?? ''),
            data.direction === 'sell' ? 'Sale recorded' : 'Purchase recorded');
        }}
      />

      <Sheet>
        <SheetHead>
          <h2>{allTime ? 'All gold entries' : label}</h2>
          <span class="muted">{plural(records.length, 'entry', 'entries')}</span>
          <div class="spacer"><ScopeToggle allTime={allTime} onChange={setAllTime} /></div>
        </SheetHead>
        <SheetBody flush>
          <Table headers={HEADERS}>
            {records.length
              ? listRows({ records, dateKey: 'date', colspan: COLUMNS, row, grouped: allTime, state })
              : (
                <EmptyRow
                  colspan={COLUMNS}
                  title={allTime ? 'No gold recorded yet' : `Nothing in ${label}`}
                  hint="Every gram you buy is tracked against the live price."
                />
              )}
          </Table>
        </SheetBody>
      </Sheet>

      {editing ? (
        <Editor
          title="Edit gold entry" fields={FIELDS.gold} record={editing} state={state}
          onInvalid={() => toast('Fill in the required fields')}
          onSave={(data) => { upsert('gold', { ...data, karat: Number(data.karat) }); toast('Saved'); }}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
