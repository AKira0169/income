/* domain/period.ts — months, due dates and how often a thing recurs.

   A Period is `YYYY-MM` and an IsoDate is `YYYY-MM-DD`, both of which sort
   chronologically as plain strings. A great deal of the code below relies on
   that, so neither format is ever localised in storage — only on the way out,
   through periodLabel, which is handed the locale rather than reading one. */

import { PER_YEAR } from './catalog.ts';
import type { Cents, Frequency, IsoDate, Period } from './types.ts';

export const pad2 = (n: number): string => String(n).padStart(2, '0');

export const isoOf = (d: Date): IsoDate =>
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

export function periodLabel(period: Period, locale?: string): string {
  const [year = '0', month = '1'] = String(period).split('-');
  const d = new Date(Number(year), Number(month) - 1, 1);
  return d.toLocaleDateString(locale || 'en-US', { month: 'long', year: 'numeric' });
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

/** The minimum shape needed to price a recurring definition per month. */
export interface MonthlyEquivalentInput {
  frequency?: Frequency;
  expected?: Cents;
}

export function monthlyEquivalent(template: MonthlyEquivalentInput): Cents {
  const perYear = template.frequency === undefined ? 12 : PER_YEAR[template.frequency] ?? 12;
  return Math.round(((template.expected ?? 0) * perYear) / 12);
}
