/* ui/widgets.ts — small display pieces shared by more than one screen. */

import { el } from '../dom.ts';
import type { Cents } from '../types.ts';
import { money } from './format.ts';

/** A headline number with its label and a line of context underneath. */
export function figure(label: string, value: string, note?: string, negative = false): HTMLDivElement {
  return el('div', { class: `figure${negative ? ' is-negative' : ''}` }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: 'figure-value', text: value }),
    note ? el('div', { class: 'figure-note', text: note }) : null
  ]);
}

/** One line of an account's story: where the balance came from. Nothing is
    drawn for a flow that never happened. */
export function flowLine(label: string, amount: Cents, negative = false): HTMLDivElement | null {
  if (!amount) return null;
  return el('div', { class: `flow${negative ? ' is-out' : ''}` }, [
    el('span', { text: label }),
    el('span', { class: 'num', text: `${negative ? '−' : '+'}${money(amount)}` })
  ]);
}

/** A labelled control with an explanatory line under it, for settings panels. */
export function settingRow(label: string, control: HTMLElement, hint?: string): HTMLDivElement {
  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    control,
    hint ? el('div', { class: 'muted', text: hint }) : null
  ]);
}

/** A target bar, plus the line that says what it is a fraction of. */
export function targetProgress(balance: Cents, target: Cents, suffix = ''): HTMLElement[] {
  if (!target) return [];
  const pct = (balance / target) * 100;
  return [
    el('div', { class: 'progress' }, [
      el('div', { style: `width:${Math.min(100, Math.max(0, pct))}%` })
    ]),
    el('div', { class: 'muted', text: `${Math.round(pct)}% of ${money(target)}${suffix}` })
  ];
}
