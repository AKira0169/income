/* datepicker.ts — a date field that behaves the same in every browser.

   The native <input type="date"> is not used anywhere in this app: its layout,
   its keyboard behaviour and its calendar are the browser's, they differ between
   Chrome and Edge, and the field order it imposes is not the one Egyptian dates
   are written in. This is a plain text input that accepts day/month/year the way
   people actually type it — 5/8, 5-8-26, 05082026, 2026-08-05, or just 5 for the
   fifth of the month on screen — with a calendar hanging off it for the times
   you would rather look than type.

   The value the rest of the app sees is always an ISO YYYY-MM-DD string, or ''
   for empty, held on a hidden input so that form reading stays unchanged. */

import { append as appendChild, clear, el, svg, svgPath } from './dom.ts';
import { state } from './store.ts';
import type { IsoDate } from './types.ts';

/* Saturday. The working week here runs Sunday to Thursday, so a calendar that
   starts on Monday puts the weekend in the middle of the row. */
const WEEK_START = 6;

const MS_DAY = 86400000;

/** Closes whichever calendar is on screen; only ever one at a time. */
let openCalendarClose: (() => void) | null = null;

/* ------------------------------------------------------------ date maths */

interface DateParts { y: number; m: number; d: number }

const pad2 = (n: number): string => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): IsoDate => `${y}-${pad2(m + 1)}-${pad2(d)}`;
const todayISO = (): IsoDate => {
  const d = new Date();
  return iso(d.getFullYear(), d.getMonth(), d.getDate());
};
const daysInMonth = (y: number, m: number): number => new Date(y, m + 1, 0).getDate();

function toParts(value: string | null | undefined): DateParts | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

function shiftDays(value: IsoDate, delta: number): IsoDate {
  const p = toParts(value);
  if (!p) return value;
  const d = new Date(new Date(p.y, p.m, p.d).getTime() + (delta * MS_DAY));
  return iso(d.getFullYear(), d.getMonth(), d.getDate());
}

/* Month arithmetic clamps rather than rolling over, so 31 January minus a month
   is 28 February and not the 3rd of March. */
function shiftMonths(value: IsoDate, delta: number): IsoDate {
  const p = toParts(value);
  if (!p) return value;
  let m = p.m + delta;
  const y = p.y + Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return iso(y, m, Math.min(p.d, daysInMonth(y, m)));
}

const locale = (): string => state.settings.locale || 'en-GB';

function monthTitle(y: number, m: number): string {
  try {
    return new Date(y, m, 1).toLocaleDateString(locale(), { month: 'long', year: 'numeric' });
  } catch {
    return `${m + 1}/${y}`;
  }
}

const FALLBACK_DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function weekdayLabels(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    // 7 Jan 2024 was a Sunday, so this walks a real week from the start day.
    const d = new Date(2024, 0, 7 + ((WEEK_START + i) % 7));
    let label: string;
    try { label = d.toLocaleDateString(locale(), { weekday: 'short' }); }
    catch { label = FALLBACK_DOW[d.getDay()]!; }
    out.push(label.slice(0, 2));
  }
  return out;
}

/* ---------------------------------------------------------- text <-> iso */

export function display(value: string | null | undefined): string {
  const p = toParts(value);
  return p ? `${pad2(p.d)}/${pad2(p.m + 1)}/${p.y}` : '';
}

function fourDigit(year: number): number {
  if (year >= 100) return year;
  // A two-digit year is this century unless that would be far in the future.
  const century = Math.floor(new Date().getFullYear() / 100) * 100;
  const full = century + year;
  return full - new Date().getFullYear() > 20 ? full - 100 : full;
}

/** Builds an ISO date, or null if that day does not exist. */
function make(y: number, m: number, d: number): IsoDate | null {
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m - 1)) return null;
  return iso(y, m - 1, d);
}

/** Reads whatever was typed. `context` is the month on screen, so a bare day
    number means that month — the common case when correcting one entry.
    Returns '' for empty and null for unreadable, which the caller must tell
    apart: one clears the field, the other must not. */
export function parse(text: string | null | undefined, context?: string): IsoDate | '' | null {
  const raw = String(text ?? '').trim();
  if (!raw) return '';

  const base = toParts(context) ?? toParts(todayISO())!;

  let m = /^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})$/.exec(raw);
  if (m) return make(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})$/.exec(raw);
  if (m) return make(fourDigit(Number(m[3])), Number(m[2]), Number(m[1]));

  m = /^(\d{1,2})[-/. ](\d{1,2})$/.exec(raw);
  if (m) return make(base.y, Number(m[2]), Number(m[1]));

  m = /^(\d{2})(\d{2})(\d{4})$/.exec(raw);        // 05082026
  if (m) return make(Number(m[3]), Number(m[2]), Number(m[1]));

  m = /^(\d{2})(\d{2})(\d{2})$/.exec(raw);        // 050826
  if (m) return make(fourDigit(Number(m[3])), Number(m[2]), Number(m[1]));

  m = /^(\d{1,2})$/.exec(raw);                    // just a day
  if (m) return make(base.y, base.m + 1, Number(m[1]));

  return null;                                    // unreadable
}

