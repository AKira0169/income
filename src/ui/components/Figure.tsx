/* ui/components/Figure.tsx — the small display pieces more than one screen
   needs: a headline number, a line of an account's story, a settings row and a
   target bar. */

import { formatMoney } from '../../domain/money.ts';
import type { Cents, Settings } from '../../domain/types.ts';

/** A headline number with its label and a line of context underneath. */
export function Figure({ label, value, note, negative }: {
  label: string;
  value: string;
  note?: string | null;
  negative?: boolean;
}) {
  return (
    <div class={negative ? 'figure is-negative' : 'figure'}>
      <div class="label">{label}</div>
      <div class="figure-value">{value}</div>
      {note ? <div class="figure-note">{note}</div> : null}
    </div>
  );
}

/** One line of an account's story: where the balance came from. Nothing is
    drawn for a flow that never happened. */
export function FlowLine({ label, amount, settings, negative }: {
  label: string;
  amount: Cents;
  settings: Settings;
  negative?: boolean;
}) {
  if (!amount) return null;
  return (
    <div class={negative ? 'flow is-out' : 'flow'}>
      <span>{label}</span>
      <span class="num">{`${negative ? '−' : '+'}${formatMoney(amount, settings)}`}</span>
    </div>
  );
}

/** A labelled control with an explanatory line under it, for settings panels. */
export function SettingRow({ label, hint, children }: {
  label: string;
  hint?: string;
  children: preact.ComponentChildren;
}) {
  return (
    <div class="field">
      <label>{label}</label>
      {children}
      {hint ? <div class="muted">{hint}</div> : null}
    </div>
  );
}

/** A target bar, plus the line that says what it is a fraction of. */
export function TargetProgress({ balance, target, settings, suffix }: {
  balance: Cents;
  target: Cents;
  settings: Settings;
  suffix?: string;
}) {
  if (!target) return null;
  const pct = (balance / target) * 100;
  return (
    <>
      <div class="progress">
        <div style={`width:${Math.min(100, Math.max(0, pct))}%`} />
      </div>
      <div class="muted">{`${Math.round(pct)}% of ${formatMoney(target, settings)}${suffix ?? ''}`}</div>
    </>
  );
}
