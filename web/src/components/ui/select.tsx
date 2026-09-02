"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { clsx } from "clsx";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Accessible custom listbox that replaces native <select>. Works in plain
 * forms (submits via a hidden input named `name`) and as a controlled
 * component. Keyboard: arrows, Home/End, Enter/Space, Escape, type-ahead.
 */
export function Select({
  options,
  value,
  defaultValue,
  onChange,
  name,
  placeholder = "Select…",
  disabled,
  className,
  size = "md",
  align = "start",
  id,
  "aria-label": ariaLabel,
}: {
  options: SelectOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  /** Which edge of the trigger the list hangs from; "end" for controls near the right screen edge. */
  align?: "start" | "end";
  id?: string;
  "aria-label"?: string;
}) {
  const [internal, setInternal] = useState(defaultValue ?? "");
  const current = value !== undefined ? value : internal;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === current)));
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  const listboxId = useId();

  const selected = options.find((o) => o.value === current);

  function commit(next: string) {
    if (value === undefined) setInternal(next);
    onChange?.(next);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onDocClick);
    return () => document.removeEventListener("pointerdown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      setActive(Math.max(0, options.findIndex((o) => o.value === current)));
      requestAnimationFrame(() => listRef.current?.focus());
    }
  }, [open, options, current]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        if (open) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case "End":
        if (open) {
          e.preventDefault();
          setActive(options.length - 1);
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (open && options[active]) commit(options[active].value);
        else setOpen(true);
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const now = Date.now();
          const t = typeahead.current;
          t.text = now - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
          t.at = now;
          const idx = options.findIndex((o) => o.label.toLowerCase().startsWith(t.text));
          if (idx >= 0) {
            setActive(idx);
            if (!open) commit(options[idx].value);
          }
        }
    }
  }

  return (
    <div ref={rootRef} className={clsx("relative", className)} onKeyDown={onKeyDown}>
      {name && <input type="hidden" name={name} value={current} />}
      <button
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={clsx(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-line-2 bg-card text-left text-ink transition-colors",
          "hover:border-ink-3 focus:border-action focus:outline-none focus:ring-2 focus:ring-action/15 disabled:cursor-not-allowed disabled:opacity-60",
          // 16px text on phones so iOS does not zoom when the list opens.
          size === "sm" ? "px-2.5 py-1.5 text-base sm:py-1 sm:text-[13px]" : "px-3 py-2 text-base sm:text-sm",
          open && "border-action ring-2 ring-action/15",
        )}
      >
        <span className={clsx("truncate", !selected && "text-ink-3")}>{selected?.label ?? placeholder}</span>
        <ChevronDown className={clsx("size-4 shrink-0 text-ink-3 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={options[active] ? `${listboxId}-${active}` : undefined}
          className={clsx(
            "absolute z-30 mt-1 max-h-64 w-max min-w-full max-w-[min(20rem,calc(100vw-2rem))] overflow-auto rounded-lg border border-line bg-card p-1 shadow-card outline-none",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {options.map((o, i) => {
            const isSelected = o.value === current;
            return (
              <li
                key={o.value}
                id={`${listboxId}-${i}`}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(o.value)}
                className={clsx(
                  "flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-sm sm:py-1.5",
                  i === active ? "bg-card-2 text-ink" : "text-ink",
                )}
              >
                <Check className={clsx("mt-0.5 size-3.5 shrink-0", isSelected ? "text-accent" : "text-transparent")} />
                <span className="min-w-0">
                  <span className="block truncate">{o.label}</span>
                  {o.description && <span className="block text-xs text-ink-2">{o.description}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
