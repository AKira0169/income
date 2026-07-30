/* Round-trip test: write a workbook with our own writer, read it back with a
   real parser (SheetJS, installed only in the scratchpad as a throwaway oracle).
   Run:  node test/roundtrip.mjs
   Requires XLSX_ORACLE env var pointing at a directory with `xlsx` installed. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.XLSX_OUT || join(here, '..', '.tmp');
mkdirSync(outDir, { recursive: true });

await import(pathToFileURL(join(here, '..', 'src', 'xlsx.js')).href);
const XLSXMini = globalThis.XLSXMini;

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failures++; console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`); }
  else console.log(`  ok   ${label}`);
};

/* Deliberately hostile content: non-ASCII (multi-byte) strings, an emoji,
   XML metacharacters, negative numbers, zero, and a large number. If byte
   offsets are computed on string length anywhere, this file will not parse. */
const rows = [
  [{ v: 'Étiquette', s: 'header' }, { v: 'Montant', s: 'header' }, { v: 'Date', s: 'header' }, { v: 'Note', s: 'header' }],
  ['Électricité — Ørsted', { t: 'money', v: 123.45 }, { t: 'date', v: '2026-07-01' }, 'a & b < c > d "quoted"'],
  ['水道料金 💧', { t: 'money', v: -67.89 }, { t: 'date', v: '2028-02-29' }, "it's fine"],
  ['Интернет', { t: 'money', v: 0 }, { t: 'date', v: '1999-12-31' }, ''],
  ['Big', { t: 'money', v: 1234567.89 }, { t: 'date', v: '2026-12-31' }, null],
  [{ v: 'Total', s: 'bold' }, { t: 'formula', f: 'SUM(B2:B5)', v: 1234623.45, s: 'moneyBold' }, null, null]
];

const bytes = XLSXMini.write({
  currency: '€',
  when: new Date(2026, 6, 29, 12, 0, 0),
  sheets: [
    { name: 'Ünïcødé', freeze: 1, autoFilter: 'A1:D5', cols: [{ w: 26 }, { w: 14 }, { w: 12 }, { w: 30 }], rows },
    { name: 'Empty', rows: [] },
    { name: 'Sheet/With:Bad*Chars[]?', rows: [['ok']] }
  ]
});

const file = join(outDir, 'roundtrip.xlsx');
writeFileSync(file, bytes);
console.log(`\nwrote ${file} (${bytes.length} bytes)\n`);

/* ---- structural assertions that need no oracle ---- */
console.log('structure:');
const eocdSig = bytes.length - 22;
check('EOCD signature', [bytes[eocdSig], bytes[eocdSig + 1], bytes[eocdSig + 2], bytes[eocdSig + 3]], [0x50, 0x4b, 0x05, 0x06]);
check('local header signature at 0', [bytes[0], bytes[1], bytes[2], bytes[3]], [0x50, 0x4b, 0x03, 0x04]);
const cdOffset = bytes[eocdSig + 16] | (bytes[eocdSig + 17] << 8) | (bytes[eocdSig + 18] << 16) | (bytes[eocdSig + 19] << 24);
check('central directory signature at recorded offset',
  [bytes[cdOffset], bytes[cdOffset + 1], bytes[cdOffset + 2], bytes[cdOffset + 3]], [0x50, 0x4b, 0x01, 0x02]);

/* ---- oracle round-trip ----
   Reads the file back with SheetJS. Set XLSX_ORACLE to a directory containing
   an `xlsx` install, or run `npm run test:full` to install one locally. */
const oracleDir = process.env.XLSX_ORACLE || join(here, '..');
const oraclePath = resolve(oracleDir, 'node_modules', 'xlsx', 'xlsx.mjs');
if (!existsSync(oraclePath)) {
  console.log('\nNo `xlsx` oracle found — skipping parser round-trip.');
  console.log('Run `npm run test:full` to install one and verify against a real parser.');
  process.exit(failures ? 1 : 0);
}

const XLSX = (await import(pathToFileURL(oraclePath).href));
// cellNF/cellStyles are required for `.z` (number format) to be populated.
const wb = XLSX.read(readFileSync(file), { type: 'buffer', cellDates: false, cellNF: true, cellStyles: true });

console.log('\nparsed back:');
check('sheet names', wb.SheetNames, ['Ünïcødé', 'Empty', 'Sheet With Bad Chars']);

const ws = wb.Sheets['Ünïcødé'];
const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

check('header row', grid[0], ['Étiquette', 'Montant', 'Date', 'Note']);
check('row 2 label', grid[1][0], 'Électricité — Ørsted');
check('row 2 amount', grid[1][1], 123.45);
// Serials are hardcoded (not taken from our own dateSerial) so the check is
// independent of the writer.
check('row 2 date serial 2026-07-01', grid[1][2], 46204);
check('row 2 xml metachars', grid[1][3], 'a & b < c > d "quoted"');
check('row 3 emoji label', grid[2][0], '水道料金 💧');
check('row 3 negative amount', grid[2][1], -67.89);
check('row 3 leap-day serial 2028-02-29', grid[2][2], 46812);
check('row 4 cyrillic label', grid[3][0], 'Интернет');
check('row 4 zero amount', grid[3][1], 0);
check('row 4 pre-2000 date serial 1999-12-31', grid[3][2], 36525);
check('row 5 large amount', grid[4][1], 1234567.89);
check('formula text', ws['B6'].f, 'SUM(B2:B5)');
check('formula cached value', ws['B6'].v, 1234623.45);

// Dates must render as dates, not raw serials.
check('date cell has a date number format', /y+.*m+.*d+/i.test(ws['C2'].z || ''), true);
check('money cell has currency in its format', (ws['B2'].z || '').includes('€'), true);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
