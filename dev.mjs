/* dev.mjs — watch src/ and serve the page with live reload.  Run: pnpm dev

   The page served here is byte-for-byte what `pnpm build` writes, plus a small
   reload listener: same inlined base64 wasm, same bundle options, assembled by
   the same `page()` in build.mjs. Serving the .wasm as a separate file would be
   faster to start and would make initSqlite() — the hardest part of the app to
   test — take a different route in dev than in the artifact people actually
   open. The base64 is computed once and reused across rebuilds, so it costs
   nothing after the first one.

   Note: http://localhost is a different storage origin from file://, so the
   data you enter here is separate from the data in the real app. */
import { context } from 'esbuild';
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { bundleOptions, buildStamp, here, page } from './build.mjs';

const PORT = Number(process.env.PORT) || 5173;

let html = '';
let version = 0;
/* Held-open responses, one per tab. A rebuild writes to them and they close,
   which is all Server-Sent Events needs to be — no client library. */
const clients = new Set();

/* Polls rather than using EventSource: an EventSource that fails to connect
   logs a console error, and the browser suite asserts there are none. This is
   dev-only code, but the habit of keeping the console clean is worth keeping. */
const reloadSnippet = (v) => `
/* ---- dev live reload (not present in \`pnpm build\` output) ---- */
(() => {
  const mine = ${v};
  const tick = async () => {
    try {
      const res = await fetch('/__version', { cache: 'no-store' });
      if (res.ok && Number(await res.text()) !== mine) return location.reload();
    } catch { /* server restarting — try again next tick */ }
    setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
})();`;

const ctx = await context({
  ...bundleOptions(),
  minify: false,
  sourcemap: 'inline',
  plugins: [{
    name: 'rebuild-page',
    setup(build) {
      build.onEnd((result) => {
        const bundled = result.outputFiles?.[0]?.text;
        if (result.errors.length || bundled === undefined) {
          console.log(`  ${result.errors.length} error(s) — page left at the last good build`);
          return;
        }
        version++;
        html = page(bundled, `${buildStamp()} · dev`, reloadSnippet(version));
        for (const res of clients) res.end(String(version));
        clients.clear();
        console.log(`  rebuilt #${version} — ${new Date().toLocaleTimeString('en-GB')}`);
      });
    }
  }]
});

await ctx.watch();

/* esbuild only watches what the bundle imports, and neither of these is
   imported — they are read as text by page(). */
for (const file of ['app.css', 'shell.html']) {
  watch(join(here, 'src', file), () => void ctx.rebuild().catch(() => {}));
}

createServer((req, res) => {
  if (req.url?.startsWith('/__version')) {
    /* Held open until the next rebuild, so a change lands within a frame rather
       than within a poll interval. The 25s cap keeps proxies from timing out. */
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    clients.add(res);
    res.on('close', () => clients.delete(res));
    setTimeout(() => { if (clients.delete(res)) res.end(String(version)); }, 25000);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}).listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}`);
  console.log('  localhost is a different storage origin from file:// — this data is separate');
});
