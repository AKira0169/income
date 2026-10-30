/* Browser test: drives the app in a real browser against the dev stack —
   https://localhost, with Kratos, the api and Postgres behind Caddy.

   This is the half Node cannot reach: the real forms, the DOM, the Blob path,
   the sign-in screens and the session cookie. It signs a fresh person up
   through the UI, runs the offline build's regression checks against the
   server, imports a backup and compares the figures with the domain's own
   arithmetic, and ends with email verification, recovery, two-factor sign-in
   and logging out.

   Run:  pnpm stack:dev && pnpm test:browser
   Set CHROME_PATH to pick a browser, APP_URL / MAILPIT_URL to aim elsewhere. */
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { importJSON } from '../src/domain/backup.ts';
import { formatMoney } from '../src/domain/money.ts';
import { accountBalance, summary } from '../src/domain/selectors.ts';
import { fixtureBackup } from './support/fixture.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const BASE = process.env.APP_URL ?? 'https://localhost';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const COMPOSE = ['compose', '--env-file', 'deploy/dev.env', '-f', 'deploy/compose.yaml'];
const email = `browser-${Date.now()}@example.test`;
const firstPassword = `First-${Date.now()}-correct-horse`;
const secondPassword = `Second-${Date.now()}-battery-staple`;

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

/** SQL straight into the dev database — only for the shared gold prices, which no user can write. */
const psql = (sql) => execFileSync('docker', [...COMPOSE, 'exec', '-T', 'postgres',
  'psql', '-U', 'postgres', '-d', 'app', '-v', 'ON_ERROR_STOP=1', '-c', sql], { cwd: root, stdio: 'pipe' });

/** Ids of every message Mailpit holds, so a new one can be told apart. */
const mailIds = async () => new Set(((await (await fetch(`${MAILPIT}/api/v1/messages`)).json()).messages ?? [])
  .map((m) => m.ID));

