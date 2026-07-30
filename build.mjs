/* build.mjs — bundles src/ and the SQLite engine into a single self-contained
   income-tracker.html.  Run: node build.mjs

   The page must work when opened straight off the disk, so everything ships
   inside one file: a file:// document cannot fetch a sibling, and OPFS is
   unavailable there — verified, not assumed. */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(here, 'src', name), 'utf8');
const vendor = (name) => join(here, 'vendor', name);

/* A literal </script> anywhere in the bundle would close the tag early. Applied
   last, so it also covers anything minification moved into a string. */
const guard = (code) => code.replace(/<\/script>/gi, '<\\/script>');

/* Stamped into the page and shown beside the title. A browser holding an old
   copy of a file:// page is otherwise indistinguishable from a build that did
   not happen, and the two are fixed in completely different ways. */
const stamp = new Date().toLocaleString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
}).replace(',', ' ·');

/* The wasm binary is base64'd into the page rather than bundled: it is most of
   the file's weight and routing a megabyte through the bundler's loaders buys
   nothing. The loader script must come before the bundle, so that initSqlJs is
   already on globalThis when the app reaches for it. */
const wasmB64 = readFileSync(vendor('sql-wasm.wasm')).toString('base64');
const sqlLoader = readFileSync(vendor('sql-wasm.js'), 'utf8');

const result = await build({
  entryPoints: [join(here, 'src', 'main.ts')],
  bundle: true,
  format: 'iife',
  // esbuild does not read tsconfig's `target`; the app is Chrome/Edge only.
  target: ['chrome110'],
  platform: 'browser',
  minify: true,
  // Without this esbuild escapes every non-ASCII character to \uXXXX, which
  // bloats the bundle and mangles the currency and unit symbols on review.
  charset: 'utf8',
  legalComments: 'none',
  write: false
});

const bundled = result.outputFiles[0].text;

const js = [
  '/* ---- sql.js 1.13.0 (MIT) — SQLite compiled to WebAssembly ---- */',
  guard(sqlLoader),
  `globalThis.__BUILD__ = ${JSON.stringify(stamp)};`,
  '/* ---- sqlite wasm binary (base64) ---- */',
  `globalThis.__SQL_WASM_B64__ = "${wasmB64}";`,
  '/* ---- application bundle (built from src/*.ts) ---- */',
  guard(bundled)
].join('\n');

const html = src('shell.html')
  .replace('/*{{CSS}}*/', () => src('app.css'))
  .replace('/*{{JS}}*/', () => js);

const out = join(here, 'income-tracker.html');
writeFileSync(out, html, 'utf8');

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);
console.log(`built ${out} (${mb(Buffer.byteLength(html, 'utf8'))} MB, no runtime dependencies)`);
console.log(`  stamped: ${stamp} — shown beside the title, so a stale tab is obvious`);
console.log(`  app bundle: ${(Buffer.byteLength(bundled, 'utf8') / 1024).toFixed(0)} KB minified`);
console.log(`  sqlite wasm: ${mb(wasmB64.length)} MB of that, base64-encoded`);
