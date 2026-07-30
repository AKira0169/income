/* build.mjs — bundles src/ and the SQLite engine into a single self-contained
   income-tracker.html.  Run: node build.mjs

   The page must work when opened straight off the disk, so everything ships
   inside one file: a file:// document cannot fetch a sibling, and OPFS is
   unavailable there — verified, not assumed.

   dev.mjs imports the pieces below rather than shelling out to this file, so
   the served page and the shipped page are assembled by the same code. */
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(here, 'src', name), 'utf8');
const vendor = (name) => join(here, 'vendor', name);

/* A literal </script> anywhere in the bundle would close the tag early. Applied
   last, so it also covers anything minification moved into a string. */
const guard = (code) => code.replace(/<\/script>/gi, '<\\/script>');

/* Stamped into the page and shown beside the title. A browser holding an old
   copy of a file:// page is otherwise indistinguishable from a build that did
   not happen, and the two are fixed in completely different ways. */
export const buildStamp = () => new Date().toLocaleString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
}).replace(',', ' ·');

/* The wasm binary is base64'd into the page rather than bundled: it is most of
   the file's weight and routing a megabyte through the bundler's loaders buys
   nothing. Encoding a megabyte is slow enough to notice on every keystroke in
   watch mode, so it is done once and kept. */
/** @type {string | null} */
let wasmB64Cache = null;
const wasmB64 = () => (wasmB64Cache ??= readFileSync(vendor('sql-wasm.wasm')).toString('base64'));

/** Shared by `node build.mjs` and by dev's watch context, so the two cannot
    drift into bundling the app differently.

    The annotation is load-bearing. Returned from a function rather than written
    inline at the call site, `format: 'iife'` widens to `string` and esbuild's
    own types stop accepting it; and pinning `write` to the literal `false` is
    what makes `outputFiles` non-optional in the result.

    @returns {import('esbuild').BuildOptions & { write: false }} */
export function bundleOptions() {
  return {
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
    write: false,
    /* Preact's automatic runtime, matching tsconfig.json — components never
       import `h`. NODE_ENV is defined because Preact's own source reads it, and
       an undefined `process` on a file:// page throws — which Invariant 6 (zero
       console errors) forbids. */
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: { 'process.env.NODE_ENV': '"production"' }
  };
}

/** The whole single-file page, from an already-bundled application script.
    `extra` is appended inside the same <script>; dev uses it for live reload. */
export function page(bundled, stamp = buildStamp(), extra = '') {
  const js = [
    '/* ---- sql.js 1.13.0 (MIT) — SQLite compiled to WebAssembly ---- */',
    guard(readFileSync(vendor('sql-wasm.js'), 'utf8')),
    `globalThis.__BUILD__ = ${JSON.stringify(stamp)};`,
    '/* ---- sqlite wasm binary (base64) ---- */',
    `globalThis.__SQL_WASM_B64__ = "${wasmB64()}";`,
    '/* ---- application bundle (built from src/*.ts) ---- */',
    guard(bundled),
    extra
  ].join('\n');

  return src('shell.html')
    .replace('/*{{CSS}}*/', () => src('app.css'))
    .replace('/*{{JS}}*/', () => js);
}

/* Only when run directly — dev.mjs imports the helpers above instead. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stamp = buildStamp();
  const result = await build(bundleOptions());
  const bundled = result.outputFiles[0]?.text ?? '';
  const html = page(bundled, stamp);

  const out = join(here, 'income-tracker.html');
  writeFileSync(out, html, 'utf8');

  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);
  console.log(`built ${out} (${mb(Buffer.byteLength(html, 'utf8'))} MB, nothing to install)`);
  console.log(`  stamped: ${stamp} — shown beside the title, so a stale tab is obvious`);
  console.log(`  app bundle: ${(Buffer.byteLength(bundled, 'utf8') / 1024).toFixed(0)} KB minified`);
  console.log(`  sqlite wasm: ${mb(wasmB64().length)} MB of that, base64-encoded`);
}
