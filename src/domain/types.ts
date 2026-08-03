/* types.ts — the domain model.

   Money is an integer number of minor units (cents) everywhere it appears, so
   totals never drift by a penny. The `Cents` alias marks every field that
   follows that rule; a plain `number` in this file is a real quantity (grams,
   a day of the month, a rate) and is not scaled. */

/** Opaque-ish aliases. They document intent at every call site. */
export type Id = string;
/** `YYYY-MM-DD`. String order is chronological order, which the code relies on. */
export type IsoDate = string;
/** `YYYY-MM`. Also chronologically ordered as a string. */
export type Period = string;
/** An integer number of minor units. Never a fractional currency value. */
export type Cents = number;

export type Frequency = 'Monthly' | 'Bi-monthly' | 'Quarterly' | 'Half-yearly' | 'Yearly' | 'One-off';
export type BillStatus = 'paid' | 'unpaid';
export type GoldDirection = 'buy' | 'sell';
/** `transfer` moves between two accounts; `in`/`out` reach outside them. */
export type SavingsDirection = 'in' | 'out' | 'transfer';

/** `Loan / Debt` is money you owe: an account whose balance is negative until
    it is paid off. See DEBT_TYPE in catalog.ts. */
export type AccountType =
  | 'Current Account' | 'Card / Wallet' | 'Savings' | 'Emergency Fund'
  | 'Fixed Deposit' | 'Investment' | 'Pension' | 'Cash' | 'Goal Pot'
  | 'Loan / Debt' | 'Other';

/* Categories stay `string`: they are offered as a list but a database written
   by an older build may hold anything, and a union would reject it on load. */
export type Category = string;

export interface Settings {
  currencySymbol: string;
  currencyCode: string;
  locale: string;
  savingsGoalRate: number;
  autoGenerate: boolean;
  /** When false the app never touches the network. */
  goldSync: boolean;
  /** Percent a local shop adds over the bourse price. */
  goldPremium: number;
  /** A price read off a shop board; overrides syncing entirely when > 0. */
  goldManualPrice: Cents;
  /** Average the last few months' purchases rather than using a typed figure. */
  forecastSpendingAuto: boolean;
  /** The monthly purchases figure the forecast uses when auto is off. */
  forecastSpending: Cents;
}

/** Fields shared by the two recurring definitions. */
export interface RecurringBase {
  id: Id;
  category: Category;
  frequency: Frequency;
  expected: Cents;
  accountId: Id | '';
  method: string;
  active: boolean;
  /** Period the schedule is phased from, so quarterly/yearly land correctly. */
  anchor: Period | '';
  /** Last period the automatic sweep has taken this definition through. */
  generatedThrough: Period | '';
  notes: string;
}

export interface IncomeTemplate extends RecurringBase {
  source: string;
  payDay: number;
}

export interface BillTemplate extends RecurringBase {
  name: string;
  provider: string;
  dueDay: number;
}

export interface IncomeEntry {
  id: Id;
  /** Set when generated from a recurring definition; nulled if that is deleted. */
  templateId: Id | null;
  date: IsoDate;
  source: string;
  category: Category;
  amount: Cents;
  accountId: Id | '';
  method: string;
  notes: string;
}

export interface Bill {
  id: Id;
  templateId: Id | null;
  name: string;
  category: Category;
  provider: string;
  /** Derived from `dueDate`; recomputed on every write. */
  period: Period;
  dueDate: IsoDate;
  amount: Cents;
  accountId: Id | '';
  /** Meter reading for the utility categories, in kWh or m³. Not money. */
  units: number | null;
  unitRate: number | null;
  /** Derived from `paidDate`; recomputed on every write. */
  status: BillStatus;
  paidDate: IsoDate | '';
  method: string;
  notes: string;
}

export interface Purchase {
  id: Id;
  /* Set when this row is a goal being bought; nulled if that goal is deleted,
     the same way a generated bill outlives its template — the money really did
     move. It is also what keeps a goal out of the forecast's assumed spending:
     buying an RTX 5080 is not a habit, and averaging it forward would push
     every goal behind it months out for no reason. */
  goalId: Id | null;
  date: IsoDate;
  item: string;
  category: Category;
  amount: Cents;
  accountId: Id | '';
  method: string;
  notes: string;
}

/** Anywhere money sits — not only the pots you save into. */
export interface Account {
  id: Id;
  name: string;
  type: AccountType;
  target: Cents;
  opening: Cents;
  notes: string;
}

/** Something you are saving up for. */
export interface Goal {
  id: Id;
  name: string;
  /** 0 when you do not know the price yet. */
  price: Cents;
  /* `priority`, not `order`: the schema quotes every identifier so `order`
     would in fact work, but the SQL-keyword trap is not worth leaving. */
  /** Funding order, ascending. */
  priority: number;
  /* A date rather than a `bought` boolean: readAll() coerces only the literal
     column `active` back into a boolean, so a new boolean field would come back
     as 0/1 and contradict its own type. It also matches how Bill derives
     `status` from `paidDate`, and records *when* you bought it. */
  /** Set when you actually bought it; empty means still saving. */
  boughtDate: IsoDate | '';
  notes: string;
}

export interface SavingsTx {
  id: Id;
  date: IsoDate;
  /** The account money lands in. */
  accountId: Id | '';
  /** Only meaningful when `direction` is `transfer`. */
  fromAccountId: Id | '';
  direction: SavingsDirection;
  amount: Cents;
  notes: string;
}

