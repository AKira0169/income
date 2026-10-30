/* build.mjs — bundles src/web into dist/web: index.html plus hashed JS and
   CSS under dist/web/assets.  Run: node build.mjs

   The page is served by Caddy from one origin with the api and Kratos, so it no
   longer has to be one self-contained file. Hashed names let Caddy cache the
   assets forever while index.html is always revalidated — a new build is picked
   up on the next load, never half of one.

   dev.mjs imports bundleOptions() and writeIndex() rather than shelling out, so
   the watched build and the shipped build are assembled by the same code. */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const here = dirname(fileURLToPath(import.meta.url));
export const outDir = join(here, 'dist', 'web');
const OUT_PREFIX = 'dist/web/';

/* Stamped into the bundle and shown beside the title, so a stale tab is
   obvious at a glance. */
export const buildStamp = () => new Date().toLocaleString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
}).replace(',', ' ·');

/** Shared by `node build.mjs` and dev's watch context.

    The annotation is load-bearing: pinning `metafile` to the literal `true` is
    what makes `result.metafile` non-optional for the caller.

    @param {string} stamp
    @param {boolean} [minify]
    @returns {import('esbuild').BuildOptions & { metafile: true; write: true }} */
export function bundleOptions(stamp, minify = true) {
  return {
    absWorkingDir: here,
    entryPoints: {
      app: join(here, 'src', 'web', 'main.tsx'),
      style: join(here, 'src', 'web', 'app.css')
    },
    outdir: outDir,
    entryNames: 'assets/[name]-[hash]',
    bundle: true,
    format: 'esm',
    // esbuild does not read tsconfig's `target`; the app is Chrome/Edge only.
    target: ['chrome110'],
    platform: 'browser',
    minify,
    sourcemap: minify ? false : 'linked',
    // Without this esbuild escapes every non-ASCII character to \uXXXX.
    charset: 'utf8',
    legalComments: 'none',
    metafile: true,
    write: true,
    jsx: 'automatic',
    jsxImportSource: 'preact',
    define: {
      'process.env.NODE_ENV': '"production"',
      __BUILD__: JSON.stringify(stamp)
    }
  };
}

/** Writes dist/web/index.html pointing at whatever the last build emitted.
    @param {import('esbuild').Metafile} metafile
    @returns {{ js: string; css: string }} */
export function writeIndex(metafile) {
  /** @param {string} entry */
  const urlOf = (entry) => {
    const hit = Object.entries(metafile.outputs)
      .find(([file, out]) => out.entryPoint === entry && !file.endsWith('.map'));
    if (!hit) throw new Error(`build produced nothing for ${entry}`);
    return '/' + hit[0].replaceAll('\\', '/').slice(OUT_PREFIX.length);
  };
  const js = urlOf('src/web/main.tsx');
  const css = urlOf('src/web/app.css');
  const html = readFileSync(join(here, 'src', 'web', 'index.html'), 'utf8')
    .replace('<!--{{CSS}}-->', `<link rel="stylesheet" href="${css}">`)
    .replace('<!--{{JS}}-->', `<script type="module" src="${js}"></script>`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html, 'utf8');
  return { js, css };
}

/** @param {{ stamp?: string; minify?: boolean }} [options] */
export async function buildWeb({ stamp = buildStamp(), minify = true } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  const result = await build(bundleOptions(stamp, minify));
  return writeIndex(result.metafile);
}

/* Only when run directly — dev.mjs and the tests import the helpers above. */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const stamp = buildStamp();
  const { js, css } = await buildWeb({ stamp });
  console.log(`built ${outDir}`);
  console.log(`  ${js}\n  ${css}`);
  console.log(`  stamped: ${stamp}`);
}
