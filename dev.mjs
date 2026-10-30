/* dev.mjs — rebuild dist/web on every change.  Run: pnpm dev

   There is no dev server here any more: the dev compose stack (pnpm stack:dev)
   mounts dist/web into Caddy, so the page is served from https://localhost with
   the real /api and /auth beside it — the same origin rules as production.
   Reload the tab after a rebuild. */
import { context } from 'esbuild';
import { bundleOptions, buildStamp, writeIndex } from './build.mjs';

const ctx = await context({
  ...bundleOptions(`${buildStamp()} · dev`, false),
  plugins: [{
    name: 'write-index',
    setup(b) {
      b.onEnd((result) => {
        if (result.errors.length || !result.metafile) {
          console.log(`  ${result.errors.length} error(s) — dist/web left at the last good build`);
          return;
        }
        writeIndex(result.metafile);
        console.log(`  rebuilt — ${new Date().toLocaleTimeString('en-GB')}`);
      });
    }
  }]
});

await ctx.watch();
console.log('watching src/ → dist/web (served by the dev stack at https://localhost)');
