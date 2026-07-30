/* build.mjs — inlines src/ and the SQLite engine into a single
   self-contained income-tracker.html.  Run: node build.mjs */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (name) => readFileSync(join(here, 'src', name), 'utf8');
const vendor = (name) => join(here, 'vendor', name);

// A literal </script> anywhere in the bundle would close the tag early.
const guard = (code) => code.replace(/<\/script>/gi, '<\\/script>');

const ORDER = ['xlsx.js', 'store.js', 'sqlite.js', 'export.js', 'ui.js'];

/* The wasm binary is base64'd into the page because a file:// document cannot
   fetch a sibling file, and OPFS is unavailable there — verified, not assumed. */
const wasmB64 = readFileSync(vendor('sql-wasm.wasm')).toString('base64');
const sqlLoader = readFileSync(vendor('sql-wasm.js'), 'utf8');

const js = [
  '/* ---- sql.js 1.13.0 (MIT) — SQLite compiled to WebAssembly ---- */',
  guard(sqlLoader),
  '/* ---- sqlite wasm binary (base64) ---- */',
  `globalThis.__SQL_WASM_B64__ = "${wasmB64}";`,
  ...ORDER.map((name) => `/* ---- ${name} ---- */\n${guard(src(name))}`)
].join('\n');

const html = src('shell.html')
  .replace('/*{{CSS}}*/', () => src('app.css'))
  .replace('/*{{JS}}*/', () => js);

const out = join(here, 'income-tracker.html');
writeFileSync(out, html, 'utf8');

const mb = (Buffer.byteLength(html, 'utf8') / 1024 / 1024).toFixed(2);
console.log(`built ${out} (${mb} MB, no external dependencies)`);
console.log(`  sqlite wasm: ${(wasmB64.length / 1024 / 1024).toFixed(2)} MB of that, base64-encoded`);
