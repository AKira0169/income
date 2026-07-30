/* store.ts — data model, persistence and derived figures.

   All money is an integer number of minor units (cents) so totals never drift.
   The working copy lives in memory and persistence is injected, so the browser
   writes through to SQLite while the Node tests run this identical logic
   against plain memory. */

import type {
  Account, AccountFlows, AppState, Bill, BillStatus, BillTemplate, CatchUpResult,
  Category, CategoryTotal, Cents, CollectionKey, Collections, Frequency, GoldEntry,
  GoldHolding, GoldPrice, GoldSummary, Id, IncomeEntry, IncomeTemplate, IsoDate,
  MonthSummary, Period, PersistenceAdapter, Purchase, RecordOf, SavingsMovement,
  SavingsTx, Settings, UpcomingBill
} from './types.ts';

export const STORAGE_KEY = 'income-tracker-v1';
const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------- categories */

export const INCOME_CATEGORIES: readonly Category[] = [
  'Salary', 'Freelance', 'Business', 'Rental', 'Investment', 'Interest',
  'Bonus', 'Commission', 'Pension', 'Refund', 'Gift', 'Other'
];

export const BILL_CATEGORIES: readonly Category[] = [
  'Electricity', 'Water', 'Gas', 'Internet', 'Mobile', 'Landline',
  'Rent', 'Mortgage', 'Council Tax', 'Refuse', 'TV / Streaming',
  'Insurance', 'Loan Repayment', 'Credit Card', 'Childcare', 'Education',
  'Health', 'Subscriptions', 'Maintenance', 'Other'
];

export const PURCHASE_CATEGORIES: readonly Category[] = [
  'Groceries', 'Dining Out', 'Household', 'Clothing', 'Electronics',
  'Pharmacy', 'Fuel', 'Transport', 'Entertainment', 'Gifts',
  'Home Improvement', 'Kids', 'Pets', 'Travel', 'Personal Care', 'Other'
];

export const PAYMENT_METHODS: readonly string[] = [
  'Bank Transfer', 'Direct Debit', 'Card', 'Cash', 'Standing Order',
  'Mobile Money', 'Cheque', 'Other'
];

/* Accounts are every place money sits, not only the pots you save into: the
   card the salary lands on is an account too, and every income, purchase and
   paid bill moves a balance somewhere. */
export const ACCOUNT_TYPES = [
  'Current Account', 'Card / Wallet', 'Savings', 'Emergency Fund',
  'Fixed Deposit', 'Investment', 'Pension', 'Cash', 'Goal Pot', 'Other'
] as const;

/* Which of those count as money put aside. Moving pay from a card into one of
   these is saving; moving it back out is not. */
export const SAVINGS_TYPES: readonly string[] = [
  'Savings', 'Emergency Fund', 'Fixed Deposit', 'Investment', 'Pension', 'Goal Pot'
];

export const FREQUENCIES = [
  'Monthly', 'Bi-monthly', 'Quarterly', 'Half-yearly', 'Yearly', 'One-off'
] as const;

/* Karats sold by weight in Egypt. 24 is pure; the rest are that fraction of
   pure gold, which is exactly how a jeweller prices them. */
export const GOLD_KARATS: readonly number[] = [24, 22, 21, 18, 14];
export const GRAMS_PER_OZ = 31.1034768;   // troy ounce, the unit gold is quoted in

/* How many times a year each frequency bills — used to put bills of different
   cadences on a comparable monthly footing. */
const PER_YEAR: Readonly<Record<Frequency, number>> = {
  'Monthly': 12, 'Bi-monthly': 6, 'Quarterly': 4,
  'Half-yearly': 2, 'Yearly': 1, 'One-off': 0
};

/** The minimum shape needed to price a recurring definition per month. */
export interface MonthlyEquivalentInput {
  frequency?: Frequency;
  expected?: Cents;
}

