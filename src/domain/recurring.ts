/* domain/recurring.ts — the two-layer recurring model.

   A template is the standing arrangement ("rent, 12,000, due on the 5th"); the
   bills and income entries it produces are the things that actually happened,
   and stay editable on their own. Generation only ever fills months that have
   already arrived, and never twice.

   Pure, like the rest of domain/: nothing here edits the state it is handed. */

import { uid } from './records.ts';
import { withCollection } from './records.ts';
import { currentPeriod, dueDateFor, occursIn, periodOf, shiftPeriod, todayISO } from './period.ts';
import type {
  AppState, Bill, BillStatus, BillTemplate, CatchUpResult, Id, IncomeEntry,
  IncomeTemplate, IsoDate, Period
} from './types.ts';

/* A template remembers the last month it was swept through, so a row you
   deliberately deleted is not recreated on the next visit — the sweep only ever
   looks at months it has not seen before. */
const CATCHUP_MONTHS = 24;

/* ------------------------------------------------------- one record, once */

const billExists = (bills: readonly Bill[], tpl: BillTemplate, period: Period): boolean =>
  bills.some((b) => b.templateId === tpl.id && b.period === period);

const incomeExists = (income: readonly IncomeEntry[], tpl: IncomeTemplate, period: Period): boolean =>
  income.some((r) => r.templateId === tpl.id && periodOf(r.date) === period);

function makeBill(tpl: BillTemplate, period: Period): Bill {
  return {
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
  };
}

function makeIncome(tpl: IncomeTemplate, period: Period): IncomeEntry {
  return {
    id: uid('inc'),
    templateId: tpl.id,
    date: dueDateFor(period, tpl.payDay),
    source: tpl.source,
    category: tpl.category,
    amount: tpl.expected || 0,
    accountId: tpl.accountId || '',
    method: tpl.method || '',
    notes: tpl.notes || ''
  };
}

/* ---------------------------------------------------------- manual filling */

/* Fills `period` from every active template. Used by the manual buttons, so it
   deliberately ignores generatedThrough — asking for a month means that month,
   whether or not the automatic sweep has already been past it. */
export function generateBills(state: AppState, period: Period): { state: AppState; created: number } {
  const bills = state.bills.slice();
  let created = 0;
  for (const tpl of state.billTemplates) {
    if (!occursIn(tpl, period) || billExists(bills, tpl, period)) continue;
    bills.push(makeBill(tpl, period));
    created++;
  }
  return { state: created ? withCollection(state, 'bills', bills) : state, created };
}

export function generateIncome(state: AppState, period: Period): { state: AppState; created: number } {
  const income = state.income.slice();
  let created = 0;
  for (const tpl of state.incomeTemplates) {
    if (!occursIn(tpl, period) || incomeExists(income, tpl, period)) continue;
    income.push(makeIncome(tpl, period));
    created++;
  }
  return { state: created ? withCollection(state, 'income', income) : state, created };
}

/* -------------------------------------------------------- automatic sweep */

/** The template fields the sweep itself reads; both template kinds satisfy it. */
interface Sweepable {
  anchor: Period | '';
  generatedThrough: Period | '';
}

interface SweepResult<T, R> {
  templates: T[];
  records: R[];
  created: number;
  swept: boolean;
}

function sweep<T extends Sweepable, R>(
  templates: readonly T[],
  existing: readonly R[],
  has: (records: readonly R[], tpl: T, period: Period) => boolean,
  make: (tpl: T, period: Period) => R,
  due: (tpl: T, period: Period) => boolean
): SweepResult<T, R> {
  const current = currentPeriod();
  const earliest = shiftPeriod(current, -(CATCHUP_MONTHS - 1));
  const records = existing.slice();
  let created = 0;
  let swept = false;

  const next = templates.map((tpl) => {
    if (tpl.generatedThrough === current) return tpl;
    let from = tpl.generatedThrough ? shiftPeriod(tpl.generatedThrough, 1) : (tpl.anchor || current);
    if (from < earliest) from = earliest; // guard against a stale anchor
    // Periods are YYYY-MM, so string order is chronological order.
    for (let period = from; period <= current; period = shiftPeriod(period, 1)) {
      if (!due(tpl, period) || has(records, tpl, period)) continue;
      records.push(make(tpl, period));
      created++;
    }
    swept = true;
    // Bumped even for paused templates: resuming one should not backfill the
    // months it was switched off for.
    return { ...tpl, generatedThrough: current };
  });

  return { templates: next, records, created, swept };
}

/* Brings every recurring definition up to the current month. Called once at
   start-up: set your salary and your bills up once, and each new month fills
   itself in. Months are never generated ahead of today, nor before the template
   existed. */
export function catchUp(state: AppState): { state: AppState; result: CatchUpResult } {
  const none: CatchUpResult = { income: 0, bills: 0, total: 0 };
  if (state.settings.autoGenerate === false) return { state, result: none };

  const income = sweep(state.incomeTemplates, state.income, incomeExists, makeIncome, occursIn);
  const bills = sweep(state.billTemplates, state.bills, billExists, makeBill, occursIn);

  // The generatedThrough marks move even in a month where nothing was due, so a
  // sweep that added no rows can still need persisting.
  if (!income.swept && !bills.swept) return { state, result: none };

  return {
    state: {
      ...state,
      incomeTemplates: income.templates,
      income: income.records,
      billTemplates: bills.templates,
      bills: bills.records
    },
    result: {
      income: income.created,
      bills: bills.created,
      total: income.created + bills.created
    }
  };
}

/* ------------------------------------------------------------ back-linking */

/* Pointing a recurring definition at an account takes the entries it has
   already produced with it. Without this, setting your salary to land on a card
   leaves every past salary counting towards no balance at all — which reads as
   a broken figure rather than as missing data. Entries already linked somewhere
   else are left exactly as they are. */
export function linkGeneratedTo(
  state: AppState,
  collection: 'incomeTemplates' | 'billTemplates',
  template: { id?: Id; accountId?: Id | '' } | null | undefined
): { state: AppState; linked: number } {
  if (!template?.id || !template.accountId) return { state, linked: 0 };
  const accountId = template.accountId;
  const key = collection === 'incomeTemplates' ? 'income' : 'bills';
  const records: ReadonlyArray<IncomeEntry | Bill> = state[key];

  let linked = 0;
  const next = records.map((r) => {
    if (r.templateId !== template.id || r.accountId) return r;
    linked++;
    return { ...r, accountId };
  });

  if (!linked) return { state, linked: 0 };
  return { state: { ...state, [key]: next } as AppState, linked };
}

/* ---------------------------------------------------------------- overdue */

export function billIsOverdue(
  bill: { status?: BillStatus | string; dueDate?: IsoDate | '' },
  referenceISO?: IsoDate
): boolean {
  return bill.status !== 'paid' && String(bill.dueDate ?? '') < (referenceISO ?? todayISO());
}
