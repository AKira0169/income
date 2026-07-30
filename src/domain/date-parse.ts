/* domain/date-parse.ts — reading and writing the dates people actually type.

   The native <input type="date"> is not used anywhere in this app: its layout,
   its keyboard behaviour and its calendar are the browser's, they differ between
   Chrome and Edge, and the field order it imposes is not the one Egyptian dates
   are written in. So the date field is a plain text input, and this is what sits
   behind it: six accepted shapes in, one ISO string out.

   Pure and DOM-free, so the six formats and the two-digit-year rule can be
   tested in Node rather than only through a browser. */

import { daysInPeriod, pad2, todayISO } from './period.ts';
import type { IsoDate } from './types.ts';

export interface DateParts { y: number; m: number; d: number }

/** Month is 0-based here, matching `Date`. */
export const iso = (y: number, m: number, d: number): IsoDate => `${y}-${pad2(m + 1)}-${pad2(d)}`;

/** Month is 0-based, so this is the calendar-arithmetic twin of daysInPeriod. */
export const daysInMonth = (y: number, m: number): number => daysInPeriod(`${y}-${pad2(m + 1)}`);

/** Splits an ISO date, or null if it is malformed or names a day that does not
    exist — 2026-02-30 is text, not a date. */
export function toParts(value: string | null | undefined): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

const MS_DAY = 86400000;

export function shiftDays(value: IsoDate, delta: number): IsoDate {
  const p = toParts(value);
  if (!p) return value;
  const d = new Date(new Date(p.y, p.m, p.d).getTime() + (delta * MS_DAY));
  return iso(d.getFullYear(), d.getMonth(), d.getDate());
}

/* Month arithmetic clamps rather than rolling over, so 31 January minus a month
   is 28 February and not the 3rd of March. */
export function shiftMonths(value: IsoDate, delta: number): IsoDate {
  const p = toParts(value);
  if (!p) return value;
  let m = p.m + delta;
  const y = p.y + Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return iso(y, m, Math.min(p.d, daysInMonth(y, m)));
}

/** How a stored date is shown in the field. */
export function display(value: string | null | undefined): string {
  const p = toParts(value);
  return p ? `${pad2(p.d)}/${pad2(p.m + 1)}/${p.y}` : '';
}

/** A two-digit year is this century unless that would be far in the future —
    "26" is 2026, but "99" is 1999 rather than 2099. */
export function fourDigit(year: number): number {
  if (year >= 100) return year;
  const century = Math.floor(new Date().getFullYear() / 100) * 100;
  const full = century + year;
  return full - new Date().getFullYear() > 20 ? full - 100 : full;
}

/** Builds an ISO date, or null if that day does not exist. */
function make(y: number, m: number, d: number): IsoDate | null {
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m - 1)) return null;
  return iso(y, m - 1, d);
}

/** Reads whatever was typed. `context` is the month on screen, so a bare day
    number means that month — the common case when correcting one entry.
    Returns '' for empty and null for unreadable, which the caller must tell
    apart: one clears the field, the other must not. */
export function parse(text: string | null | undefined, context?: string): IsoDate | '' | null {
  const raw = String(text ?? '').trim();
  if (!raw) return '';

  const base = toParts(context) ?? toParts(todayISO())!;

  let m = /^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/.exec(raw);
  if (m) return make(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/.exec(raw);
  if (m) return make(fourDigit(Number(m[3])), Number(m[2]), Number(m[1]));

  m = /^(\d{1,2})[-/. ](\d{1,2})$/.exec(raw);
  if (m) return make(base.y, Number(m[2]), Number(m[1]));

  m = /^(\d{2})(\d{2})(\d{4})$/.exec(raw);        // 05082026
  if (m) return make(Number(m[3]), Number(m[2]), Number(m[1]));

  m = /^(\d{2})(\d{2})(\d{2})$/.exec(raw);        // 050826
  if (m) return make(fourDigit(Number(m[3])), Number(m[2]), Number(m[1]));

  m = /^(\d{1,2})$/.exec(raw);                    // just a day
  if (m) return make(base.y, base.m + 1, Number(m[1]));

  return null;                                    // unreadable
}
