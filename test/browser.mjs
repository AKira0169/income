/* Browser test: drives the built income-tracker.html from a real file:// origin.

   This is the half Node cannot reach. The suite in export.ts runs the store and
   the workbook writer against plain memory; nothing there touches SQLite/WASM,
   IndexedDB, the DOM, or the Blob path the download button uses. Those only
   exist in a browser, and only behave correctly on a file:// origin — which is
   how the app is actually opened, and is a different storage origin from any
   localhost server.

   Run:  node test/browser.mjs        (after `node build.mjs`)
   Set CHROME_PATH to pick a specific browser. */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page = pathToFileURL(join(here, '..', 'income-tracker.html')).href;

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean);

const executablePath = CANDIDATES.find((p) => existsSync(p));
if (!executablePath) {
  console.log('No Chrome or Edge found — skipping the browser suite.');
  console.log('Set CHROME_PATH to run it.');
  process.exit(0);
}

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
  } else console.log(`  ok   ${label}`);
};

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ['--allow-file-access-from-files']
});

try {
  const tab = await browser.newPage();
  const errors = [];
  tab.on('pageerror', (e) => errors.push(String(e)));
  tab.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  /* The app puts its route in the hash, so once it has run the URL is
     `…income-tracker.html#/income/2026-07`. Navigating from that back to the
     bare file:// URL differs only by fragment, which the browser treats as a
     same-document navigation: nothing reloads, and the persistence checks below
     would pass without SQLite ever having been re-opened. The explicit reload
     is what makes them mean anything; the probe below is what proves it. */
  const open = async () => {
    await tab.goto(page, { waitUntil: 'load' });
    await tab.reload({ waitUntil: 'load' });
    await tab.waitForSelector('.topbar', { timeout: 30000 });
  };

  /* ---------------- boot ---------------- */
  console.log('boot:');
  await open();
  check('the build stamp is on the page', await tab.evaluate(() => typeof globalThis.__BUILD__ === 'string'), true);
  check('sqlite reached IndexedDB, not the memory fallback',
    await tab.evaluate(() => globalThis.__app.backend()), 'indexeddb');
  check('every tab renders',
    await tab.evaluate(() => document.querySelectorAll('.tab').length), 7);

  /* ---------------- hash routing ---------------- */
  console.log('\nhash routing (reload and back/forward):');
  const selectedTab = () => tab.evaluate(() =>
    [...document.querySelectorAll('.tab')].find((b) => b.getAttribute('aria-selected') === 'true')?.textContent);
  const settle = () => tab.evaluate(() => new Promise((r) => setTimeout(r, 100)));

  await tab.evaluate(() => globalThis.__app.goTab('gold'));
  await settle();
  check('the tab is in the address bar', /#\/gold\/\d{4}-\d{2}$/.test(tab.url()), true);

  await tab.evaluate(() => [...document.querySelectorAll('.period-nav button')]
    .find((b) => b.getAttribute('aria-label') === 'Previous month').click());
  await settle();
  const stepped = tab.url();
  check('and so is the month', /#\/gold\/\d{4}-\d{2}$/.test(stepped), true);

  await tab.reload({ waitUntil: 'load' });
  await tab.waitForSelector('.topbar');
  check('a reload lands on the same tab', await selectedTab(), 'Gold');
  check('in the same month', tab.url(), stepped);

  await tab.goBack({ waitUntil: 'load' });
  await settle();
  check('back steps to the month before it', tab.url() !== stepped, true);
  await tab.goForward({ waitUntil: 'load' });
  await settle();
  check('and forward returns', tab.url(), stepped);

  // Start from a clean database, whatever a previous run left behind.
  await tab.evaluate(() => globalThis.__app.clearAll());
  await tab.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  /* ---------------- entering data through the UI ---------------- */
  console.log('\nadding records through the real forms:');

  // An account first, so the entries below have somewhere to land.
  await tab.evaluate(() => globalThis.__app.upsert('accounts', {
    id: 'acc_t', name: 'Test Card', type: 'Current Account', opening: 100000, target: 0, notes: ''
  }));

  await tab.evaluate(() => globalThis.__app.goTab('income'));
  await tab.waitForSelector('button[aria-expanded]');

  // Unfold the add-panel and fill it in the way a person would.
  await tab.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add income');
    btn.click();
  });
  await tab.waitForSelector('form input[name="source"]');

  await tab.evaluate(() => {
    const form = document.querySelector('form');
    form.querySelector('input[name="source"]').value = 'Ünïcode Ltd 💷';
    form.querySelector('input[name="amount"]').value = '1,234.56';
    form.querySelector('.dp-text').value = '15/07/2026';
    form.querySelector('.dp-text').dispatchEvent(new Event('blur'));
    form.querySelector('select[name="accountId"]').value = 'acc_t';
    form.requestSubmit();
  });
  await tab.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  const entered = await tab.evaluate(() => globalThis.__app.state().income[0]);
  check('the form wrote one income entry', await tab.evaluate(() => globalThis.__app.state().income.length), 1);
  check('non-ascii text survives the form', entered.source, 'Ünïcode Ltd 💷');
  // The grouped-thousands input must land as integer cents, not 1.23.
  check('a grouped amount parses to cents', entered.amount, 123456);
  check('the typed date parses to ISO', entered.date, '2026-07-15');
  check('the account selection is kept', entered.accountId, 'acc_t');
  check('the balance moved by exactly that amount',
    await tab.evaluate(() => globalThis.__app.accountBalance('acc_t')), 100000 + 123456);

  /* ---------------- persistence across a reload ---------------- */
  console.log('\npersistence (SQLite -> IndexedDB -> reload):');
  await tab.evaluate(() => { globalThis.__probe = 'survived'; });
  await open();
  check('open() really reloaded the page, hash routing notwithstanding',
    await tab.evaluate(() => globalThis.__probe), undefined);
  const after = await tab.evaluate(() => globalThis.__app.state().income[0]);
  check('the entry is still there after a reload', !!after, true);
  check('and its text is unchanged', after?.source, 'Ünïcode Ltd 💷');
  check('and its amount is unchanged', after?.amount, 123456);
  check('the balance still adds up',
    await tab.evaluate(() => globalThis.__app.accountBalance('acc_t')), 223456);

  /* ---------------- the date field's own keyboard behaviour ---------------- */
  console.log('\ndate field:');
  await tab.evaluate(() => globalThis.__app.goTab('purchases'));
  await tab.waitForSelector('form input[name="item"]');
  await tab.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add purchase');
    if (btn) btn.click();
  });
  await tab.waitForSelector('.dp-text');
  check('the calendar opens on ArrowDown', await tab.evaluate(async () => {
    const input = document.querySelector('.dp-text');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return !!document.querySelector('.dp-pop');
  }), true);
  check('Escape closes it again', await tab.evaluate(async () => {
    document.querySelector('.dp-pop')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    return !!document.querySelector('.dp-pop');
  }), false);

  /* ---------------- a half-typed form survives a redraw ---------------- */

  /* The trap the whole form design is arranged around. If a field renders
     `value={initial}` instead of `defaultValue`, Preact writes that initial
     value back on every re-render and eats what was typed. The rest of this
     suite cannot see it, because it fills a form and submits inside one tick.
     Here the write comes from somewhere else entirely, which is what happens in
     real use — the gold price arriving after boot does exactly this. */
  console.log('\na half-typed form survives a write from elsewhere:');
  const optionCount = () => tab.evaluate(() =>
    document.querySelectorAll('form select[name="accountId"] option').length);

  const optionsBefore = await optionCount();
  await tab.evaluate(() => { document.querySelector('form input[name="item"]').value = 'half typed'; });
  await tab.evaluate(() => globalThis.__app.upsert('accounts', {
    name: 'Distraction', type: 'Current Account', opening: 0, target: 0, notes: ''
  }));
  await tab.evaluate(() => new Promise((r) => setTimeout(r, 200)));

  // Without this the check above could pass by the form never redrawing at all.
  check('the open form really did redraw', (await optionCount()) > optionsBefore, true);
  check('and the half-typed text is still there',
    await tab.evaluate(() => document.querySelector('form input[name="item"]').value), 'half typed');
  check('as is the date the user picked',
    await tab.evaluate(() => document.querySelector('.dp-text').value !== ''), true);

  /* ---------------- inline editing keeps the field ---------------- */

  /* The regression the rewrite exists to fix. The old draw() cleared #app and
     rebuilt it on every write, so committing an inline amount destroyed the
     input being typed in and threw the page back up to the top. */
  console.log('\nediting a bill amount in place:');
  await tab.evaluate(() => globalThis.__app.upsert('bills', {
    id: 'bil_t', templateId: null, name: 'Electricity', category: 'Electricity', provider: '',
    dueDate: '2026-07-20', amount: 0, accountId: 'acc_t', units: null, unitRate: null,
    paidDate: '', method: '', notes: ''
  }));
  await tab.evaluate(() => globalThis.__app.goTab('bills'));
  await tab.evaluate(() => globalThis.__app.goPeriod('2026-07'));
  await tab.waitForSelector('input[aria-label="Electricity amount"]');

  const inlineEdit = await tab.evaluate(async () => {
    const field = document.querySelector('input[aria-label="Electricity amount"]');
    field.focus();
    field.value = '1,250.75';
    field.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const after = document.querySelector('input[aria-label="Electricity amount"]');
    return {
      stored: globalThis.__app.state().bills.find((b) => b.id === 'bil_t').amount,
      sameNode: after === field,
      stillFocused: document.activeElement === field,
      scroll: window.scrollY
    };
  });
  check('the amount is stored as cents', inlineEdit.stored, 125075);
  check('the input was not torn down and rebuilt', inlineEdit.sameNode, true);
  check('focus stayed in the field', inlineEdit.stillFocused, true);
  check('and the page did not jump', inlineEdit.scroll, 0);

  await tab.evaluate(() => globalThis.__app.goTab('purchases'));

  /* ---------------- the browser-only export path ---------------- */
  console.log('\nexport from the browser (Blob + TextEncoder, never hit in Node):');
  const xlsx = await tab.evaluate(() => {
    const bytes = globalThis.__app.buildWorkbook({ type: 'all' });
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    return { length: bytes.length, zip: bytes[0] === 0x50 && bytes[1] === 0x4b, blobSize: blob.size };
  });
  check('the workbook is a non-trivial file', xlsx.length > 10000, true);
  check('it starts with the ZIP magic number', xlsx.zip, true);
  check('and survives being wrapped in a Blob', xlsx.blobSize, xlsx.length);

  const db = await tab.evaluate(() => {
    const bytes = globalThis.__app.exportDb();
    // Every SQLite file starts with this header string.
    return String.fromCharCode(...bytes.slice(0, 15));
  });
  check('the .db download is a real SQLite file', db, 'SQLite format 3');

  /* ---------------- the read-only SQL console ---------------- */
  console.log('\nSQL console:');
  check('a SELECT returns the row just entered', await tab.evaluate(() =>
    globalThis.__app.query('SELECT source, amount FROM income').rows[0]),
  ['Ünïcode Ltd 💷', 123456]);
  check('a write is refused', await tab.evaluate(() => {
    try { globalThis.__app.query('DELETE FROM income'); return 'allowed'; }
    catch { return 'refused'; }
  }), 'refused');
  check('the delete really did not happen',
    await tab.evaluate(() => globalThis.__app.state().income.length), 1);

  /* ---------------- leave nothing behind ---------------- */
  await tab.evaluate(() => globalThis.__app.clearAll());
  await tab.evaluate(() => new Promise((r) => setTimeout(r, 300)));

  console.log('\nconsole:');
  check('no uncaught errors or console errors', errors, []);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
