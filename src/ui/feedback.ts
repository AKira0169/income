/* ui/feedback.ts — telling the user what just happened, and handing them files. */

import { el } from '../dom.ts';
import { periodOf } from '../domain/period.ts';
import { periodLabel } from '../store.ts';
import { goPeriod, period as routePeriod } from '../state/route.ts';
import type { IsoDate } from '../domain/types.ts';

/* The toast itself is a component now; this is the door both halves of the app
   go through while the port is in progress. */
export { toast } from './components/Toast.tsx';
import { toast } from './components/Toast.tsx';

export function download(data: BlobPart, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = el('a', { href: url, download: filename });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function confirmDelete(what: string): boolean {
  return confirm(`Delete this ${what}? This cannot be undone.`);
}

/* An entry dated outside the month on screen would otherwise vanish the moment
   it was saved, which reads as "it was not recorded". Follow it. */
export function followDate(dateISO: IsoDate | '' | null | undefined, message: string): void {
  const period = periodOf(dateISO);
  if (period && period !== routePeriod.peek()) {
    // Through the route, so the address bar and the topbar move with it.
    goPeriod(period);
    toast(`${message} · showing ${periodLabel(period)}`);
    return;
  }
  toast(message);
}
