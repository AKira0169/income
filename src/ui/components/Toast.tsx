/* ui/components/Toast.tsx — the one line that says what just happened.

   The message is a signal so both halves of the app can raise one during the
   port: the legacy screens call toast() from ui/feedback.ts, the ported ones
   call the same function, and only this component knows what a toast looks
   like. */

import { useEffect } from 'preact/hooks';
import { signal } from '@preact/signals';

const TOAST_MS = 3000;

/** The current message and a counter, so raising the same text twice restarts
    the timer rather than looking like nothing happened. */
export const toastMessage = signal<{ text: string; seq: number } | null>(null);

let seq = 0;

export function toast(text: string): void {
  toastMessage.value = { text, seq: ++seq };
}

export function Toast() {
  const current = toastMessage.value;

  useEffect(() => {
    if (!current) return;
    const timer = setTimeout(() => {
      // Only clear if nothing newer has arrived in the meantime.
      if (toastMessage.peek()?.seq === current.seq) toastMessage.value = null;
    }, TOAST_MS);
    return () => clearTimeout(timer);
  }, [current?.seq]);

  if (!current) return null;
  return <div class="toast" role="status">{current.text}</div>;
}
