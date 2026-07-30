/* ui/components/DatePicker.tsx — a date field that behaves the same in every
   browser.

   The native <input type="date"> is not used anywhere in this app: its layout,
   its keyboard behaviour and its calendar are the browser's, they differ
   between Chrome and Edge, and the field order it imposes is not the one
   Egyptian dates are written in. This is a plain text input that takes the date
   the way people write it — 5/8, 5-8-26, 05082026, 2026-08-05, or just 5 for
   the fifth of the month on screen — with a calendar hanging off it.

   What text means which date is domain/date-parse.ts. This is the widget.

   Two things here are deliberately imperative:

   The committed value is written straight onto the hidden input rather than
   rendered from state. Preact defers a state update to a microtask, and a form
   can be filled in and submitted inside one — the browser suite does exactly
   that — so a rendered value would still be the old one when the form is read.

   The popup is an ordinary child, not a portal. `.dp-pop` is position:fixed and
   nothing above it establishes a containing block, so it is not clipped by
   .dialog-body's scroll box; and being inside the <dialog> is what puts it in
   the same top layer rather than behind the backdrop. That is the whole reason
   the old code appended it to the dialog by hand. */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  daysInMonth, display, iso, parse, shiftDays, shiftMonths, toParts
} from '../../domain/date-parse.ts';
import { todayISO } from '../../domain/period.ts';
import type { IsoDate } from '../../domain/types.ts';

/* Saturday. The working week here runs Sunday to Thursday, so a calendar that
   starts on Monday puts the weekend in the middle of the row. */
const WEEK_START = 6;

const FALLBACK_DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function weekdayLabels(locale: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    // 7 Jan 2024 was a Sunday, so this walks a real week from the start day.
    const d = new Date(2024, 0, 7 + ((WEEK_START + i) % 7));
    let label: string;
    try { label = d.toLocaleDateString(locale, { weekday: 'short' }); }
    catch { label = FALLBACK_DOW[d.getDay()]!; }
    out.push(label.slice(0, 2));
  }
  return out;
}

function monthTitle(y: number, m: number, locale: string): string {
  try {
    return new Date(y, m, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  } catch {
    return `${m + 1}/${y}`;
  }
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M4.5 1v2M11.5 1v2M1.5 5.5h13M2.5 3h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
        fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"
      />
    </svg>
  );
}

interface CalendarProps {
  value: IsoDate | '';
  locale: string;
  required?: boolean;
  anchor: HTMLInputElement | null;
  onPick: (value: IsoDate | '') => void;
  onClose: () => void;
}

function Calendar({ value, locale, required, anchor, onPick, onClose }: CalendarProps) {
  const start = toParts(value) ?? toParts(todayISO())!;
  const [cursor, setCursor] = useState<IsoDate>(value || todayISO());
  const [mode, setMode] = useState<'days' | 'months'>('days');
  const [year, setYear] = useState(start.y);
  const [month, setMonth] = useState(start.m);
  const pop = useRef<HTMLDivElement>(null);

  /* Kept level with the field through scrolling and resizing, and flipped above
     it when there is no room below. */
  useLayoutEffect(() => {
    const place = (): void => {
      const node = pop.current;
      if (!node || !anchor) return;
      const r = anchor.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left, window.innerWidth - node.offsetWidth - 8));
      let top = r.bottom + 6;
      if (top + node.offsetHeight > window.innerHeight - 8) {
        const above = r.top - 6 - node.offsetHeight;
        top = above >= 8 ? above : Math.max(8, window.innerHeight - node.offsetHeight - 8);
      }
      node.style.left = `${Math.round(left)}px`;
      node.style.top = `${Math.round(top)}px`;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  });

  useEffect(() => {
    const onOutside = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (!target || pop.current?.contains(target) || anchor?.closest('.dp')?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', onOutside, true);
    return () => document.removeEventListener('pointerdown', onOutside, true);
  }, [anchor, onClose]);

  /* Focus follows the cursor day, which is what makes the arrow keys read as
     moving around a grid rather than as changing an invisible variable. */
  useLayoutEffect(() => {
    const focusTarget = pop.current?.querySelector<HTMLElement>('.dp-day.is-cursor')
      ?? pop.current?.querySelector<HTMLElement>('.dp-title');
    focusTarget?.focus();
  }, [cursor, mode]);

  const moveTo = (next: IsoDate): void => {
    const p = toParts(next);
    if (!p) return;
    setCursor(next);
    setYear(p.y);
    setMonth(p.m);
  };

  const stepBy = (delta: number): void => {
    if (mode === 'days') { moveTo(shiftMonths(cursor, delta)); return; }
    setYear(year + delta);
  };

  /** Offset from the cursor to the start of its week. */
  const weekOffset = (): number => {
    const p = toParts(cursor)!;
    return (new Date(p.y, p.m, p.d).getDay() - WEEK_START + 7) % 7;
  };

  /* The grid keyboard model every desktop calendar uses. */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
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
  };

  const days = (): preact.JSX.Element => {
    const first = new Date(year, month, 1).getDay();
    const lead = (first - WEEK_START + 7) % 7;
    const total = daysInMonth(year, month);
    const today = todayISO();

    return (
      <div class="dp-grid">
        {weekdayLabels(locale).map((l, i) => (
          <div class="dp-dow" aria-hidden="true" key={`dow${i}`}>{l}</div>
        ))}
        {Array.from({ length: lead }, (_, i) => <div class="dp-pad" key={`pad${i}`} />)}
        {Array.from({ length: total }, (_, i) => {
          const day = i + 1;
          const on = iso(year, month, day);
          const classes = ['dp-day'];
          if (on === value) classes.push('is-selected');
          if (on === cursor) classes.push('is-cursor');
          if (on === today) classes.push('is-today');
          return (
            <button
              key={on} type="button" class={classes.join(' ')}
              tabIndex={on === cursor ? 0 : -1}
              aria-selected={on === value ? 'true' : 'false'}
              onClick={() => onPick(on)}
            >{day}</button>
          );
        })}
      </div>
    );
  };

  const months = (): preact.JSX.Element => (
    <div class="dp-months">
      {Array.from({ length: 12 }, (_, index) => {
        let label: string;
        try { label = new Date(year, index, 1).toLocaleDateString(locale, { month: 'short' }); }
        catch { label = String(index + 1); }
        return (
          <button
            key={index} type="button"
            class={`dp-month${index === month ? ' is-selected' : ''}`}
            onClick={() => {
              setMonth(index);
              setMode('days');
              setCursor(iso(year, index, Math.min(toParts(cursor)!.d, daysInMonth(year, index))));
            }}
          >{label}</button>
        );
      })}
    </div>
  );

  const step = mode === 'days' ? 'month' : 'year';

  return (
    <div
      class="dp-pop" role="dialog" aria-label="Choose a date" aria-modal="false"
      ref={pop} onKeyDown={onKeyDown}
    >
      <div class="dp-head">
        <button type="button" class="dp-nav" aria-label={`Previous ${step}`} onClick={() => stepBy(-1)}>‹</button>
        <button
          type="button" class="dp-title" aria-label="Switch between months and days"
          onClick={() => setMode(mode === 'days' ? 'months' : 'days')}
        >{mode === 'days' ? monthTitle(year, month, locale) : String(year)}</button>
        <button type="button" class="dp-nav" aria-label={`Next ${step}`} onClick={() => stepBy(1)}>›</button>
      </div>
      {mode === 'days' ? days() : months()}
      <div class="dp-foot">
        <button type="button" class="dp-quick" onClick={() => onPick(todayISO())}>Today</button>
        <div class="dp-hint">Arrows move · Enter picks</div>
        {required ? null : <button type="button" class="dp-quick" onClick={() => onPick('')}>Clear</button>}
      </div>
    </div>
  );
}

