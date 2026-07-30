/* ui/feedback.ts — telling the user what just happened, and handing them files.

   The three things a screen needs that are not markup: a toast, a confirm, and
   a download. The toast itself is a component; this is the door to it. */

import { periodOf } from '../domain/period.ts';
import { periodLabel } from '../domain/period.ts';
import { snapshot } from '../state/app.ts';
import { goPeriod, period as routePeriod } from '../state/route.ts';
import type { IsoDate } from '../domain/types.ts';
import { toast } from './components/Toast.tsx';

export { toast } from './components/Toast.tsx';

/* A Blob URL and a click on a link the user never sees. There is no server
   here, so this is the only way a file leaves the page. */
export function download(data: BlobPart, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
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
    toast(`${message} · showing ${periodLabel(period, snapshot().settings.locale)}`);
    return;
  }
  toast(message);
}
