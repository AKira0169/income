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
    await tab.evaluate(() => document.querySelectorAll('.tab').length), 8);

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

  /* ---------------- the date field inside a modal dialog ---------------- */

  /* Every editor's date field lives inside a <dialog> opened with showModal(),
     which is the awkward case: the dialog paints in the top layer and
     .dialog-body is its own scroll box. The old picker appended its calendar to
     the dialog by hand for exactly that reason; this one relies on position:
     fixed inside the dialog giving both. The hit test is the check that matters
     — a calendar painting *under* the backdrop is present, sized and unusable. */
  console.log('\nthe calendar inside an editor dialog:');
  await tab.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Edit').click());
  await settle();

  const inDialog = await tab.evaluate(async () => {
    const input = document.querySelector('dialog[open] .dp-text');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const pop = document.querySelector('.dp-pop');
    if (!pop) return { open: false };
    const b = pop.getBoundingClientRect();
    return {
      open: true,
      onScreen: b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= window.innerHeight,
      // Painted at its own centre, i.e. above the dialog's backdrop.
      onTop: pop.contains(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2))
    };
  });
  check('it opens', inDialog.open, true);
  check('it is placed on screen', inDialog.onScreen, true);
  check('and it is not behind the backdrop', inDialog.onTop, true);

  /* Typing a date and then clicking away while the calendar is open must still
     commit it, or the box goes on showing a date the form would not save. */
  const committed = await tab.evaluate(async () => {
    const form = document.querySelector('dialog[open] form');
    const input = form.querySelector('.dp-text');
    input.value = '23/07/2026';
    const elsewhere = form.querySelector('input[name="amount"]');
    elsewhere.focus();
    input.dispatchEvent(new Event('blur'));
    await new Promise((r) => setTimeout(r, 150));
    return { shown: input.value, stored: form.elements.namedItem('dueDate').value };
  });
  check('typing then leaving the field commits what was typed', committed.stored, '2026-07-23');
  check('and the box agrees with it', committed.shown, '23/07/2026');
  await tab.evaluate(() => document.querySelector('dialog[open]')?.close());
  await settle();

  /* ---------------- every tab renders against real data ---------------- */

  /* The checks above enter data through Income and Purchases and edit a bill.
     Dashboard, Accounts, Gold and Settings are otherwise never rendered at all
     here, and a component that throws on its first render takes the whole page
     with it — so each one is opened once with records on screen. */
  console.log('\nevery tab draws with data in it:');
  await tab.evaluate(() => {
    const a = globalThis.__app;
    a.upsert('savingsTx', { id: 'sav_t', date: '2026-07-07', accountId: 'acc_t', fromAccountId: '', direction: 'in', amount: 50000, notes: '' });
    a.upsert('goldPrices', { id: 'gpr_2026-07-29', date: '2026-07-29', usdPerOz: 3110.34768, egpPerUsd: 10, egpPerGram24: 100000, source: 'test', fetchedAt: '' });
    a.upsert('goldPrices', { id: 'gpr_2026-07-30', date: '2026-07-30', usdPerOz: 3200, egpPerUsd: 10, egpPerGram24: 102890, source: 'test', fetchedAt: '' });
    a.upsert('gold', { id: 'gld_t', date: '2026-07-10', direction: 'buy', karat: 21, grams: 8, pricePerGram: 90000, amount: 720000, accountId: 'acc_t', dealer: 'Souq', notes: '' });
  });

  for (const id of ['dashboard', 'income', 'bills', 'purchases', 'savings', 'goals', 'gold', 'settings']) {
    await tab.evaluate((t) => globalThis.__app.goTab(t), id);
    await settle();
    check(`${id} renders something`, await tab.evaluate(() =>
      document.querySelectorAll('main .sheet, main .figure').length > 0), true);
  }

  // The gold sparkline is the one piece of SVG the app draws by hand.
  await tab.evaluate(() => globalThis.__app.goTab('gold'));
  await settle();
  check('the price sparkline is drawn',
    await tab.evaluate(() => !!document.querySelector('svg.spark')), true);

  await tab.evaluate(() => globalThis.__app.goTab('purchases'));
  await settle();

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

  /* ---------------- goals: ordering, the form, and SQLite ---------------- */
  console.log('\nthe Goals tab:');
  await tab.evaluate(() => {
    const a = globalThis.__app;
    a.upsert('goals', { id: 'gol_1', name: 'First', price: 100000, priority: 1, boughtDate: '', notes: '' });
    a.upsert('goals', { id: 'gol_2', name: 'Second', price: 200000, priority: 2, boughtDate: '', notes: '' });
  });
  await tab.evaluate(() => globalThis.__app.goTab('goals'));
  await settle();

  // The goals table is the first table on the tab; column 1 is the name cell.
  const goalOrder = () => tab.evaluate(() => [...document.querySelectorAll('main table')[0]
    .querySelectorAll('tbody tr')].map((r) => r.children[1].textContent));

  check('the Goals tab renders the queue', await goalOrder(), ['First', 'Second']);

  await tab.evaluate(() => document
    .querySelector('button[aria-label="Move Second up"]').click());
  await settle();
  check('move up reorders the queue', await goalOrder(), ['Second', 'First']);

  await tab.evaluate(() => document
    .querySelector('button[aria-label="Move Second down"]').click());
  await settle();
  check('and move down puts it back', await goalOrder(), ['First', 'Second']);
  check('move up is disabled on the first goal', await tab.evaluate(() =>
    document.querySelector('button[aria-label="Move First up"]').disabled), true);
  check('move down is disabled on the last goal', await tab.evaluate(() =>
    document.querySelector('button[aria-label="Move Second down"]').disabled), true);

  await tab.evaluate(() => globalThis.__app.goTab('dashboard'));
  await settle();
  check('the Dashboard shows a Goals panel once there are goals',
    await tab.evaluate(() => [...document.querySelectorAll('main .sheet h2')]
      .some((h) => h.textContent === 'Goals')), true);
  await tab.evaluate(() => globalThis.__app.goTab('goals'));
  await settle();

  /* The same trap the rest of the suite is arranged around: a field rendering
     `value={initial}` instead of `defaultValue` eats what was typed the moment
     anything else redraws the page. */
  await tab.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Add a goal');
    btn.click();
  });
  await tab.waitForSelector('form input[name="name"]');
  await tab.evaluate(() => { document.querySelector('form input[name="name"]').value = 'half typed'; });
  await tab.evaluate(() => globalThis.__app.upsert('goals', {
    id: 'gol_3', name: 'Distraction', price: 0, priority: 3, boughtDate: '', notes: ''
  }));
  await tab.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  check('the open goal form really did redraw', (await goalOrder()).length, 3);
  check('and the half-typed name is still there',
    await tab.evaluate(() => document.querySelector('form input[name="name"]').value), 'half typed');

  /* The reported bug: "Bought" ticked the goal off and left every account
     reading exactly what it read before, with nothing said about what would be
     left. Buying is a purchase now, so the balance has to move — and the figure
     has to be on screen before it does. */
  console.log('\nbuying a goal moves real money:');
  const beforeBuy = await tab.evaluate(() => globalThis.__app.accountBalance('acc_t'));
  await tab.evaluate(() => [...document.querySelectorAll('main button')]
    .find((b) => b.textContent === 'Bought').click());
  await tab.waitForSelector('dialog input[name="price"]');
  check('the dialog says what would be left before anything is recorded',
    await tab.evaluate(() => {
      const total = document.querySelector('dialog .buy-note .assume-row.is-total');
      return !!total && /Left after buying it/.test(total.textContent);
    }), true);
  check('and opening it has moved nothing',
    await tab.evaluate(() => globalThis.__app.accountBalance('acc_t')), beforeBuy);
  check('the price is prefilled from the goal',
    await tab.evaluate(() => document.querySelector('dialog input[name="price"]').value), '1000.00');
  /* A purchase linked to no account moves no balance, so the figure above would
     be a promise the tab then breaks — the option is not offered here. */
  check('and "not linked" is not on offer for the account',
    await tab.evaluate(() => [...document.querySelectorAll('dialog select[name="accountId"] option')]
      .some((o) => o.value === '')), false);

  await tab.evaluate(() => {
    const form = document.querySelector('dialog form');
    form.querySelector('select[name="accountId"]').value = 'acc_t';
    form.requestSubmit();
  });
  await settle();
  check('recording it takes the price out of the account',
    await tab.evaluate(() => globalThis.__app.accountBalance('acc_t')), beforeBuy - 100000);
  const goalBuy = await tab.evaluate(() =>
    globalThis.__app.state().purchases.find((p) => p.goalId === 'gol_1'));
  check('as a purchase linked back to the goal',
    [goalBuy?.item, goalBuy?.amount, goalBuy?.accountId], ['First', 100000, 'acc_t']);
  check('and the goal leaves the queue', await goalOrder(), ['Second', 'Distraction']);

  /* The banner is gated on the projection's average, not on month 1 alone — a
     single lumpy month must not trigger it, but a real, sustained shortfall
     must. There is no recurring bill in this fixture yet, so the average
     starts at (or above) zero and the banner is absent; a large recurring one
     pushes every future month negative and it must appear, then disappear
     again once deactivated. */
  console.log('\nthe overspend banner (gated on the average, not one month):');
  check('no banner while the average surplus is not negative',
    await tab.evaluate(() => !!document.querySelector('.notice.danger')), false);
  await tab.evaluate(() => globalThis.__app.upsert('billTemplates', {
    id: 'bit_huge', name: 'Huge', category: 'Other', provider: '', frequency: 'Monthly',
    dueDay: 1, expected: 999999999, accountId: 'acc_t', method: '', active: true,
    anchor: '', generatedThrough: '', notes: ''
  }));
  await settle();
  check('a sustained shortfall shows the banner',
    await tab.evaluate(() => !!document.querySelector('.notice.danger')), true);
  // __app exposes upsert but not remove; deactivating is enough — occursIn()
  // skips a template with active: false, same as deleting it for this purpose.
  await tab.evaluate(() => globalThis.__app.upsert('billTemplates', { id: 'bit_huge', active: false }));
  await settle();
  check('and it clears once the shortfall is gone',
    await tab.evaluate(() => !!document.querySelector('.notice.danger')), false);

  /* The check above cannot catch a regression to month-1 gating: that fixture's
     Monthly bill drags month 1 and the average negative together. This one is
     built to tell them apart — a recurring income gives every month a positive
     surplus, then a `One-off` bill anchored on month 1 alone outweighs it, so
     month 1 goes negative while 59 unaffected months keep the average up. Only
     mean gating can be negative on the figure and silent on the banner at once. */
  console.log('\nmonth 1 negative but the average is not (mean gating only):');
  const anchors = await tab.evaluate(() => {
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return {
      current: `${now.getFullYear()}-${pad(now.getMonth() + 1)}`,
      next: `${next.getFullYear()}-${pad(next.getMonth() + 1)}`
    };
  });
  await tab.evaluate((anchor) => globalThis.__app.upsert('incomeTemplates', {
    id: 'itp_t', source: 'Salary', category: 'Salary', frequency: 'Monthly', payDay: 28,
    expected: 300000, accountId: 'acc_t', method: '', active: true, anchor,
    generatedThrough: '', notes: ''
  }), anchors.current);
  await tab.evaluate((anchor) => globalThis.__app.upsert('billTemplates', {
    id: 'bit_lump', name: 'Lump', category: 'Other', provider: '', frequency: 'One-off',
    dueDay: 1, expected: 400000, accountId: 'acc_t', method: '', active: true, anchor,
    generatedThrough: '', notes: ''
  }), anchors.next);
  await settle();
  check('the "Spare each month" figure renders negative', await tab.evaluate(() => {
    const fig = [...document.querySelectorAll('.figure')]
      .find((f) => f.textContent.includes('Spare each month'));
    return !!fig && fig.classList.contains('is-negative');
  }), true);
  check('while the sustained-average banner stays absent',
    await tab.evaluate(() => !!document.querySelector('.notice.danger')), false);
  await tab.evaluate(() => {
    globalThis.__app.upsert('incomeTemplates', { id: 'itp_t', active: false });
    globalThis.__app.upsert('billTemplates', { id: 'bit_lump', active: false });
  });
  await settle();

  /* ---------------- money you owe ---------------- */

  /* Driven through the real dialogs, because the arithmetic is already pinned
     in the domain suite and what is untested is the wiring: that the form
     writes an account and a movement together, and that the two figures the
     tab shows — what you hold and what you are worth — move apart by exactly
     what was borrowed and back together when it is paid off. */
  console.log('\nborrowing and paying back, through the tab:');
  // The Accounts tab's route id is `savings` — it predates the rename.
  await tab.evaluate(() => globalThis.__app.goTab('savings'));
  await tab.waitForSelector('.accounts');

  const heldBefore = await tab.evaluate(() => globalThis.__app.accountBalance('acc_t'));
  const txBefore = await tab.evaluate(() => globalThis.__app.state().savingsTx.length);
  const worth = () => tab.evaluate(() => globalThis.__app.state().accounts
    .reduce((total, a) => total + globalThis.__app.accountBalance(a.id), 0));
  const worthBefore = await worth();

  await tab.evaluate(() => [...document.querySelectorAll('main button')]
    .find((b) => b.textContent === 'Record a debt').click());
  await tab.waitForSelector('dialog input[name="name"]');
  check('the debt form will not let the money land nowhere',
    await tab.evaluate(() => [...document.querySelectorAll('dialog select[name="intoAccountId"] option')]
      .some((o) => o.value === '')), false);
  await tab.evaluate(() => {
    const form = document.querySelector('dialog form');
    form.querySelector('input[name="name"]').value = 'Brother-in-law';
    form.querySelector('input[name="amount"]').value = '3,000.00';
    form.querySelector('.dp-text').value = '05/07/2026';
    form.querySelector('.dp-text').dispatchEvent(new Event('blur'));
    form.querySelector('select[name="intoAccountId"]').value = 'acc_t';
    form.requestSubmit();
  });
  await settle();

  const debtAccount = await tab.evaluate(() =>
    globalThis.__app.state().accounts.find((a) => a.type === 'Loan / Debt'));
  check('one form writes both the debt and the movement',
    [debtAccount?.name, await tab.evaluate(() => globalThis.__app.state().savingsTx.length)],
    ['Brother-in-law', txBefore + 1]);
  check('the money is in the account it landed in',
    await tab.evaluate(() => globalThis.__app.accountBalance('acc_t')), heldBefore + 300000);
  check('and what you are worth has not moved', await worth(), worthBefore);
  check('the tab says what is owed', await tab.evaluate(() => {
    const fig = [...document.querySelectorAll('.figure')].find((f) => f.textContent.includes('Owed'));
    return !!fig && fig.classList.contains('is-negative');
  }), true);

  await tab.evaluate(() => [...document.querySelectorAll('.account.is-debt button')]
    .find((b) => b.textContent === 'Repay').click());
  await tab.waitForSelector('dialog input[name="amount"]');
  check('the repay dialog says what would still be owed',
    await tab.evaluate(() => {
      const total = document.querySelector('dialog .buy-note .assume-row.is-total');
      return !!total && /Still owed after/.test(total.textContent);
    }), true);
  await tab.evaluate(() => {
    const form = document.querySelector('dialog form');
    form.querySelector('input[name="amount"]').value = '3000';
    form.querySelector('select[name="fromAccountId"]').value = 'acc_t';
    form.requestSubmit();
  });
  await settle();
  check('paying it off returns every figure to where it started',
    [await tab.evaluate(() => globalThis.__app.accountBalance('acc_t')), await worth()],
    [heldBefore, worthBefore]);
  check('and the debt card reads as settled', await tab.evaluate(() =>
    !!document.querySelector('.account.is-debt .account-balance.is-settled')), true);

  /* ---------------- reconciling ---------------- */

  console.log('\nreconciling an account against the real one:');
  const tracked = await tab.evaluate(() => globalThis.__app.accountBalance('acc_t'));
  await tab.evaluate(() => [...document.querySelectorAll('.account:not(.is-debt) button')]
    .find((b) => b.textContent === 'Reconcile').click());
  await tab.waitForSelector('dialog input[name="actual"]');
  check('it opens on the figure it is correcting, so the difference starts at nothing',
    await tab.evaluate(() => {
      const total = document.querySelector('dialog .buy-note .assume-row.is-total');
      return !!total && /Difference/.test(total.textContent);
    }), true);
  check('and opening it has moved nothing',
    await tab.evaluate(() => globalThis.__app.accountBalance('acc_t')), tracked);

  const short = tracked - 12345;
  await tab.evaluate((value) => {
    const form = document.querySelector('dialog form');
    const box = form.querySelector('input[name="actual"]');
    box.value = value;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    form.requestSubmit();
  }, (short / 100).toFixed(2));
  await settle();
  check('the account now says exactly what it was told it really has',
    await tab.evaluate(() => globalThis.__app.accountBalance('acc_t')), short);
  const correction = await tab.evaluate(() => globalThis.__app.state().purchases
    .find((p) => p.category === 'Adjustment'));
  check('written as a purchase you can see, edit and delete',
    [correction?.amount, correction?.accountId], [12345, 'acc_t']);

  console.log('\ngoals survive the SQLite round-trip:');
  await open();
  const storedGoal = await tab.evaluate(() =>
    globalThis.__app.state().goals.find((g) => g.id === 'gol_1'));
  check('the goal is still there after a reload', storedGoal?.name, 'First');
  check('price and priority come back as numbers',
    [typeof storedGoal?.price, typeof storedGoal?.priority], ['number', 'number']);
  check('and their values are unchanged', [storedGoal?.price, storedGoal?.priority], [100000, 1]);

  /* A debt is an ordinary account row, so it has to survive the same round-trip
     as one typed into the account form — including the type string, which is
     what every debt rule keys off. */
  const storedDebt = await tab.evaluate(() =>
    globalThis.__app.state().accounts.find((a) => a.name === 'Brother-in-law'));
  check('a debt comes back out of SQLite as a debt',
    [storedDebt?.type, storedDebt?.opening, storedDebt?.target], ['Loan / Debt', 0, 0]);
  check('with both of its movements, and settled',
    await tab.evaluate((id) => [
      globalThis.__app.state().savingsTx
        .filter((t) => t.accountId === id || t.fromAccountId === id).length,
      globalThis.__app.accountBalance(id)
    ], storedDebt?.id), [2, 0]);

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