export interface DatePickerProps {
  name: string;
  id?: string;
  label?: string;
  /** A required field offers no Clear button. */
  required?: boolean;
  initial?: string;
  locale?: string;
  onChange?: (value: IsoDate | '') => void;
}

export function DatePicker({ name, id, label, required, initial, locale, onChange }: DatePickerProps) {
  const first = toParts(initial) ? (initial as IsoDate) : '';
  const [value, setValue] = useState<IsoDate | ''>(first);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLInputElement>(null);
  const hidden = useRef<HTMLInputElement>(null);

  /* Written to the DOM now, and to state for the calendar's benefit. See the
     note at the top: a form can be filled in and submitted in one turn. */
  const set = (next: IsoDate | ''): void => {
    if (hidden.current) hidden.current.value = next;
    if (text.current) text.current.value = display(next);
    setValue(next);
    onChange?.(next);
  };

  /* What the typed text means, committed when focus leaves or Enter is
     pressed. Unreadable text is put back to the last good value rather than
     silently saved as nothing. */
  const commitTyped = (): void => {
    const raw = text.current?.value ?? '';
    const parsed = parse(raw, value || todayISO());
    if (parsed === null) {
      if (text.current) text.current.value = display(value);
      return;
    }
    set(parsed);
  };

  return (
    <div class="dp" ref={wrap}>
      <input
        ref={text} id={id} type="text" class="dp-text" autoComplete="off" spellcheck={false}
        inputMode="numeric" placeholder="dd/mm/yyyy" aria-label={label ?? 'Date'}
        title="Type 5/8, 5-8-26 or 2026-08-05 — or pick from the calendar"
        defaultValue={display(first)}
        onBlur={(e: FocusEvent) => {
          /* Moving to the calendar button, or into the calendar itself, is not
             leaving the field — both are inside .dp. Anywhere else is, and what
             was typed has to be committed or the box would go on showing a date
             the form would not save. relatedTarget is the element taking focus;
             a synthesised blur event carries none, hence the fallback. */
          const next = (e.relatedTarget as Node | null) ?? document.activeElement;
          if (next && wrap.current?.contains(next)) return;
          commitTyped();
        }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitTyped();
            setOpen(false);
          } else if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          } else if (e.key === 'ArrowUp' && !open) {
            // Nudging the date without opening anything: the fastest correction.
            e.preventDefault();
            set(shiftDays(value || todayISO(), 1));
          } else if (e.key === 'Escape' && open) {
            setOpen(false);
          }
        }}
      />
      <button
        type="button" class="dp-button" aria-label="Open calendar"
        aria-haspopup="dialog" aria-expanded={open ? 'true' : 'false'}
        onClick={() => {
          if (open) { setOpen(false); return; }
          commitTyped();
          setOpen(true);
        }}
      >
        <CalendarIcon />
      </button>
      <input ref={hidden} type="hidden" name={name} defaultValue={first} />
      {open ? (
        <Calendar
          value={value}
          locale={locale || 'en-GB'}
          required={required}
          anchor={text.current}
          onPick={(picked) => { set(picked); setOpen(false); text.current?.focus(); }}
          onClose={() => { setOpen(false); text.current?.focus(); }}
        />
      ) : null}
    </div>
  );
}
