/* ui/LegacyTab.tsx — the bridge that keeps the app whole while it is ported.

   A tab that has not been rewritten yet still returns one HTMLElement built by
   hand. This mounts that element into a ref'd div and rebuilds it whenever
   anything it might have read has changed: the state signal, the route, or the
   legacy render() tick.

   It is a teardown, not a diff — the same thing the old draw() did — so it is
   exactly as good as before for the tabs still using it and no better. Each
   port deletes one of these. The last one deletes the file. */

import { useLayoutEffect, useRef } from 'preact/hooks';
import { close as closeDatePicker } from '../datepicker.ts';
import { app } from '../state/app.ts';
import { period as routePeriod, tab as routeTab } from '../state/route.ts';
import { legacyTick } from './view.ts';

/* The legacy handlers call render() during their own event, never during DOM
   construction — but a future one might, and a rebuild that schedules a rebuild
   is a runaway with no useful stack. Two lines to make it a no-op instead. */
let rebuilding = false;

export function LegacyTab({ render }: { render: () => HTMLElement }) {
  const host = useRef<HTMLDivElement>(null);

  /* Read every signal this output could depend on, so Preact re-renders — and
     the effect below re-runs — when any of them changes. The legacy modules
     reach for `view` and the store binding rather than taking arguments, so
     there is nothing finer-grained to subscribe to. */
  app.value;
  routeTab.value;
  routePeriod.value;
  legacyTick.value;

  useLayoutEffect(() => {
    const node = host.current;
    if (!node || rebuilding) return;
    rebuilding = true;
    try {
      /* The calendar hangs outside this subtree, so it would outlive the field
         it belongs to if a rebuild happened while it was open. */
      closeDatePicker();
      node.replaceChildren(render());
    } finally {
      rebuilding = false;
    }
  });

  return <div ref={host} />;
}
