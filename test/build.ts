/* Build test: `pnpm build` must leave a servable dist/web — an index.html
   whose script and stylesheet point at hashed files that really exist, and no
   trace of the retired single-file assembly.

   Run:  node test/build.ts */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWeb, outDir } from '../build.mjs';
import { check, finish } from './support/check.ts';

console.log('dist/web:');
const written = await buildWeb({ stamp: 'test' });
const html = readFileSync(join(outDir, 'index.html'), 'utf8');

check('the script is a hashed asset', /^\/assets\/app-[A-Z0-9]+\.js$/i.test(written.js), true);
check('the stylesheet is a hashed asset', /^\/assets\/style-[A-Z0-9]+\.css$/i.test(written.css), true);
check('index.html loads the script as a module', html.includes(`<script type="module" src="${written.js}"></script>`), true);
check('index.html links the stylesheet', html.includes(`<link rel="stylesheet" href="${written.css}">`), true);
check('the script exists', existsSync(join(outDir, written.js)), true);
check('the stylesheet exists', existsSync(join(outDir, written.css)), true);
check('there is a mount point', html.includes('<div id="app"></div>'), true);
check('no inline script is left (CSP-friendly)', /<script>(?!<\/script>)/.test(html), false);
check('sql.js is gone', readFileSync(join(outDir, written.js), 'utf8').includes('__SQL_WASM_B64__'), false);

finish();