export interface GoldEntry {
  id: Id;
  date: IsoDate;
  direction: GoldDirection;
  karat: number;
  /** Weight in grams — a real quantity, not scaled. */
  grams: number;
  pricePerGram: Cents;
  amount: Cents;
  accountId: Id | '';
  dealer: string;
  notes: string;
}

/** One daily snapshot of the world spot price and the pound rate. */
export interface GoldPrice {
  id: Id;
  date: IsoDate;
  usdPerOz: number;
  egpPerUsd: number;
  egpPerGram24: Cents;
  source: string;
  fetchedAt: string;
}

/** The collections that are stored as tables, keyed by table name. */
export interface Collections {
  income: IncomeEntry[];
  incomeTemplates: IncomeTemplate[];
  billTemplates: BillTemplate[];
  bills: Bill[];
  purchases: Purchase[];
  accounts: Account[];
  goals: Goal[];
  savingsTx: SavingsTx[];
  gold: GoldEntry[];
  goldPrices: GoldPrice[];
}

export type CollectionKey = keyof Collections;
/** The record type held by a given collection, e.g. `RecordOf<'bills'>` is `Bill`. */
export type RecordOf<K extends CollectionKey> = Collections[K][number];

export interface AppState extends Collections {
  version: number;
  settings: Settings;
}

/* ------------------------------------------------------------- derived data */

/** Every flow that touches an account, in the order money actually moves. */
export interface AccountFlows {
  opening: Cents;
  income: Cents;
  purchases: Cents;
  /** Only bills actually paid; an unpaid bill is a commitment, not a withdrawal. */
  bills: Cents;
  savedIn: Cents;
  savedOut: Cents;
  /** Net cost of gold: bought less sold. */
  gold: Cents;
}

/** One debt, as the screen reads it. Every figure is derived from the account's
    own flows, so it can never disagree with the balance it is made of. */
export interface DebtSummary {
  account: Account;
  /** Everything that put you further in: what you borrowed, and anything paid
      straight out of the lender's money. */
  borrowed: Cents;
  /** Everything that brought you back out again. */
  repaid: Cents;
  /** `borrowed − repaid`, and exactly the negated account balance. */
  owed: Cents;
  /** Nothing left to pay. Also true of a debt overpaid, where `owed` is < 0. */
  settled: boolean;
}

/** What reconciling an account against its real balance would do, before
    anything is written. */
export interface Reconciliation {
  accountId: Id;
  /** What the app's own records add up to. */
  tracked: Cents;
  /** What the bank, or the notes in your pocket, actually say. */
  actual: Cents;
  /** `actual − tracked`. Negative means money left and was never entered. */
  difference: Cents;
}

export interface MonthSummary {
  period: Period;
  income: Cents;
  bills: Cents;
  billsPaid: Cents;
  billsOutstanding: Cents;
  billCount: number;
  overdueCount: number;
  purchases: Cents;
  spent: Cents;
  net: Cents;
  savedIn: Cents;
  savedOut: Cents;
  savedNet: Cents;
  /** A fraction, not a percent: 0.2 is 20%. */
  savingsRate: number;
}

/** One month of the cash projection. */
export interface ForecastMonth {
  period: Period;
  income: Cents;
  bills: Cents;
  spending: Cents;
  /** Gold and outside movements already recorded for this month; signed. */
  other: Cents;
  surplus: Cents;
  /** Money on hand at the end of this month. */
  balance: Cents;
}

export interface ForecastOptions {
  /** Defaults to currentPeriod(). */
  from?: Period;
  /** How many future months. Defaults to HORIZON_MONTHS. */
  months?: number;
  /** Overrides forecastSpending(state). */
  spending?: Cents;
}

export interface Forecast {
  startPeriod: Period;
  /** cashOnHand at startPeriod, less `outstanding`. */
  start: Cents;
  /** Unpaid bills dated in startPeriod or earlier. */
  outstanding: Cents;
  /** The assumed monthly purchases actually used. */
  spending: Cents;
  /** One row per future month, oldest first. Never includes startPeriod. */
  months: ForecastMonth[];
}

export interface GoalForecast {
  goal: Goal;
  /** Total price of the goals ahead of this one. */
  reserved: Cents;
  /** reserved + goal.price — the balance this goal needs. */
  threshold: Cents;
  /** Already yours toward this goal: start − reserved, floored at 0, capped at price. */
  saved: Cents;
  /** 0..1 against this goal's own price. Always 0 when price is 0. */
  progress: number;
  /** First month whose balance reaches `threshold`; '' if never inside the horizon. */
  reachedIn: Period | '';
  /** Months from startPeriod, 0 meaning affordable now; null when reachedIn is ''. */
  monthsAway: number | null;
}

/** Which way a movement pushes money relative to your savings. */
export interface SavingsMovement {
  in: Cents;
  out: Cents;
}

export interface GoldHolding {
  karat: number;
  grams: number;
  value: Cents;
}

export interface GoldSummary {
  value: Cents;
  invested: Cents;
  gain: Cents;
  gainRate: number;
  grams: number;
  /** Grams of pure gold, after applying each karat's purity. */
  pure: number;
  price: GoldPrice | null;
  manual: boolean;
}

export interface CatchUpResult {
  income: number;
  bills: number;
  total: number;
}

export interface CategoryTotal {
  category: Category;
  amount: Cents;
}

export interface UpcomingBill extends Bill {
  overdue: boolean;
}

/* --------------------------------------------------------------- injection */

/** Persistence is injected so the same logic runs against SQLite in the
    browser and against plain memory in the Node tests. */
export interface PersistenceAdapter {
  /** Resolves false when the write did not reach durable storage. */
  save(state: AppState): Promise<boolean> | boolean;
}