export function monthlyEquivalent(template: MonthlyEquivalentInput): Cents {
  const perYear = template.frequency === undefined ? 12 : PER_YEAR[template.frequency] ?? 12;
  return Math.round(((template.expected ?? 0) * perYear) / 12);
}

/* Utility categories carry a meter reading, so cost can be read against
   consumption rather than on its own. */
export const METERED: Readonly<Record<string, string>> = {
  'Electricity': 'kWh',
  'Water': 'm³',
  'Gas': 'm³'
};

/* ------------------------------------------------------------ money utils */

/** Parses user input into integer minor units. Handles "1,234.56", "1.234,56",
    "$1 234.56" and "(50)" for negatives. */
export function parseMoney(input: string | number | null | undefined): Cents {
  if (typeof input === 'number') return Math.round(input * 100);
  const raw = String(input ?? '').trim();
  if (!raw) return 0;

  /* A minus only negates when it comes before the digits. Treating one
     anywhere as a sign turned pasted text like "1,200 - rent" into -1200. */
  const negative = /^\(.*\)$/.test(raw) || /^[^0-9]*-/.test(raw);
  const digits = raw.replace(/[^0-9.,]/g, '');
  if (!digits) return 0;

  const decimalAt = Math.max(digits.lastIndexOf('.'), digits.lastIndexOf(','));
  const fractionLength = digits.length - decimalAt - 1;
  let whole: string;
  let frac = '';

  // A separator is decimal only if 1-2 digits follow it; otherwise grouping.
  if (decimalAt !== -1 && fractionLength > 0 && fractionLength <= 2) {
    whole = digits.slice(0, decimalAt).replace(/[.,]/g, '');
    frac = digits.slice(decimalAt + 1);
  } else {
    whole = digits.replace(/[.,]/g, '');
  }

  const cents = (parseInt(whole || '0', 10) * 100) + parseInt(`${frac}00`.slice(0, 2), 10);
  if (!Number.isFinite(cents)) return 0;
  return negative ? -cents : cents;
}

export function toMajor(cents: Cents | null | undefined): number { return (cents ?? 0) / 100; }

export function plural(count: number, one: string, many?: string): string {
  return `${count} ${count === 1 ? one : (many ?? `${one}s`)}`;
}

export interface FormatMoneyOptions {
  /** Drop the minor units — used where the decimals are noise, e.g. chart axes. */
  round?: boolean;
}

export function formatMoney(cents: Cents, settings?: Settings, opts: FormatMoneyOptions = {}): string {
  const s = settings ?? state.settings;
  const value = toMajor(cents);
  const digits = opts.round ? 0 : 2;
  const body = Math.abs(value).toLocaleString(s.locale || 'en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
  return `${value < 0 ? '-' : ''}${s.currencySymbol || ''}${body}`;
}

/* -------------------------------------------------------------- date utils */

const pad2 = (n: number): string => String(n).padStart(2, '0');

const isoOf = (d: Date): IsoDate =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function todayISO(): IsoDate { return isoOf(new Date()); }

export function periodOf(isoDate: IsoDate | null | undefined): Period {
  return String(isoDate ?? '').slice(0, 7);
}

export function currentPeriod(): Period { return todayISO().slice(0, 7); }

export function shiftPeriod(period: Period, months: number): Period {
  const [year = '0', month = '1'] = String(period).split('-');
  const d = new Date(Number(year), Number(month) - 1 + months, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function daysInPeriod(period: Period): number {
  const [year = '0', month = '1'] = String(period).split('-');
  return new Date(Number(year), Number(month), 0).getDate();
}

export function periodLabel(period: Period): string {
  const [year = '0', month = '1'] = String(period).split('-');
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString(state.settings.locale || 'en-US', { month: 'long', year: 'numeric' });
}

/** Due date for a template within a period, clamped to the month's length. */
export function dueDateFor(period: Period, dueDay: number | string | null | undefined): IsoDate {
  const requested = parseInt(String(dueDay ?? ''), 10) || 1;
  const day = Math.min(Math.max(requested, 1), daysInPeriod(period));
  return `${period}-${pad2(day)}`;
}

/** The minimum shape needed to decide whether a definition is due in a period. */
export interface OccurrenceRule {
  active?: boolean;
  frequency?: Frequency;
  /** The template's start period, used to phase quarterly/yearly schedules. */
  anchor?: Period | '' | null;
}

export function occursIn(template: OccurrenceRule, period: Period): boolean {
  if (!template.active) return false;
  const freq = template.frequency ?? 'Monthly';
  if (freq === 'Monthly') return true;
  if (freq === 'One-off') return (template.anchor ?? '') === period;

  const anchor = template.anchor || period;
  const [aYear = '0', aMonth = '1'] = anchor.split('-');
  const [pYear = '0', pMonth = '1'] = period.split('-');
  const delta = (Number(pYear) - Number(aYear)) * 12 + (Number(pMonth) - Number(aMonth));
  if (delta < 0) return false;

  switch (freq) {
    case 'Bi-monthly': return delta % 2 === 0;
    case 'Quarterly': return delta % 3 === 0;
    case 'Half-yearly': return delta % 6 === 0;
    case 'Yearly': return delta % 12 === 0;
    default: return true;
  }
}

/* ------------------------------------------------------------------ state */

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
      goldManualPrice: 0
    },
    income: [],
    incomeTemplates: [],
    billTemplates: [],
    bills: [],
    purchases: [],
    accounts: [],
    savingsTx: [],
    gold: [],
    goldPrices: []
  };
}

