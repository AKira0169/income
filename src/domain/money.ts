/* domain/money.ts — money in and money out, as text.

   Every amount in this app is an integer number of minor units, so totals never
   drift by a penny. These are the only two places that boundary is crossed.

   formatMoney takes its settings rather than reaching for a global: that is what
   lets it live here, with no state, no DOM and no imports beyond the types. */

import type { Cents, Settings } from './types.ts';

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

/* A row count that says where its own rows came from. Reconciling writes real
   ledger entries, so a month you were paid three times can honestly list five —
   and a bare "5 entries" against three you remember typing reads as duplicated
   data rather than as the correction it is. Silent when there are none, which
   is nearly always. */
export function countWithCorrections(
  total: number, corrections: number, one: string, many?: string
): string {
  const all = plural(total, one, many);
  if (!corrections) return all;
  return `${all} (${total - corrections} entered, ${plural(corrections, 'correction')})`;
}

export interface FormatMoneyOptions {
  /** Drop the minor units — used where the decimals are noise, e.g. chart axes. */
  round?: boolean;
}

export function formatMoney(cents: Cents, settings: Settings, opts: FormatMoneyOptions = {}): string {
  const value = toMajor(cents);
  const digits = opts.round ? 0 : 2;
  const body = Math.abs(value).toLocaleString(settings.locale || 'en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
  return `${value < 0 ? '-' : ''}${settings.currencySymbol || ''}${body}`;
}
