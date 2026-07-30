/* ui/format.ts — turning stored values into the strings on screen. */

import { byId, formatMoney } from '../store.ts';
import type { Cents, Id } from '../types.ts';

export const money = (cents: Cents): string => formatMoney(cents);

/* Whole percents read better, except near zero where rounding would report a
   real movement as no movement at all. */
export function percent(rate: number): string {
  const value = rate * 100;
  const body = (Math.abs(value) < 9.5 && value !== 0)
    ? value.toFixed(1)
    : String(Math.round(value));
  return `${body}%`;
}

export function accountName(id: Id | '' | null | undefined): string {
  return byId('accounts', id)?.name ?? '';
}
