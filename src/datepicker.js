/* datepicker.js — a date field that behaves the same in every browser.
   Attaches globalThis.DatePicker. Depends on Store for the locale only.

   The native <input type="date"> is not used anywhere in this app: its layout,
   its keyboard behaviour and its calendar are the browser's, they differ
   between Chrome and Edge, and the field order it imposes is not the one
   Egyptian dates are written in. This is a plain text input that accepts
   day/month/year the way people actually type it — 5/8, 5-8-26, 05082026,
   2026-08-05, or just 5 for the fifth of the month on screen — with a calendar
   hanging off it for the times you would rather look than type.

   The value the rest of the app sees is always an ISO YYYY-MM-DD string, or ''
   for empty, held on a hidden input so that form reading stays unchanged. */
(function (root) {
  'use strict';

  var doc = root.document;

  /* Saturday. The working week here runs Sunday to Thursday, so a calendar
     that starts on Monday puts the weekend in the middle of the row. */
  var WEEK_START = 6;

  var MS_DAY = 86400000;
  var open = null;   // only ever one calendar on screen

  /* ------------------------------------------------------------ date maths */

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function iso(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function todayISO() { var d = new Date(); return iso(d.getFullYear(), d.getMonth(), d.getDate()); }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

  function toParts(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!m) return null;
    var y = +m[1], mo = +m[2] - 1, d = +m[3];
    if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo)) return null;
    return { y: y, m: mo, d: d };
  }

  function shiftDays(value, delta) {
    var p = toParts(value);
    if (!p) return value;
    var t = new Date(p.y, p.m, p.d).getTime() + (delta * MS_DAY);
    var d = new Date(t);
    return iso(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /* Month arithmetic clamps rather than rolling over, so 31 January minus a
     month is 28 February and not the 3rd of March. */
  function shiftMonths(value, delta) {
    var p = toParts(value);
    if (!p) return value;
    var y = p.y, m = p.m + delta;
    y += Math.floor(m / 12);
    m = ((m % 12) + 12) % 12;
    return iso(y, m, Math.min(p.d, daysInMonth(y, m)));
  }

  function locale() {
    return (root.Store && root.Store.state.settings.locale) || 'en-GB';
  }

  function monthTitle(y, m) {
    try {
      return new Date(y, m, 1).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
    } catch (e) {
      return (m + 1) + '/' + y;
    }
  }

  function weekdayLabels() {
    var out = [];
    for (var i = 0; i < 7; i++) {
      // 7 Jan 2024 was a Sunday, so this walks a real week from the start day.
      var d = new Date(2024, 0, 7 + ((WEEK_START + i) % 7));
      var label;
      try { label = d.toLocaleDateString(locale(), { weekday: 'short' }); }
      catch (e) { label = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d.getDay()]; }
      out.push(label.slice(0, 2));
    }
    return out;
  }

  /* ------------------------------------------------------------ text <-> iso */

  function display(value) {
    var p = toParts(value);
    return p ? pad2(p.d) + '/' + pad2(p.m + 1) + '/' + p.y : '';
  }

  function fourDigit(year) {
    if (year >= 100) return year;
    // A two-digit year is this century unless that would be far in the future.
    var century = Math.floor(new Date().getFullYear() / 100) * 100;
    var full = century + year;
    return full - new Date().getFullYear() > 20 ? full - 100 : full;
  }

  function make(y, m, d) {
    if (m < 1 || m > 12) return null;
    if (d < 1 || d > daysInMonth(y, m - 1)) return null;
    return iso(y, m - 1, d);
  }

  /* Reads whatever was typed. `context` is the month on screen, so a bare day
     number means that month — the common case when correcting one entry. */
  function parseTyped(text, context) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) return '';

    var base = toParts(context) || toParts(todayISO());
    var m;

    m = /^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/.exec(raw);
    if (m) return make(+m[1], +m[2], +m[3]);

    m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/.exec(raw);
    if (m) return make(fourDigit(+m[3]), +m[2], +m[1]);

    m = /^(\d{1,2})[-/. ](\d{1,2})$/.exec(raw);
    if (m) return make(base.y, +m[2], +m[1]);

    m = /^(\d{2})(\d{2})(\d{4})$/.exec(raw);        // 05082026
    if (m) return make(+m[3], +m[2], +m[1]);

    m = /^(\d{2})(\d{2})(\d{2})$/.exec(raw);        // 050826
    if (m) return make(fourDigit(+m[3]), +m[2], +m[1]);

    m = /^(\d{1,2})$/.exec(raw);                    // just a day
    if (m) return make(base.y, base.m + 1, +m[1]);

    return null;                                    // unreadable
  }

  /* ---------------------------------------------------------------- element */

  function el(tag, props, children) {
    var node = doc.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      if (value === null || value === undefined || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    });
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(c.nodeType ? c : doc.createTextNode(String(c)));
    });
    return node;
  }

  function closeOpen() { if (open) open(); }

  /* ----------------------------------------------------------------- create */

  /* Returns { node, value, focus } — `node` goes in the form, `value` is the
     hidden input carrying the ISO string. */
  function create(options) {
    var opts = options || {};
    var current = toParts(opts.value) ? opts.value : '';

    var hidden = el('input', { type: 'hidden', name: opts.name || '' });
    hidden.value = current;

    var text = el('input', {
      type: 'text', class: 'dp-text', autocomplete: 'off', spellcheck: 'false',
      inputmode: 'numeric', placeholder: 'dd/mm/yyyy',
      'aria-label': opts.label || 'Date',
      title: 'Type 5/8, 5-8-26 or 2026-08-05 — or pick from the calendar'
    });
    text.value = display(current);
    if (opts.id) text.setAttribute('id', opts.id);

    var button = el('button', {
      type: 'button', class: 'dp-button', 'aria-label': 'Open calendar', 'aria-haspopup': 'dialog',
      'aria-expanded': 'false'
    }, [icon()]);

    var node = el('div', { class: 'dp' }, [text, button, hidden]);

    function icon() {
      var svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('width', '15'); svg.setAttribute('height', '15');
      svg.setAttribute('aria-hidden', 'true');
      var path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M4.5 1v2M11.5 1v2M1.5 5.5h13M2.5 3h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '1.2');
      path.setAttribute('stroke-linecap', 'round');
      svg.appendChild(path);
      return svg;
    }

    function set(value, notify) {
      current = value || '';
      hidden.value = current;
      text.value = display(current);
      if (notify !== false && opts.onChange) opts.onChange(current);
    }

    /* What the typed text means, committed when focus leaves or Enter is
       pressed. Unreadable text is put back to the last good value rather than
       silently saved as nothing. */
    function commitTyped() {
      var parsed = parseTyped(text.value, current || todayISO());
      if (parsed === null) { text.value = display(current); return false; }
      set(parsed);
      return true;
    }

    text.addEventListener('blur', function () {
      // Leaving for the calendar button is not leaving the field.
      if (open && node.contains(doc.activeElement)) return;
      commitTyped();
    });
    text.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitTyped(); closeOpen(); }
      else if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openCalendar(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Nudging the date without opening anything: the fastest correction.
        if (!open) {
          e.preventDefault();
          var from = current || todayISO();
          set(shiftDays(from, e.key === 'ArrowUp' ? 1 : -1));
        }
      } else if (e.key === 'Escape' && open) { closeOpen(); }
    });

    button.addEventListener('click', function () {
      if (open) { closeOpen(); return; }
      commitTyped();
      openCalendar();
    });

    /* ------------------------------------------------------------- calendar */

    function openCalendar() {
      closeOpen();

      var cursor = current || todayISO();
      var showing = toParts(cursor);
      var year = showing.y, month = showing.m;
      var mode = 'days';

      var pop = el('div', {
        class: 'dp-pop', role: 'dialog', 'aria-label': 'Choose a date', 'aria-modal': 'false'
      });

      /* A modal <dialog> paints in the top layer, above anything appended to
         the body, and .dialog-body clips to its own scroll box — so the panel
         is fixed-positioned inside the nearest dialog when there is one. */
      var host = text.closest ? (text.closest('dialog') || doc.body) : doc.body;
      host.appendChild(pop);
      button.setAttribute('aria-expanded', 'true');

      function place() {
        var r = text.getBoundingClientRect();
        pop.style.visibility = 'hidden';
        var w = pop.offsetWidth, h = pop.offsetHeight;
        var left = Math.max(8, Math.min(r.left, root.innerWidth - w - 8));
        var top = r.bottom + 6;
        if (top + h > root.innerHeight - 8) {
          var above = r.top - 6 - h;
          top = above >= 8 ? above : Math.max(8, root.innerHeight - h - 8);
        }
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
        pop.style.visibility = '';
      }

      function choose(value) {
        set(value);
        close();
        text.focus();
      }

      function moveTo(value, redraw) {
        cursor = value;
        var p = toParts(cursor);
        if (p.y !== year || p.m !== month || redraw) { year = p.y; month = p.m; }
        draw();
        var active = pop.querySelector('.dp-day.is-cursor');
        if (active) active.focus();
      }

      function drawDays() {
        var first = new Date(year, month, 1).getDay();
        var lead = (first - WEEK_START + 7) % 7;
        var total = daysInMonth(year, month);
        var today = todayISO();

        var cells = weekdayLabels().map(function (label) {
          return el('div', { class: 'dp-dow', text: label, 'aria-hidden': 'true' });
        });

        for (var i = 0; i < lead; i++) cells.push(el('div', { class: 'dp-pad' }));
        for (var day = 1; day <= total; day++) {
          (function (d) {
            var value = iso(year, month, d);
            cells.push(el('button', {
              type: 'button',
              class: 'dp-day'
                + (value === current ? ' is-selected' : '')
                + (value === cursor ? ' is-cursor' : '')
                + (value === today ? ' is-today' : ''),
              tabindex: value === cursor ? '0' : '-1',
              'aria-selected': value === current ? 'true' : 'false',
              text: String(d),
              onclick: function () { choose(value); }
            }));
          }(day));
        }

        return el('div', { class: 'dp-grid' }, cells);
      }

      function drawMonths() {
        var cells = [];
        for (var m = 0; m < 12; m++) {
          (function (index) {
            var label;
            try { label = new Date(year, index, 1).toLocaleDateString(locale(), { month: 'short' }); }
            catch (e) { label = String(index + 1); }
            cells.push(el('button', {
              type: 'button',
              class: 'dp-month' + (index === month ? ' is-selected' : ''),
              text: label,
              onclick: function () {
                month = index;
                mode = 'days';
                cursor = iso(year, month, Math.min(toParts(cursor).d, daysInMonth(year, month)));
                draw();
                var active = pop.querySelector('.dp-day.is-cursor');
                if (active) active.focus();
              }
            }));
          }(m));
        }
        return el('div', { class: 'dp-months' }, cells);
      }

      function draw() {
        while (pop.firstChild) pop.removeChild(pop.firstChild);

        var step = mode === 'days' ? 'month' : 'year';
        append(el('div', { class: 'dp-head' }, [
          el('button', {
            type: 'button', class: 'dp-nav', 'aria-label': 'Previous ' + step, text: '‹',
            onclick: function () { stepBy(-1); }
          }),
          el('button', {
            type: 'button', class: 'dp-title',
            'aria-label': 'Switch between months and days',
            text: mode === 'days' ? monthTitle(year, month) : String(year),
            onclick: function () { mode = mode === 'days' ? 'months' : 'days'; draw(); }
          }),
          el('button', {
            type: 'button', class: 'dp-nav', 'aria-label': 'Next ' + step, text: '›',
            onclick: function () { stepBy(1); }
          })
        ]));

        append(mode === 'days' ? drawDays() : drawMonths());

        append(el('div', { class: 'dp-foot' }, [
          el('button', { type: 'button', class: 'dp-quick', text: 'Today', onclick: function () { choose(todayISO()); } }),
          el('div', { class: 'dp-hint', text: 'Arrows move · Enter picks' }),
          opts.required ? null : el('button', {
            type: 'button', class: 'dp-quick', text: 'Clear', onclick: function () { choose(''); }
          })
        ]));

        place();
      }

      function append(child) { if (child) pop.appendChild(child); }

      function stepBy(delta) {
        if (mode === 'days') {
          cursor = shiftMonths(cursor, delta);
          var p = toParts(cursor);
          year = p.y; month = p.m;
        } else {
          year += delta;
        }
        draw();
      }

      /* Grid keyboard model, the same one every desktop calendar uses. */
      pop.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); text.focus(); return; }
        if (mode !== 'days') return;
        var delta = 0;
        if (e.key === 'ArrowLeft') delta = -1;
        else if (e.key === 'ArrowRight') delta = 1;
        else if (e.key === 'ArrowUp') delta = -7;
        else if (e.key === 'ArrowDown') delta = 7;
        else if (e.key === 'Home') delta = -((new Date(toParts(cursor).y, toParts(cursor).m, toParts(cursor).d).getDay() - WEEK_START + 7) % 7);
        else if (e.key === 'End') delta = 6 - ((new Date(toParts(cursor).y, toParts(cursor).m, toParts(cursor).d).getDay() - WEEK_START + 7) % 7);
        else if (e.key === 'PageUp') { e.preventDefault(); moveTo(shiftMonths(cursor, e.shiftKey ? -12 : -1)); return; }
        else if (e.key === 'PageDown') { e.preventDefault(); moveTo(shiftMonths(cursor, e.shiftKey ? 12 : 1)); return; }
        else return;
        e.preventDefault();
        moveTo(shiftDays(cursor, delta));
      });

      function onOutside(e) {
        if (pop.contains(e.target) || node.contains(e.target)) return;
        close();
      }
      function reposition() { if (pop.isConnected) place(); }

      doc.addEventListener('pointerdown', onOutside, true);
      root.addEventListener('resize', reposition);
      root.addEventListener('scroll', reposition, true);

      function close() {
        doc.removeEventListener('pointerdown', onOutside, true);
        root.removeEventListener('resize', reposition);
        root.removeEventListener('scroll', reposition, true);
        if (pop.parentNode) pop.parentNode.removeChild(pop);
        button.setAttribute('aria-expanded', 'false');
        if (open === close) open = null;
      }

      open = close;
      draw();
      var focusFirst = pop.querySelector('.dp-day.is-cursor') || pop.querySelector('.dp-title');
      if (focusFirst) focusFirst.focus();
    }

    return {
      node: node,
      value: hidden,
      input: text,
      focus: function () { text.focus(); text.select(); },
      set: function (v) { set(v, false); }
    };
  }

  root.DatePicker = {
    create: create,
    parse: parseTyped,
    display: display,
    close: closeOpen
  };
}(typeof globalThis !== 'undefined' ? globalThis : this));