/* Exported as a live binding: importers see reassignments made by hydrate(),
   importJSON() and clearAll() without going through a getter. */
export let state: AppState = blankState();
export let storageAvailable = true;

type StateListener = (state: AppState) => void;
const listeners: StateListener[] = [];

let persistence: PersistenceAdapter = { save: () => false };

export function attachPersistence(adapter: PersistenceAdapter): void { persistence = adapter; }

export function uid(prefix = 'id'): Id {
  const rnd = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  return `${prefix}_${rnd}`;
}

export const COLLECTION_KEYS: readonly CollectionKey[] = [
  'income', 'incomeTemplates', 'billTemplates', 'bills', 'purchases',
  'accounts', 'savingsTx', 'gold', 'goldPrices'
];

/** Id prefixes, so a record's origin is readable in the database. */
const ID_PREFIX: Readonly<Record<CollectionKey, string>> = {
  income: 'inc', incomeTemplates: 'itp', billTemplates: 'tpl', bills: 'bil',
  purchases: 'pur', accounts: 'acc', savingsTx: 'sav', gold: 'gld', goldPrices: 'gpr'
};

/** Deliberately forgiving, so a save written by any earlier build still loads. */
function migrate(loaded: unknown): AppState {
  const base = blankState();
  if (!loaded || typeof loaded !== 'object') return base;
  const source = loaded as Partial<AppState>;
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

/* migrate() happily turns an unrelated file into an empty state. Restore must
   not do that, so it checks the shape first. */
export function looksLikeBackup(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const source = parsed as Record<string, unknown>;
  return COLLECTION_KEYS.some((key) => Array.isArray(source[key]));
}

/** Adopt a state object read out of the database at boot. */
export function hydrate(loaded: unknown, available?: boolean): AppState {
  state = migrate(loaded);
  storageAvailable = available !== false;
  return state;
}

export function save(): void {
  try {
    const result = persistence.save(state);
    if (typeof result === 'object' && typeof result.then === 'function') {
      result.then((ok) => { storageAvailable = ok !== false; })
        .catch(() => { storageAvailable = false; });
    } else {
      storageAvailable = result !== false;
    }
  } catch {
    storageAvailable = false;
  }
  for (const fn of listeners) fn(state);
}

export function subscribe(fn: StateListener): void { listeners.push(fn); }

/* --------------------------------------------------------------- records */

export function sortByDateDesc<T extends { id: Id }>(list: readonly T[], key: keyof T): T[] {
  return list.slice().sort((a, b) => {
    const byDate = String(b[key] ?? '').localeCompare(String(a[key] ?? ''));
    return byDate !== 0 ? byDate : String(b.id).localeCompare(String(a.id));
  });
}

/** A record on its way in: an id means update, no id means insert. Callers
    routinely send only the fields they are changing. */
export type Draft<K extends CollectionKey> = Partial<RecordOf<K>> & { id?: Id };

export function upsert<K extends CollectionKey>(collection: K, record: Draft<K>): RecordOf<K> {
  const list = state[collection] as RecordOf<K>[] | undefined;
  if (!list) throw new Error(`unknown collection: ${collection}`);

  if (record.id) {
    const idx = list.findIndex((r) => r.id === record.id);
    if (idx !== -1) {
      const merged = { ...list[idx], ...record } as RecordOf<K>;
      list[idx] = merged;
      save();
      return merged;
    }
  }
  const created = { ...record, id: record.id ?? uid(ID_PREFIX[collection]) } as RecordOf<K>;
  list.push(created);
  save();
  return created;
}

export function remove(collection: CollectionKey, id: Id): void {
  const list = state[collection] as ReadonlyArray<{ id: Id }>;
  (state as Record<CollectionKey, unknown>)[collection] = list.filter((r) => r.id !== id);

  // Removing an account takes its movements with it, including transfers it
  // was the source of — those are its movements too.
  if (collection === 'accounts') {
    state.savingsTx = state.savingsTx.filter((t) => t.accountId !== id && t.fromAccountId !== id);
  }
  // Deleting a recurring definition keeps the entries it already produced,
  // orphaned rather than removed — that money really did move.
  if (collection === 'billTemplates') {
    for (const b of state.bills) if (b.templateId === id) b.templateId = null;
  }
  if (collection === 'incomeTemplates') {
    for (const r of state.income) if (r.templateId === id) r.templateId = null;
  }
  save();
}

export function byId<K extends CollectionKey>(collection: K, id: Id | null | undefined): RecordOf<K> | null {
  const list = state[collection] as RecordOf<K>[];
  return list.find((r) => r.id === id) ?? null;
}

/* ------------------------------------------------------------ generation */

/** One bill for one template in one period, or nothing if it is not due then or
    already exists. Returns how many rows it added, so callers can total. */
export function generateBillFor(tpl: BillTemplate, period: Period): number {
  if (!occursIn(tpl, period)) return 0;
  if (state.bills.some((b) => b.templateId === tpl.id && b.period === period)) return 0;
  state.bills.push({
    id: uid('bil'),
    templateId: tpl.id,
    name: tpl.name,
    category: tpl.category,
    provider: tpl.provider || '',
    period,
    dueDate: dueDateFor(period, tpl.dueDay),
    amount: tpl.expected || 0,
    accountId: tpl.accountId || '',
    units: null,
    unitRate: null,
    status: 'unpaid',
    paidDate: '',
    method: tpl.method || '',
    notes: ''
  });
  return 1;
}

export function generateIncomeFor(tpl: IncomeTemplate, period: Period): number {
  if (!occursIn(tpl, period)) return 0;
  if (state.income.some((r) => r.templateId === tpl.id && periodOf(r.date) === period)) return 0;
  state.income.push({
    id: uid('inc'),
    templateId: tpl.id,
    date: dueDateFor(period, tpl.payDay),
    source: tpl.source,
    category: tpl.category,
    amount: tpl.expected || 0,
    accountId: tpl.accountId || '',
    method: tpl.method || '',
    notes: tpl.notes || ''
  });
  return 1;
}

/* Pointing a recurring definition at an account takes the entries it has
   already produced with it. Without this, setting your salary to land on a card
   leaves every past salary counting towards no balance at all — which reads as
   a broken figure rather than as missing data. Entries already linked somewhere
   else are left exactly as they are. */
export function linkGeneratedTo(
  collection: 'incomeTemplates' | 'billTemplates',
  template: { id?: Id; accountId?: Id | '' } | null | undefined
): number {
  if (!template?.id || !template.accountId) return 0;
  const records: Array<IncomeEntry | Bill> =
    collection === 'incomeTemplates' ? state.income : state.bills;

  let linked = 0;
  for (const r of records) {
    if (r.templateId === template.id && !r.accountId) {
      r.accountId = template.accountId;
      linked++;
    }
  }
  if (linked) save();
  return linked;
}

/* Fills `period` from every active template. Used by the manual buttons, so it
   deliberately ignores generatedThrough — asking for a month means that month,
   whether or not the automatic sweep has already been past it. */
export function generateBills(period: Period): number {
  let created = 0;
  for (const tpl of state.billTemplates) created += generateBillFor(tpl, period);
  if (created) save();
  return created;
}

export function generateIncome(period: Period): number {
  let created = 0;
  for (const tpl of state.incomeTemplates) created += generateIncomeFor(tpl, period);
  if (created) save();
  return created;
}

/* -------------------------------------------------------- automatic sweep */

/* A template remembers the last month it was swept through, so a row you
   deliberately deleted is not recreated on the next visit — the sweep only ever
   looks at months it has not seen before. */
const CATCHUP_MONTHS = 24;

function sweep<T extends { anchor?: Period | ''; generatedThrough?: Period | '' }>(
  templates: T[],
  generate: (template: T, period: Period) => number
): { created: number; swept: boolean } {
  const current = currentPeriod();
  const earliest = shiftPeriod(current, -(CATCHUP_MONTHS - 1));
  let created = 0;
  let swept = false;

  for (const tpl of templates) {
    if (tpl.generatedThrough === current) continue;
    let from = tpl.generatedThrough ? shiftPeriod(tpl.generatedThrough, 1) : (tpl.anchor || current);
    if (from < earliest) from = earliest; // guard against a stale anchor
    // Periods are YYYY-MM, so string order is chronological order.
    for (let period = from; period <= current; period = shiftPeriod(period, 1)) {
      created += generate(tpl, period);
    }
    // Bumped even for paused templates: resuming one should not backfill the
    // months it was switched off for.
    tpl.generatedThrough = current;
    swept = true;
  }

  return { created, swept };
}

/* Brings every recurring definition up to the current month. Called once at
   start-up: set your salary and your bills up once, and each new month fills
   itself in. Months are never generated ahead of today, nor before the template
   existed. */
export function catchUp(): CatchUpResult {
  if (state.settings.autoGenerate === false) return { income: 0, bills: 0, total: 0 };

  const income = sweep(state.incomeTemplates, generateIncomeFor);
  const bills = sweep(state.billTemplates, generateBillFor);

  // The generatedThrough marks move even in a month where nothing was due, so a
  // sweep that added no rows can still need persisting.
  if (income.swept || bills.swept) save();
  return {
    income: income.created,
    bills: bills.created,
    total: income.created + bills.created
  };
}

export function billIsOverdue(
  bill: { status?: BillStatus | string; dueDate?: IsoDate | '' },
  referenceISO?: IsoDate
): boolean {
  return bill.status !== 'paid' && String(bill.dueDate ?? '') < (referenceISO ?? todayISO());
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

/* ------------------------------------------------------------- selectors */

export function sum<T>(list: readonly T[], pick: (item: T) => number): Cents;
export function sum(list: readonly number[]): Cents;
export function sum<T>(list: readonly T[], pick?: (item: T) => number): Cents {
  return list.reduce<number>((acc, item) => acc + (pick ? pick(item) : Number(item)), 0);
}

export const incomeIn = (period: Period): IncomeEntry[] =>
  state.income.filter((r) => periodOf(r.date) === period);

export const purchasesIn = (period: Period): Purchase[] =>
  state.purchases.filter((r) => periodOf(r.date) === period);

export const billsIn = (period: Period): Bill[] =>
  state.bills.filter((r) => r.period === period);

export const savingsTxIn = (period: Period): SavingsTx[] =>
  state.savingsTx.filter((r) => periodOf(r.date) === period);

export function isSavingsAccount(account: Account | null | undefined): boolean {
  return !!account && SAVINGS_TYPES.includes(account.type);
}

/* Every flow that touches an account, in the order money actually moves. A bill
   only leaves the account when it is paid — an unpaid bill is a commitment, not
   a withdrawal, and deducting it would make the balance disagree with the bank. */
export function accountFlows(accountId: Id): AccountFlows {
  const flows: AccountFlows = {
    opening: 0, income: 0, purchases: 0, bills: 0, savedIn: 0, savedOut: 0, gold: 0
  };
  const account = byId('accounts', accountId);
  if (!account) return flows;
  flows.opening = account.opening || 0;

  for (const r of state.income) {
    if (r.accountId === accountId) flows.income += r.amount || 0;
  }
  for (const r of state.purchases) {
    if (r.accountId === accountId) flows.purchases += r.amount || 0;
  }
  for (const b of state.bills) {
    if (b.accountId === accountId && b.status === 'paid') flows.bills += b.amount || 0;
  }
  // Buying gold takes money out of an account and turns it into metal; selling
  // puts it back. Net, so a positive figure means gold has cost this account.
  for (const r of state.gold) {
    if (r.accountId !== accountId) continue;
    flows.gold += r.direction === 'sell' ? -(r.amount || 0) : (r.amount || 0);
  }
  for (const tx of state.savingsTx) {
    const amount = tx.amount || 0;
    if (tx.direction === 'transfer') {
      if (tx.accountId === accountId) flows.savedIn += amount;
      if (tx.fromAccountId === accountId) flows.savedOut += amount;
      continue;
    }
    if (tx.accountId !== accountId) continue;
    if (tx.direction === 'out') flows.savedOut += amount;
    else flows.savedIn += amount;
  }
  return flows;
}

export function accountBalance(accountId: Id): Cents {
  const f = accountFlows(accountId);
  return f.opening + f.income + f.savedIn - f.purchases - f.bills - f.savedOut - f.gold;
}

export function totalSavings(): Cents {
  return sum(state.accounts, (a) => accountBalance(a.id));
}

/* Only the pots. The current account holding this month's salary is a balance,
   not savings, and mixing the two flatters the figure. */
export function savingsBalance(): Cents {
  return sum(state.accounts.filter(isSavingsAccount), (a) => accountBalance(a.id));
}

/* Which way a movement pushes money relative to your savings. A transfer
   between two pots, or between two spending accounts, is neither. */
export function savingsMovement(tx: SavingsTx): SavingsMovement {
  const amount = tx.amount || 0;
  const to = byId('accounts', tx.accountId);
  if (tx.direction === 'transfer') {
    const from = byId('accounts', tx.fromAccountId);
    const into = isSavingsAccount(to);
    const outOf = isSavingsAccount(from);
    if (into && !outOf) return { in: amount, out: 0 };
    if (outOf && !into) return { in: 0, out: amount };
    return { in: 0, out: 0 };
  }
  if (!isSavingsAccount(to)) return { in: 0, out: 0 };
  return tx.direction === 'out' ? { in: 0, out: amount } : { in: amount, out: 0 };
}

/* ------------------------------------------------------------------ gold */

export const goldIn = (period: Period): GoldEntry[] =>
  state.gold.filter((r) => periodOf(r.date) === period);

/** What fraction of a gram is actually gold. 21k is 21 parts in 24. */
export function goldPurity(karat: number | string): number {
  const k = Number(karat);
  return (Number.isFinite(k) && k > 0 ? k : 24) / 24;
}

/** The most recent daily snapshot, or null if the price has never synced. */
export function latestGoldPrice(): GoldPrice | null {
  let latest: GoldPrice | null = null;
  for (const p of state.goldPrices) {
    if (!latest || String(p.date) > String(latest.date)) latest = p;
  }
  return latest;
}

/* Price of one gram, in minor units.
   A price you typed in yourself is taken exactly as given — you read it off a
   shop's board, so it already includes their margin. A synced price is the
   world spot rate, which is the bourse figure rather than the counter figure,
   so the premium setting is added to it. */
export function goldPricePerGram(karat: number | string): Cents {
  const manual = Number(state.settings.goldManualPrice) || 0;
  let base: number;
  let premium: number;
  if (manual > 0) {
    base = manual;
    premium = 1;
  } else {
    const snapshot = latestGoldPrice();
    if (!snapshot) return 0;
    base = snapshot.egpPerGram24 || 0;
    premium = 1 + ((Number(state.settings.goldPremium) || 0) / 100);
  }
  return Math.round(base * premium * goldPurity(karat));
}

/* Spot price per gram of pure gold, in minor units, from usd/oz and the pound
   rate. Kept here so the fetcher and the tests agree on the sum. */
export function goldGramFromSpot(usdPerOz: number, egpPerUsd: number): Cents {
  const perGram = (Number(usdPerOz) / GRAMS_PER_OZ) * Number(egpPerUsd);
  return Number.isFinite(perGram) ? Math.round(perGram * 100) : 0;
}

export interface GoldPriceReading {
  date?: IsoDate;
  usdPerOz: number;
  egpPerUsd: number;
  source?: string;
}

/** Two years of daily readings is plenty to chart against; older ones only grow
    the database. */
const MAX_GOLD_PRICES = 800;

/* One snapshot a day: same-day refreshes replace, so the history is a clean
   daily series rather than one row per app launch. */
export function recordGoldPrice(reading: GoldPriceReading): GoldPrice {
  const date = reading.date || todayISO();
  const record: GoldPrice = {
    id: `gpr_${date}`,
    date,
    usdPerOz: Number(reading.usdPerOz) || 0,
    egpPerUsd: Number(reading.egpPerUsd) || 0,
    egpPerGram24: goldGramFromSpot(reading.usdPerOz, reading.egpPerUsd),
    source: reading.source || '',
    fetchedAt: new Date().toISOString()
  };
  const idx = state.goldPrices.findIndex((p) => p.id === record.id);
  if (idx === -1) state.goldPrices.push(record);
  else state.goldPrices[idx] = record;

  if (state.goldPrices.length > MAX_GOLD_PRICES) {
    state.goldPrices = state.goldPrices
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .slice(-MAX_GOLD_PRICES);
  }
  save();
  return record;
}

/** Grams held per karat, with what each pile is worth today. */
export function goldHoldings(): GoldHolding[] {
  const byKarat = new Map<number, number>();
  for (const r of state.gold) {
    const karat = Number(r.karat) || 24;
    const grams = Number(r.grams) || 0;
    byKarat.set(karat, (byKarat.get(karat) ?? 0) + (r.direction === 'sell' ? -grams : grams));
  }
  return [...byKarat.entries()]
    .sort(([a], [b]) => b - a)
    .map(([karat, grams]) => ({
      karat,
      grams,
      value: Math.round(grams * goldPricePerGram(karat))
    }))
    // Floating-point grams never land exactly on zero once you have sold some.
    .filter((h) => Math.abs(h.grams) > 1e-9);
}

export function goldValue(): Cents { return sum(goldHoldings(), (h) => h.value); }

/** Money actually put into gold: what you paid, less what selling gave back.
    Against goldValue() this is the gain or loss. */
export function goldInvested(): Cents {
  return state.gold.reduce((total, r) => {
    const amount = r.amount || 0;
    return total + (r.direction === 'sell' ? -amount : amount);
  }, 0);
}

export function goldSummary(): GoldSummary {
  const holdings = goldHoldings();
  const value = sum(holdings, (h) => h.value);
  const invested = goldInvested();
  return {
    value,
    invested,
    gain: value - invested,
    gainRate: invested > 0 ? (value - invested) / invested : 0,
    grams: sum(holdings, (h) => h.grams),
    pure: sum(holdings, (h) => h.grams * goldPurity(h.karat)),
    price: latestGoldPrice(),
    manual: (Number(state.settings.goldManualPrice) || 0) > 0
  };
}

export function summary(period: Period): MonthSummary {
  const income = sum(incomeIn(period), (r) => r.amount);
  const bills = billsIn(period);
  const billsTotal = sum(bills, (r) => r.amount);
  const billsPaid = sum(bills.filter((b) => b.status === 'paid'), (r) => r.amount);
  const purchases = sum(purchasesIn(period), (r) => r.amount);
  const tx = savingsTxIn(period);
  const savedIn = sum(tx, (t) => savingsMovement(t).in);
  const savedOut = sum(tx, (t) => savingsMovement(t).out);
  const spent = billsTotal + purchases;

  return {
    period,
    income,
    bills: billsTotal,
    billsPaid,
    billsOutstanding: billsTotal - billsPaid,
    billCount: bills.length,
    overdueCount: bills.filter((b) => billIsOverdue(b)).length,
    purchases,
    spent,
    net: income - spent,
    savedIn,
    savedOut,
    savedNet: savedIn - savedOut,
    savingsRate: income > 0 ? (savedIn - savedOut) / income : 0
  };
}

export function groupByCategory(records: ReadonlyArray<{ category?: Category; amount?: Cents }>): CategoryTotal[] {
  const totals = new Map<Category, Cents>();
  for (const r of records) {
    const key = r.category || 'Uncategorised';
    totals.set(key, (totals.get(key) ?? 0) + (r.amount ?? 0));
  }
  return [...totals.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

/** Periods that hold any record at all, newest first. */
export function activePeriods(): Period[] {
  const periods = new Set<Period>();
  for (const r of state.income) if (r.date) periods.add(periodOf(r.date));
  for (const r of state.purchases) if (r.date) periods.add(periodOf(r.date));
  for (const r of state.savingsTx) if (r.date) periods.add(periodOf(r.date));
  for (const r of state.gold) if (r.date) periods.add(periodOf(r.date));
  for (const r of state.bills) if (r.period) periods.add(r.period);
  periods.add(currentPeriod());
  return [...periods].sort().reverse();
}

export function trend(endPeriod: Period, months: number): MonthSummary[] {
  const out: MonthSummary[] = [];
  for (let i = months - 1; i >= 0; i--) out.push(summary(shiftPeriod(endPeriod, -i)));
  return out;
}

export function upcomingBills(withinDays = 30): UpcomingBill[] {
  const today = todayISO();
  const limit = new Date();
  limit.setDate(limit.getDate() + withinDays);
  const limitISO = isoOf(limit);
  return state.bills
    .filter((b) => b.status !== 'paid' && b.dueDate && b.dueDate <= limitISO)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .map((b) => ({ ...b, overdue: b.dueDate < today }));
}

/* ------------------------------------------------------- backup / restore */

export function exportJSON(): string { return JSON.stringify(state, null, 2); }

export function importJSON(text: string): Record<CollectionKey, number> {
  const parsed: unknown = JSON.parse(text);
  if (!looksLikeBackup(parsed)) {
    throw new Error('This file is not an Income Tracker backup, so nothing was changed. ' +
      'Pick the .json file produced by "Download backup".');
  }
  const next = migrate(parsed);
  const counts = {} as Record<CollectionKey, number>;
  for (const key of COLLECTION_KEYS) counts[key] = next[key].length;
  state = next;
  save();
  return counts;
}

export function replaceState(next: unknown): void { state = migrate(next); save(); }

export function clearAll(): void { state = blankState(); save(); }

/** Collections keyed by name, for the generic table code in the exporter. */
export type { Collections };
