"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { clsx } from "clsx";

/** Calendar date as YYYY-MM-DD, independent of the viewer's time zone. */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseIso(s: string | undefined | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function formatDay(iso: string): string {
  const d = parseIso(iso);
  if (!d) return iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
}

/** Days of the month laid out on a Monday-first grid; null cells pad the first week. */
function monthGrid(year: number, month: number): (Date | null)[] {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const cells: (Date | null)[] = Array.from({ length: offset }, () => null);
  for (let d = new Date(first); d.getMonth() === month; d.setDate(d.getDate() + 1)) cells.push(new Date(d));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/**
 * Calendar popover that replaces the browser's native date input, styled
 * like `Select`. Submits an ISO date through a hidden input named `name`;
 * works controlled (`value`) or uncontrolled (`defaultValue`). Keyboard:
 * arrows move by day/week, PageUp/PageDown by month, Enter picks, Escape
 * closes. `min`/`max` are ISO dates; days outside them cannot be chosen.
 */
export function DatePicker({
  id,
  name,
  value,
  defaultValue,
  onChange,
  min,
  max,
  placeholder = "Pick a date",
  clearable = true,
  disabled,
  className,
  align = "start",
  "aria-label": ariaLabel,
}: {
  id?: string;
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  min?: string;
  max?: string;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
  align?: "start" | "end";
  "aria-label"?: string;
}) {
  const [internal, setInternal] = useState(defaultValue ?? "");
  const current = value !== undefined ? value : internal;
  const [open, setOpen] = useState(false);
  const today = useMemo(() => new Date(), []);
  const initialView = parseIso(current) ?? parseIso(min) ?? today;
  const [view, setView] = useState({ year: initialView.getFullYear(), month: initialView.getMonth() });
  const [focused, setFocused] = useState<string>(current || isoDay(initialView));
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();
  const minD = parseIso(min);
  const maxD = parseIso(max);

  function allowed(d: Date): boolean {
    if (minD && d < minD) return false;
    if (maxD && d > maxD) return false;
    return true;
  }

  function commit(next: string) {
    if (value === undefined) setInternal(next);
    onChange?.(next);
    setOpen(false);
  }

  function show(d: Date) {
    setView({ year: d.getFullYear(), month: d.getMonth() });
    setFocused(isoDay(d));
  }

  useEffect(() => {
    if (!open) return;
    const start = parseIso(current) ?? (minD && minD > today ? minD : today);
    show(start);
    function onDocClick(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocClick);
    return () => document.removeEventListener("pointerdown", onDocClick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focused}"]`);
    el?.focus();
  }, [focused, open, view]);

  function move(days: number) {
    const d = parseIso(focused) ?? today;
    d.setDate(d.getDate() + days);
    show(d);
  }

  function onGridKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); move(-1); break;
      case "ArrowRight": e.preventDefault(); move(1); break;
      case "ArrowUp": e.preventDefault(); move(-7); break;
      case "ArrowDown": e.preventDefault(); move(7); break;
      case "PageUp": { e.preventDefault(); const d = parseIso(focused) ?? today; d.setMonth(d.getMonth() - 1); show(d); break; }
      case "PageDown": { e.preventDefault(); const d = parseIso(focused) ?? today; d.setMonth(d.getMonth() + 1); show(d); break; }
      case "Home": { e.preventDefault(); const d = parseIso(focused) ?? today; d.setDate(1); show(d); break; }
      case "End": { e.preventDefault(); const d = parseIso(focused) ?? today; d.setMonth(d.getMonth() + 1, 0); show(d); break; }
      case "Enter":
      case " ": { e.preventDefault(); const d = parseIso(focused); if (d && allowed(d)) commit(isoDay(d)); break; }
      case "Escape": e.preventDefault(); setOpen(false); break;
      case "Tab": setOpen(false); break;
    }
  }

  const cells = monthGrid(view.year, view.month);
  const prevMonth = new Date(view.year, view.month, 0);
  const nextMonth = new Date(view.year, view.month + 1, 1);
  const canPrev = !minD || prevMonth >= new Date(minD.getFullYear(), minD.getMonth(), 1);
  const canNext = !maxD || nextMonth <= maxD;

  return (
    <div ref={rootRef} className={clsx("relative", className)}>
      {name && <input type="hidden" name={name} value={current} />}
      <button
        type="button"
        id={id}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={clsx(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-line-2 bg-card px-3 py-2 text-left text-base text-ink transition-colors sm:text-sm",
          "hover:border-ink-3 focus:border-action focus:outline-none focus:ring-2 focus:ring-action/15 disabled:cursor-not-allowed disabled:opacity-60",
          open && "border-action ring-2 ring-action/15",
        )}
      >
        <span className={clsx("truncate", !current && "text-ink-3")}>{current ? formatDay(current) : placeholder}</span>
        <span className="flex shrink-0 items-center gap-1 text-ink-3">
          {clearable && current && !disabled && (
            <span
              role="button"
              aria-label="Clear date"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                commit("");
              }}
              className="rounded p-0.5 hover:text-ink"
            >
              <X className="size-3.5" />
            </span>
          )}
          <CalendarDays className="size-4" />
        </span>
      </button>

      {open && (
        <div
          id={dialogId}
          role="dialog"
          aria-label="Choose a date"
          className={clsx(
            "absolute z-30 mt-1 w-72 rounded-lg border border-line bg-card p-2 shadow-card",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          <div className="mb-1 flex items-center justify-between px-1">
            <button
              type="button"
              aria-label="Previous month"
              disabled={!canPrev}
              onClick={() => show(new Date(view.year, view.month - 1, Math.min(parseIso(focused)?.getDate() ?? 1, 28)))}
              className="rounded-md p-1 text-ink-2 hover:bg-card-2 hover:text-ink disabled:opacity-40"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="text-sm font-medium text-ink" aria-live="polite">
              {MONTHS[view.month]} {view.year}
            </span>
            <button
              type="button"
              aria-label="Next month"
              disabled={!canNext}
              onClick={() => show(new Date(view.year, view.month + 1, Math.min(parseIso(focused)?.getDate() ?? 1, 28)))}
              className="rounded-md p-1 text-ink-2 hover:bg-card-2 hover:text-ink disabled:opacity-40"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 px-0.5 text-center text-[11px] font-medium uppercase tracking-wide text-ink-3">
            {WEEKDAYS.map((w) => (
              <span key={w} className="py-1">
                {w}
              </span>
            ))}
          </div>
          <div ref={gridRef} role="grid" onKeyDown={onGridKeyDown} className="grid grid-cols-7 gap-0.5 px-0.5">
            {cells.map((d, i) => {
              if (!d) return <span key={`pad-${i}`} />;
              const iso = isoDay(d);
              const ok = allowed(d);
              const selected = iso === current;
              const isToday = iso === isoDay(today);
              return (
                <button
                  key={iso}
                  type="button"
                  role="gridcell"
                  data-day={iso}
                  tabIndex={iso === focused ? 0 : -1}
                  aria-selected={selected}
                  aria-current={isToday ? "date" : undefined}
                  disabled={!ok}
                  onClick={() => commit(iso)}
                  onFocus={() => setFocused(iso)}
                  className={clsx(
                    "h-8 rounded-md text-sm tabular-nums transition-colors focus:outline-none focus:ring-2 focus:ring-action/30",
                    selected ? "bg-[var(--action)] font-medium text-white" : ok ? "text-ink hover:bg-card-2" : "text-ink-3 opacity-40",
                    isToday && !selected && "ring-1 ring-inset ring-line-2",
                  )}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex items-center justify-between px-1 text-xs">
            <button
              type="button"
              disabled={!allowed(today)}
              onClick={() => commit(isoDay(today))}
              className="rounded px-1.5 py-1 text-ink-2 hover:bg-card-2 hover:text-ink disabled:opacity-40"
            >
              Today
            </button>
            {clearable && current && (
              <button type="button" onClick={() => commit("")} className="rounded px-1.5 py-1 text-ink-2 hover:bg-card-2 hover:text-ink">
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
