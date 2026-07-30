/* gold.js — the one thing in this app that touches the network.
   Attaches globalThis.GoldPrice. Depends on Store.

   Gold is quoted worldwide in US dollars per troy ounce, so the Egyptian price
   per gram is that figure divided by 31.1034768 and multiplied by the pound
   rate. Two small public endpoints supply the two numbers; both send
   Access-Control-Allow-Origin: *, which is what makes this work from a file://
   page at all — verified against the live services, not assumed.

   Everything here is optional and failure is quiet. No reading is ever thrown
   away because a later fetch failed: the last good snapshot stays on screen
   with the date it was taken, and a price you type in yourself always wins. */
(function (root) {
  'use strict';

  var S = root.Store;

  var SPOT_URL = 'https://api.gold-api.com/price/XAU';
  /* Two rate services, tried in order. The second is the same provider's older
     endpoint, which is worth having when the first is rate-limited. */
  var RATE_URLS = [
    'https://open.er-api.com/v6/latest/USD',
    'https://api.exchangerate-api.com/v4/latest/USD'
  ];
  var TIMEOUT_MS = 9000;

  /* One automatic attempt per session. Without this, a machine that is offline
     re-tries on every render that asks whether a sync is due. */
  var attempted = false;
  var busy = false;
  var lastError = null;

  function fetchJSON(url) {
    if (typeof root.fetch !== 'function') return Promise.reject(new Error('This browser cannot fetch prices.'));
    var controller = typeof root.AbortController === 'function' ? new root.AbortController() : null;
    var timer = root.setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);
    return root.fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('The price service answered ' + res.status + '.');
      return res.json();
    }).then(function (json) {
      root.clearTimeout(timer);
      return json;
    }, function (err) {
      root.clearTimeout(timer);
      throw new Error(err && err.name === 'AbortError' ? 'The price service did not answer in time.' : 'Could not reach the price service.');
    });
  }

  function fetchSpot() {
    return fetchJSON(SPOT_URL).then(function (json) {
      var price = Number(json && json.price);
      if (!isFinite(price) || price <= 0) throw new Error('The gold price came back unreadable.');
      return price;
    });
  }

  /* Walks the rate services until one answers with a pound rate. */
  function fetchRate(index) {
    var i = index || 0;
    if (i >= RATE_URLS.length) return Promise.reject(new Error('Could not reach a currency service.'));
    return fetchJSON(RATE_URLS[i]).then(function (json) {
      var rate = Number(json && json.rates && json.rates.EGP);
      if (!isFinite(rate) || rate <= 0) throw new Error('no EGP rate');
      return rate;
    }).catch(function () { return fetchRate(i + 1); });
  }

  /* True when today has no reading yet. "Once a day is enough" is the whole
     specification, so anything newer than midnight counts as current. */
  function isDue() {
    if (S.state.settings.goldSync === false) return false;
    var latest = S.latestGoldPrice();
    return !latest || String(latest.date) < S.todayISO();
  }

  /* The manual and automatic paths differ in one way only: a manual refresh
     always goes out, an automatic one gives up for the session after a miss. */
  function refresh(options) {
    var opts = options || {};
    if (busy) return Promise.resolve({ ok: false, busy: true });
    if (!opts.manual) {
      if (attempted || !isDue()) return Promise.resolve({ ok: false, skipped: true });
      attempted = true;
    }
    busy = true;
    lastError = null;

    /* Both go out together, but a failure on one side must not discard the
       other: an unreachable currency service should still leave the gold price
       fresh, valued at yesterday's rate. */
    return Promise.all([
      fetchSpot().then(function (v) { return { ok: true, value: v }; },
        function (e) { return { ok: false, error: e }; }),
      fetchRate().then(function (v) { return { ok: true, value: v }; },
        function (e) { return { ok: false, error: e }; })
    ]).then(function (results) {
      busy = false;
      var spot = results[0];
      var rate = results[1];
      var previous = S.latestGoldPrice();

      var usdPerOz = spot.ok ? spot.value : (previous ? previous.usdPerOz : 0);
      var egpPerUsd = rate.ok ? rate.value : (previous ? previous.egpPerUsd : 0);

      if (!usdPerOz || !egpPerUsd) {
        lastError = (spot.ok ? rate.error : spot.error).message;
        return { ok: false, error: lastError };
      }

      var parts = [];
      if (spot.ok) parts.push('gold-api.com');
      if (rate.ok) parts.push('exchangerate-api.com');
      var record = S.recordGoldPrice({
        usdPerOz: usdPerOz,
        egpPerUsd: egpPerUsd,
        source: parts.length === 2 ? 'world spot × USD/EGP' : 'partial (' + parts.join(', ') + ')'
      });

      if (!spot.ok || !rate.ok) lastError = (spot.ok ? rate.error : spot.error).message;
      return { ok: true, partial: !spot.ok || !rate.ok, record: record, error: lastError };
    }).catch(function (err) {
      busy = false;
      lastError = err.message;
      return { ok: false, error: lastError };
    });
  }

  root.GoldPrice = {
    refresh: refresh,
    isDue: isDue,
    get busy() { return busy; },
    get lastError() { return lastError; }
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
