/* domain/records.ts — the state object itself, and the writes that produce a
   new one.

   Every function here is pure: it takes a state and returns the next state
   rather than editing the one it was given. That is not styling. The UI layer
   holds the state in a signal, and a signal compares with `===` — a write that
   edited the object in place would notify nobody and the screen would silently
   disagree with the data. Replacing the collection array (and the record inside
   it) is what makes a change visible. */

import { COLLECTION_KEYS, ID_PREFIX, SCHEMA_VERSION } from './catalog.ts';
import { currentPeriod, periodOf } from './period.ts';
import type {
  AppState, Bill, BillStatus, CollectionKey, Id, Period, RecordOf, Settings
} from './types.ts';

export function blankState(): AppState {
  return {
    version: SCHEMA_VERSION,
    settings: {
      currencySymbol: 'E£',
      currencyCode: 'EGP',
      locale: 'en-EG',
      savingsGoalRate: 20,
      autoGenerate: true,
      /* Gold. The price is fetched from the world spot market and converted to
         pounds; goldPremium is the margin an Egyptian shop adds on top, and
         goldManualPrice overrides the lot with a figure you typed in.

         2% is not a guess: on 30 July 2026 the spot conversion gave E£6,653.79
         a gram for 24k while the shops were quoting E£6,775 — 1.82% over. The
         gap moves, which is why it is a setting and not a constant. */
      goldSync: true,
      goldPremium: 2,
      goldManualPrice: 0,

      /* The forecast's assumed monthly purchases. Auto averages the last three
         complete months; turning it off uses the figure you typed instead. */
      forecastSpendingAuto: true,
      forecastSpending: 0
    },
    income: [],
    incomeTemplates: [],
    billTemplates: [],
    bills: [],
    purchases: [],
    accounts: [],
    goals: [],
    savingsTx: [],
    gold: [],
    goldPrices: []
  };
}

/** Deliberately forgiving, so a save written by any earlier build still loads. */
export function migrate(loaded: unknown): AppState {
  const base = blankState();
  if (!loaded || typeof loaded !== 'object') return base;
  const source = loaded as Partial<AppState>;
  /* Assigned onto the fresh defaults rather than spread over them: this is the
     step that fills in any setting the stored copy predates. */
  base.settings = Object.assign(base.settings, source.settings ?? {});
  for (const key of COLLECTION_KEYS) {
    const value = source[key];
    // Each collection is written back under its own key, so the cast is only
    // reasserting the pairing the key already implies.
    (base as Record<CollectionKey, unknown>)[key] = Array.isArray(value) ? value : [];
  }
  base.version = SCHEMA_VERSION;
  return base;
}

export function uid(prefix = 'id'): Id {
  const rnd = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  return `${prefix}_${rnd}`;
}

export function sortByDateDesc<T extends { id: Id }>(list: readonly T[], key: keyof T): T[] {
  return list.slice().sort((a, b) => {
    const byDate = String(b[key] ?? '').localeCompare(String(a[key] ?? ''));
    return byDate !== 0 ? byDate : String(b.id).localeCompare(String(a.id));
  });
}

/** A record on its way in: an id means update, no id means insert. Callers
    routinely send only the fields they are changing. */
export type Draft<K extends CollectionKey> = Partial<RecordOf<K>> & { id?: Id };

/** Replaces one collection, leaving every other reference in place. The shallow
    copy is what a signal reads as "something changed". */
export function withCollection<K extends CollectionKey>(
  state: AppState, collection: K, list: readonly RecordOf<K>[]
): AppState {
  return { ...state, [collection]: list } as AppState;
}

export interface UpsertResult<K extends CollectionKey> {
  state: AppState;
  record: RecordOf<K>;
}

export function upsert<K extends CollectionKey>(
  state: AppState, collection: K, record: Draft<K>
): UpsertResult<K> {
  const list = state[collection] as RecordOf<K>[] | undefined;
  if (!list) throw new Error(`unknown collection: ${collection}`);

  const idx = record.id ? list.findIndex((r) => r.id === record.id) : -1;
  const existing = idx === -1 ? null : list[idx]!;
  const merged = {
    ...existing,
    ...record,
    id: record.id ?? uid(ID_PREFIX[collection])
  } as RecordOf<K>;

  /* Bills are the one record with fields derived from other fields, and this is
     the only way in. Leaving it to the caller meant a missed normalizeBill()
     filed a bill under the month of its *old* due date, or left one with a paid
     date still counted as outstanding — a wrong figure with nothing to see. */
  const saved = (collection === 'bills'
    ? normalizeBill(merged as Bill, (existing as Bill | null)?.period)
    : merged) as RecordOf<K>;

  const next = list.slice();
  if (idx === -1) next.push(saved);
  else next[idx] = saved;
  return { state: withCollection(state, collection, next), record: saved };
}

/** Settings are replaced as a whole object, so a write is one state change
    rather than one per field — and so it can be seen. */
export function updateSettings(state: AppState, patch: Partial<Settings>): AppState {
  return { ...state, settings: { ...state.settings, ...patch } };
}

export function remove(state: AppState, collection: CollectionKey, id: Id): AppState {
  const list = state[collection] as ReadonlyArray<{ id: Id }>;
  let next: AppState = { ...state, [collection]: list.filter((r) => r.id !== id) } as AppState;

  // Removing an account takes its movements with it, including transfers it
  // was the source of — those are its movements too.
  if (collection === 'accounts') {
    next.savingsTx = next.savingsTx.filter((t) => t.accountId !== id && t.fromAccountId !== id);
  }
  // Deleting a recurring definition keeps the entries it already produced,
  // orphaned rather than removed — that money really did move.
  if (collection === 'billTemplates') {
    next = withCollection(next, 'bills',
      next.bills.map((b) => (b.templateId === id ? { ...b, templateId: null } : b)));
  }
  if (collection === 'incomeTemplates') {
    next = withCollection(next, 'income',
      next.income.map((r) => (r.templateId === id ? { ...r, templateId: null } : r)));
  }
  /* Same rule for a goal you already bought: the purchase stays, orphaned.
     Deleting the wishlist entry is tidying a list, not getting the money back,
     and taking the purchase with it would put that money back on your balance
     out of nowhere. */
  if (collection === 'goals') {
    next = withCollection(next, 'purchases',
      next.purchases.map((p) => (p.goalId === id ? { ...p, goalId: null } : p)));
  }
  return next;
}

export function byId<K extends CollectionKey>(
  state: AppState, collection: K, id: Id | null | undefined
): RecordOf<K> | null {
  const list = state[collection] as RecordOf<K>[];
  return list.find((r) => r.id === id) ?? null;
}

/* A bill's period and paid status are both derived from its dates, so every
   write path must recompute them — otherwise editing a due date leaves the bill
   filed under the old month, and entering a paid date leaves it counted as
   outstanding. */
export function normalizeBill<T extends Partial<Bill>>(
  record: T,
  fallbackPeriod?: Period
): T & { period: Period; status: BillStatus } {
  return {
    ...record,
    period: periodOf(record.dueDate) || fallbackPeriod || currentPeriod(),
    status: record.paidDate ? 'paid' : 'unpaid'
  };
}