/** The six-digit code in the first new message to `to`. */
async function mailedCode(to, seen) {
  for (let i = 0; i < 60; i++) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()).messages ?? [];
    const hit = list.find((m) => !seen.has(m.ID) && m.To?.some((t) => t.Address === to));
    if (hit) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
      const code = /\b(\d{6})\b/.exec(full.Text ?? '')?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no code was mailed to ${to}`);
}

/** RFC 6238 TOTP, as an authenticator app computes it. */
function totp(secret, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/\s|=+$/g, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/** A code different from the last one used, waiting out the 30 s window if need be. */
async function freshTotp(secret, used) {
  while (totp(secret) === used) await new Promise((r) => setTimeout(r, 1000));
  return totp(secret);
}

const browser = await puppeteer.launch({ executablePath, headless: true, acceptInsecureCerts: true });

/** The page, for the failure report below. */
let current = null;

try {
  const tab = await browser.newPage();
  current = tab;
  const errors = [];
  tab.on('pageerror', (e) => errors.push(String(e)));
  /* Refusals are logged as they happen, so a step that times out says why: a
     429 is Caddy's rate limit, a 5xx the api or Kratos. Both are invisible in
     the api's own log when Caddy is the one answering. */
  tab.on('response', (r) => {
    if (r.status() === 429 || r.status() >= 500) console.log(`  ! ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  /* The sign-in protocol answers 401 (no session yet), 403 (second factor
     owed) and 422 (go elsewhere) as a matter of course, and Chrome logs every
     non-2xx response as a console error. Those are the protocol working, not
     the app failing; anything else still counts. */
  const EXPECTED_STATUS = /Failed to load resource: the server responded with a status of (401|403|422)/;
  tab.on('console', (m) => { if (m.type() === 'error' && !EXPECTED_STATUS.test(m.text())) errors.push(m.text()); });
  tab.on('dialog', (d) => void d.accept());

  /** Every write answered, then one more frame for the redraw. */
  const settle = () => tab.evaluate(() => globalThis.__app.idle().then(() => new Promise((r) => setTimeout(r, 150))));

  const open = async () => {
    await tab.goto(`${BASE}/`, { waitUntil: 'load' });
    await tab.waitForSelector('.topbar', { timeout: 30000 });
    await settle();
  };

  const clickButton = (text, scope = 'body') => tab.evaluate((t, s) =>
    [...document.querySelector(s).querySelectorAll('button')].find((b) => b.textContent === t).click(), text, scope);

  const logOut = async () => {
    await open();
    await clickButton('Log out', '.account-menu');
    await tab.waitForSelector('input[name="identifier"]', { timeout: 15000 });
  };

  const submitPassword = async (password) => {
    await tab.type('input[name="identifier"]', email);
    await tab.type('input[name="password"]', password);
    await tab.click('button[name="method"][value="password"]');
  };

  /* ---------------- signing up ---------------- */
  console.log('signing up through the real form:');
  await tab.goto(`${BASE}/registration`, { waitUntil: 'load' });
  await tab.waitForSelector('input[name="traits.email"]', { timeout: 30000 });
  await tab.type('input[name="traits.email"]', email);
  await tab.type('input[name="password"]', firstPassword);
  await tab.click('button[name="method"][value="password"]');
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  await settle();
  check('a new account lands in the app', new URL(tab.url()).pathname.startsWith('/dashboard/'), true);
  check('the topbar says who is signed in',
    await tab.evaluate((e) => document.querySelector('.account-menu').textContent.includes(e), email), true);
  check('and they are asked to verify their email',
    await tab.evaluate(() => !!document.querySelector('.notice.warn')), true);

  /* ---------------- boot ---------------- */
  console.log('\nboot:');
  check('the build stamp is on the page',
    await tab.evaluate(() => !!document.querySelector('.brand span')?.textContent), true);
  check('every tab renders',
    await tab.evaluate(() => document.querySelectorAll('.tab').length), 8);

  /* ---------------- path routing ---------------- */
  console.log('\npath routing (reload and back/forward):');
  const selectedTab = () => tab.evaluate(() =>
    [...document.querySelectorAll('.tab')].find((b) => b.getAttribute('aria-selected') === 'true')?.textContent);

  await tab.evaluate(() => globalThis.__app.goTab('gold'));
  await settle();
  check('the tab is in the address bar', /\/gold\/\d{4}-\d{2}$/.test(tab.url()), true);

  await tab.evaluate(() => [...document.querySelectorAll('.period-nav button')]
    .find((b) => b.getAttribute('aria-label') === 'Previous month').click());
  await settle();
  const stepped = tab.url();
  check('and so is the month', /\/gold\/\d{4}-\d{2}$/.test(stepped), true);

  await tab.reload({ waitUntil: 'load' });
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  check('a reload lands on the same tab', await selectedTab(), 'Gold');
  check('in the same month', tab.url(), stepped);

  await tab.goBack({ waitUntil: 'load' });
  await settle();
  check('back steps to the month before it', tab.url() !== stepped, true);
  await tab.goForward({ waitUntil: 'load' });
  await settle();
  check('and forward returns', tab.url(), stepped);

  await tab.goto(`${BASE}/bills/2026-07`, { waitUntil: 'load' });
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  check('a deep link opens on its own tab', await selectedTab(), 'Bills');

  // Start from a clean database, whatever a previous run left behind.
  await tab.evaluate(() => globalThis.__app.clearAll());
  await settle();

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
  await settle();

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
  console.log('\npersistence (server -> reload):');
  await tab.evaluate(() => { globalThis.__probe = 'survived'; });
  await open();
  check('open() really reloaded the page',
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
  await settle();

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
  await tab.evaluate(async () => {
    const a = globalThis.__app;
    await a.upsert('savingsTx', { id: 'sav_t', date: '2026-07-07', accountId: 'acc_t', fromAccountId: '', direction: 'in', amount: 50000, notes: '' });
    await a.upsert('gold', { id: 'gld_t', date: '2026-07-10', direction: 'buy', karat: 21, grams: 8, pricePerGram: 90000, amount: 720000, accountId: 'acc_t', dealer: 'Souq', notes: '' });
  });
  /* Gold prices are shared and written only by the server's daily job, so the
     two the sparkline needs go straight into the database. */
  psql(`INSERT INTO gold_prices (date, usd_per_oz, egp_per_usd, egp_per_gram24, source, fetched_at) VALUES
    ('2026-07-29', 3110.34768, 10, 100000, 'browser-test', ''),
    ('2026-07-30', 3200, 10, 102890, 'browser-test', '') ON CONFLICT (date) DO NOTHING`);
  await tab.evaluate(() => globalThis.__app.reload());

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

  /* ---------------- goals: ordering, the form, and SQLite ---------------- */
  console.log('\nthe Goals tab:');
  await tab.evaluate(async () => {
    const a = globalThis.__app;
    await a.upsert('goals', { id: 'gol_1', name: 'First', price: 100000, priority: 1, boughtDate: '', notes: '' });
    await a.upsert('goals', { id: 'gol_2', name: 'Second', price: 200000, priority: 2, boughtDate: '', notes: '' });
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
  await settle();
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
  await tab.evaluate(async () => {
    await globalThis.__app.upsert('incomeTemplates', { id: 'itp_t', active: false });
    await globalThis.__app.upsert('billTemplates', { id: 'bit_lump', active: false });
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

  console.log('\ngoals survive a reload from Postgres:');
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
  check('a debt comes back out of Postgres as a debt',
    [storedDebt?.type, storedDebt?.opening, storedDebt?.target], ['Loan / Debt', 0, 0]);
  check('with both of its movements, and settled',
    await tab.evaluate((id) => [
      globalThis.__app.state().savingsTx
        .filter((t) => t.accountId === id || t.fromAccountId === id).length,
      globalThis.__app.accountBalance(id)
    ], storedDebt?.id), [2, 0]);

  /* ---------------- importing an offline backup ---------------- */
  console.log('\nimporting a v1-offline backup shows the same figures:');
  const backupText = fixtureBackup();
  const expected = importJSON(backupText).state;
  const fixtureFile = join(root, '.tmp', 'fixture-backup.json');
  mkdirSync(dirname(fixtureFile), { recursive: true });
  writeFileSync(fixtureFile, backupText);
  await tab.evaluate(() => globalThis.__app.goTab('settings'));
  await settle();
  const restoreInput = await tab.$('input[type="file"]');
  await restoreInput.uploadFile(fixtureFile);
  await tab.waitForFunction((n) => globalThis.__app.state().income.length === n, { timeout: 15000 }, expected.income.length);
  await settle();
  const counts = (s) => [s.income, s.bills, s.purchases, s.accounts, s.goals, s.savingsTx, s.gold, s.incomeTemplates, s.billTemplates]
    .map((list) => list.length);
  check('every collection arrived whole', counts(await tab.evaluate(() => globalThis.__app.state())), counts(expected));
  for (const account of expected.accounts) {
    check(`${account.name} has the same balance`,
      await tab.evaluate((id) => globalThis.__app.accountBalance(id), account.id), accountBalance(expected, account.id));
  }
  for (const p of ['2026-05', '2026-06', '2026-07']) {
    await tab.evaluate((period) => { globalThis.__app.goTab('dashboard'); globalThis.__app.goPeriod(period); }, p);
    await settle();
    const shown = await tab.evaluate(() => Object.fromEntries([...document.querySelectorAll('.figure')]
      .map((f) => [f.querySelector('.label')?.textContent, f.querySelector('.figure-value')?.textContent])));
    const s = summary(expected, p);
    const money = (cents) => formatMoney(cents, expected.settings);
    check(`the dashboard for ${p} shows the same figures`,
      [shown['Income'], shown['Spent'], shown['Net'], shown['Saved']],
      [money(s.income), money(s.spent), money(s.net), money(s.savedNet)]);
  }

  /* ---------------- verifying the email address ---------------- */
  console.log('\nverifying the email address:');
  let seen = await mailIds();
  await tab.goto(`${BASE}/verification`, { waitUntil: 'load' });
  await tab.waitForSelector('input[name="email"]', { timeout: 15000 });
  await tab.type('input[name="email"]', email);
  await tab.click('button[name="method"][value="code"]');
  const verifyCode = await mailedCode(email, seen);
  await tab.waitForSelector('input[name="code"]', { timeout: 15000 });
  await tab.type('input[name="code"]', verifyCode);
  await tab.click('button[name="method"][value="code"]');
  await tab.waitForSelector('.auth-message.is-success', { timeout: 15000 });
  await open();
  check('the verify notice is gone', await tab.evaluate(() => !!document.querySelector('.notice.warn')), false);

  /* ---------------- recovering a forgotten password ---------------- */
  console.log('\nrecovering a forgotten password:');
  await logOut();
  check('logging out lands on sign-in', new URL(tab.url()).pathname, '/login');
  check('and the api no longer answers', await tab.evaluate(async () => (await fetch('/api/me')).status), 401);
  seen = await mailIds();
  await tab.goto(`${BASE}/recovery`, { waitUntil: 'load' });
  await tab.waitForSelector('input[name="email"]', { timeout: 15000 });
  await tab.type('input[name="email"]', email);
  await tab.click('button[name="method"][value="code"]');
  const recoveryCode = await mailedCode(email, seen);
  await tab.waitForSelector('input[name="code"]', { timeout: 15000 });
  await tab.type('input[name="code"]', recoveryCode);
  await tab.click('button[name="method"][value="code"]');
  await tab.waitForSelector('[data-node-id="password"] input', { timeout: 15000 });
  check('a correct code opens the security screen', new URL(tab.url()).pathname, '/settings/security');
  await tab.type('[data-node-id="password"] input', secondPassword);
  await tab.click('button[name="method"][value="password"]');
  await tab.waitForSelector('.auth-message.is-success', { timeout: 15000 });
  await logOut();
  await submitPassword(secondPassword);
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  check('the new password signs in', !!(await tab.$('.topbar')), true);

  /* ---------------- two-factor sign-in ---------------- */
  console.log('\ntwo-factor sign-in:');
  await tab.goto(`${BASE}/settings/security`, { waitUntil: 'load' });
  await tab.waitForSelector('[data-node-id="totp_secret_key"] code', { timeout: 15000 });
  check('a QR code is shown to scan', await tab.evaluate(() => !!document.querySelector('[data-node-id="totp_qr"] img')), true);
  const secret = await tab.$eval('[data-node-id="totp_secret_key"] code', (el) => el.textContent.trim());
  const enrolCode = totp(secret);
  await tab.type('input[name="totp_code"]', enrolCode);
  await tab.click('button[name="method"][value="totp"]');
  await tab.waitForSelector('button[name="totp_unlink"]', { timeout: 15000 });
  check('the authenticator is enrolled', !!(await tab.$('button[name="totp_unlink"]')), true);
  await logOut();
  await submitPassword(secondPassword);
  await tab.waitForSelector('input[name="totp_code"]', { timeout: 30000 });
  check('a password alone is no longer enough', new URL(tab.url()).pathname, '/login');
  await tab.type('input[name="totp_code"]', await freshTotp(secret, enrolCode));
  await tab.click('button[name="method"][value="totp"]');
  await tab.waitForSelector('.topbar', { timeout: 30000 });
  await settle();
  // Accounts, not income: signing in boots, and boot's catch-up has since
  // filled in the months after the fixture's July.
  check('the code lets them in, to their own data',
    (await tab.evaluate(() => globalThis.__app.state().accounts.map((a) => a.id))).sort(),
    expected.accounts.map((a) => a.id).sort());

  /* ---------------- leave nothing behind ---------------- */
  await tab.evaluate(() => globalThis.__app.clearAll());
  await settle();
  psql(`DELETE FROM gold_prices WHERE source = 'browser-test'`);

  console.log('\nconsole:');
  check('no uncaught errors or console errors', errors, []);
} catch (err) {
  /* A timed-out wait says only which selector never appeared. Where the page
     was, and what it was showing, is usually the answer. */
  if (current) {
    const text = await current.evaluate(() => document.body?.innerText ?? '').catch(() => '(page gone)');
    console.log(`\n  stopped at ${current.url()}\n  the page said: ${JSON.stringify(text.slice(0, 600))}`);
  }
  throw err;
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