export function close(): void { openCalendarClose?.(); }

/* --------------------------------------------------------------- element */

function calendarIcon(): SVGSVGElement {
  return svg({ viewBox: '0 0 16 16', width: '15', height: '15', 'aria-hidden': 'true' }, [
    svgPath({
      d: 'M4.5 1v2M11.5 1v2M1.5 5.5h13M2.5 3h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.2',
      'stroke-linecap': 'round'
    })
  ]);
}

export interface DatePickerOptions {
  value?: string;
  name?: string;
  id?: string;
  label?: string;
  /** A required field offers no Clear button. */
  required?: boolean;
  onChange?: (value: IsoDate | '') => void;
}

export interface DatePickerField {
  /** Goes in the form. */
  node: HTMLDivElement;
  /** The hidden input carrying the ISO string, so form reading is unchanged. */
  value: HTMLInputElement;
  input: HTMLInputElement;
  focus(): void;
  set(value: IsoDate | ''): void;
}

export function create(options: DatePickerOptions = {}): DatePickerField {
  let current: IsoDate | '' = toParts(options.value) ? options.value! : '';

  const hidden = el('input', { type: 'hidden', name: options.name ?? '' });
  hidden.value = current;

  const text = el('input', {
    type: 'text', class: 'dp-text', autocomplete: 'off', spellcheck: 'false',
    inputmode: 'numeric', placeholder: 'dd/mm/yyyy',
    'aria-label': options.label ?? 'Date',
    title: 'Type 5/8, 5-8-26 or 2026-08-05 — or pick from the calendar'
  });
  text.value = display(current);
  if (options.id) text.setAttribute('id', options.id);

  const button = el('button', {
    type: 'button', class: 'dp-button', 'aria-label': 'Open calendar',
    'aria-haspopup': 'dialog', 'aria-expanded': 'false'
  }, calendarIcon());

  const node = el('div', { class: 'dp' }, [text, button, hidden]);

  function set(value: IsoDate | '', notify = true): void {
    current = value || '';
    hidden.value = current;
    text.value = display(current);
    if (notify) options.onChange?.(current);
  }

  /* What the typed text means, committed when focus leaves or Enter is pressed.
     Unreadable text is put back to the last good value rather than silently
     saved as nothing. */
  function commitTyped(): boolean {
    const parsed = parse(text.value, current || todayISO());
    if (parsed === null) { text.value = display(current); return false; }
    set(parsed);
    return true;
  }

  text.addEventListener('blur', () => {
    // Leaving for the calendar button is not leaving the field.
    if (openCalendarClose && node.contains(document.activeElement)) return;
    commitTyped();
  });

  text.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTyped();
      close();
    } else if (e.key === 'ArrowDown' && !openCalendarClose) {
      e.preventDefault();
      openCalendar();
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !openCalendarClose) {
      // Nudging the date without opening anything: the fastest correction.
      e.preventDefault();
      set(shiftDays(current || todayISO(), e.key === 'ArrowUp' ? 1 : -1));
    } else if (e.key === 'Escape' && openCalendarClose) {
      close();
    }
  });

  button.addEventListener('click', () => {
    if (openCalendarClose) { close(); return; }
    commitTyped();
    openCalendar();
  });

  /* ------------------------------------------------------------- calendar */

  function openCalendar(): void {
    close();

    let cursor: IsoDate = current || todayISO();
    const showing = toParts(cursor)!;
    let year = showing.y;
    let month = showing.m;
    let mode: 'days' | 'months' = 'days';

    const pop = el('div', {
      class: 'dp-pop', role: 'dialog', 'aria-label': 'Choose a date', 'aria-modal': 'false'
    });

    /* A modal <dialog> paints in the top layer, above anything appended to the
       body, and .dialog-body clips to its own scroll box — so the panel is
       fixed-positioned inside the nearest dialog when there is one. */
    const host = text.closest('dialog') ?? document.body;
    host.appendChild(pop);
    button.setAttribute('aria-expanded', 'true');

    function place(): void {
      const r = text.getBoundingClientRect();
      pop.style.visibility = 'hidden';
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      let top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) {
        const above = r.top - 6 - h;
        top = above >= 8 ? above : Math.max(8, window.innerHeight - h - 8);
      }
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
      pop.style.visibility = '';
    }

    function choose(value: IsoDate | ''): void {
      set(value);
      closeCalendar();
      text.focus();
    }

    function focusCursor(): void {
      pop.querySelector<HTMLElement>('.dp-day.is-cursor')?.focus();
    }

    function moveTo(value: IsoDate): void {
      cursor = value;
      const p = toParts(cursor)!;
      year = p.y;
      month = p.m;
      draw();
      focusCursor();
    }

    function drawDays(): HTMLDivElement {
      const first = new Date(year, month, 1).getDay();
      const lead = (first - WEEK_START + 7) % 7;
      const total = daysInMonth(year, month);
      const today = todayISO();

      const cells: HTMLElement[] = weekdayLabels().map((label) =>
        el('div', { class: 'dp-dow', text: label, 'aria-hidden': 'true' }));

      for (let i = 0; i < lead; i++) cells.push(el('div', { class: 'dp-pad' }));

      for (let day = 1; day <= total; day++) {
        const value = iso(year, month, day);
        const classes = ['dp-day'];
        if (value === current) classes.push('is-selected');
        if (value === cursor) classes.push('is-cursor');
        if (value === today) classes.push('is-today');
        cells.push(el('button', {
          type: 'button',
          class: classes.join(' '),
          tabindex: value === cursor ? '0' : '-1',
          'aria-selected': value === current ? 'true' : 'false',
          text: String(day),
          onclick: () => choose(value)
        }));
      }

      return el('div', { class: 'dp-grid' }, cells);
    }

    function drawMonths(): HTMLDivElement {
      const cells: HTMLElement[] = [];
      for (let index = 0; index < 12; index++) {
        let label: string;
        try { label = new Date(year, index, 1).toLocaleDateString(locale(), { month: 'short' }); }
        catch { label = String(index + 1); }
        cells.push(el('button', {
          type: 'button',
          class: `dp-month${index === month ? ' is-selected' : ''}`,
          text: label,
          onclick: () => {
            month = index;
            mode = 'days';
            cursor = iso(year, month, Math.min(toParts(cursor)!.d, daysInMonth(year, month)));
            draw();
            focusCursor();
          }
        }));
      }
      return el('div', { class: 'dp-months' }, cells);
    }

    function draw(): void {
      clear(pop);
      const step = mode === 'days' ? 'month' : 'year';

      appendChild(pop, el('div', { class: 'dp-head' }, [
        el('button', {
          type: 'button', class: 'dp-nav', 'aria-label': `Previous ${step}`, text: '‹',
          onclick: () => stepBy(-1)
        }),
        el('button', {
          type: 'button', class: 'dp-title',
          'aria-label': 'Switch between months and days',
          text: mode === 'days' ? monthTitle(year, month) : String(year),
          onclick: () => { mode = mode === 'days' ? 'months' : 'days'; draw(); }
        }),
        el('button', {
          type: 'button', class: 'dp-nav', 'aria-label': `Next ${step}`, text: '›',
          onclick: () => stepBy(1)
        })
      ]));

      appendChild(pop, mode === 'days' ? drawDays() : drawMonths());

      appendChild(pop, el('div', { class: 'dp-foot' }, [
        el('button', { type: 'button', class: 'dp-quick', text: 'Today', onclick: () => choose(todayISO()) }),
        el('div', { class: 'dp-hint', text: 'Arrows move · Enter picks' }),
        options.required ? null : el('button', {
          type: 'button', class: 'dp-quick', text: 'Clear', onclick: () => choose('')
        })
      ]));

      place();
    }

    function stepBy(delta: number): void {
      if (mode === 'days') {
        cursor = shiftMonths(cursor, delta);
        const p = toParts(cursor)!;
        year = p.y;
        month = p.m;
      } else {
        year += delta;
      }
      draw();
    }

    /** Offset from the cursor to the start of its week. */
    function weekOffset(): number {
      const p = toParts(cursor)!;
      return (new Date(p.y, p.m, p.d).getDay() - WEEK_START + 7) % 7;
    }

    /* Grid keyboard model, the same one every desktop calendar uses. */
    pop.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeCalendar(); text.focus(); return; }
      if (mode !== 'days') return;

      let delta: number;
      switch (e.key) {
        case 'ArrowLeft': delta = -1; break;
        case 'ArrowRight': delta = 1; break;
        case 'ArrowUp': delta = -7; break;
        case 'ArrowDown': delta = 7; break;
        case 'Home': delta = -weekOffset(); break;
        case 'End': delta = 6 - weekOffset(); break;
        case 'PageUp':
          e.preventDefault();
          moveTo(shiftMonths(cursor, e.shiftKey ? -12 : -1));
          return;
        case 'PageDown':
          e.preventDefault();
          moveTo(shiftMonths(cursor, e.shiftKey ? 12 : 1));
          return;
        default: return;
      }
      e.preventDefault();
      moveTo(shiftDays(cursor, delta));
    });

    function onOutside(e: PointerEvent): void {
      const target = e.target as Node | null;
      if (!target || pop.contains(target) || node.contains(target)) return;
      closeCalendar();
    }
    function reposition(): void { if (pop.isConnected) place(); }

    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    function closeCalendar(): void {
      document.removeEventListener('pointerdown', onOutside, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      pop.remove();
      button.setAttribute('aria-expanded', 'false');
      if (openCalendarClose === closeCalendar) openCalendarClose = null;
    }

    openCalendarClose = closeCalendar;
    draw();
    const focusFirst = pop.querySelector<HTMLElement>('.dp-day.is-cursor')
      ?? pop.querySelector<HTMLElement>('.dp-title');
    focusFirst?.focus();
  }

  return {
    node,
    value: hidden,
    input: text,
    focus: () => { text.focus(); text.select(); },
    set: (v) => set(v, false)
  };
}
