"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clsx } from "clsx";
import { Building2, Container, Fingerprint, Search, Tag } from "lucide-react";
import {
  KIND_LABEL,
  SEARCH_MAX_QUERY,
  SEARCH_MIN_TYPEAHEAD,
  normalizeQuery,
  searchHref,
  type SearchHit,
  type SearchHitKind,
} from "@/lib/search-shared";
import { EntityLogo } from "@/components/entity-logo";

const ICONS: Record<SearchHitKind, typeof Search> = {
  repository: Container,
  tag: Tag,
  digest: Fingerprint,
  organization: Building2,
};

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Search field with a debounced typeahead (GET /api/search) and keyboard
 * navigation. Enter submits to /search?q=; "/" focuses the box from anywhere
 * on the page (when `shortcut` is set) and Escape closes the list / blurs.
 */
export function SearchBox({
  defaultValue = "",
  placeholder = "Search images, tags, digests…",
  shortcut = false,
  autoFocus = false,
  size = "sm",
  className,
}: {
  defaultValue?: string;
  placeholder?: string;
  /** Register the global "/" shortcut on this instance. */
  shortcut?: boolean;
  autoFocus?: boolean;
  size?: "sm" | "lg";
  className?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLFormElement>(null);
  const listId = useId();
  const [value, setValue] = useState(defaultValue);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);

  // A navigation closes the list; the results page keeps its query in the box.
  useEffect(() => {
    setOpen(false);
    setActive(-1);
  }, [pathname]);

  useEffect(() => {
    setValue(defaultValue);
  }, [defaultValue]);

  // "/" focuses the box unless the user is already typing somewhere.
  useEffect(() => {
    if (!shortcut) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [shortcut]);

  // Debounced typeahead; stale responses are dropped by sequence number.
  useEffect(() => {
    const q = normalizeQuery(value);
    if (q.length < SEARCH_MIN_TYPEAHEAD) {
      setHits([]);
      setLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal, credentials: "same-origin" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { hits: SearchHit[] };
        if (seq === requestSeq.current) {
          setHits(body.hits);
          setActive(-1);
        }
      } catch {
        // aborted or failed: keep what is shown
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  // Click outside closes the list.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const submit = useCallback(
    (q: string) => {
      const normalized = normalizeQuery(q);
      if (!normalized) return;
      setOpen(false);
      router.push(searchHref(normalized));
    },
    [router],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (open) {
        setOpen(false);
      } else {
        inputRef.current?.blur();
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (hits.length === 0) return;
      e.preventDefault();
      setOpen(true);
      setActive((i) => {
        const n = hits.length;
        return e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === "Enter" && open && active >= 0 && hits[active]) {
      e.preventDefault();
      setOpen(false);
      router.push(hits[active].href);
    }
  }

  const showList = open && normalizeQuery(value).length >= SEARCH_MIN_TYPEAHEAD;
  const large = size === "lg";

  return (
    <form
      ref={rootRef}
      role="search"
      className={clsx("relative", className)}
      onSubmit={(e) => {
        e.preventDefault();
        submit(value);
      }}
    >
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search
      </label>
      <Search
        className={clsx("pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-3", large ? "left-3.5 size-4.5" : "left-2.5 size-4")}
        aria-hidden
      />
      <input
        ref={inputRef}
        id={`${listId}-input`}
        type="search"
        name="q"
        value={value}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        maxLength={SEARCH_MAX_QUERY}
        placeholder={placeholder}
        enterKeyHint="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={`${listId}-list`}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-opt-${active}` : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        data-search-input
        className={clsx(
          "w-full rounded-lg border border-line-2 bg-card text-ink placeholder:text-ink-3 focus:border-action focus:outline-none focus:ring-2 focus:ring-action/15 [&::-webkit-search-cancel-button]:hidden",
          large ? "h-11 pl-10 pr-4 text-base" : "h-9 pl-8 pr-8 text-base sm:text-[13px]",
        )}
      />
      {shortcut && !large && (
        <kbd
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-card-2 px-1.5 font-mono text-[10px] text-ink-3 lg:block"
        >
          /
        </kbd>
      )}
      {showList && (
        <ul
          id={`${listId}-list`}
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-96 overflow-y-auto rounded-xl border border-line bg-card py-1 shadow-card"
        >
          {hits.map((hit, i) => {
            const Icon = ICONS[hit.kind];
            return (
              <li
                key={`${hit.kind}-${hit.href}`}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                onPointerEnter={() => setActive(i)}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => {
                  setOpen(false);
                  router.push(hit.href);
                }}
                className={clsx(
                  "flex cursor-pointer items-start gap-2.5 px-3 py-2 text-[13px]",
                  i === active ? "bg-card-2" : "hover:bg-card-2",
                )}
              >
                <EntityLogo
                kind={hit.kind === "organization" ? "organization" : "repository"}
                name={hit.label}
                logo={hit.kind === "organization" || hit.kind === "repository" ? hit.logo : null}
                size={16}
                className="mt-0.5"
                fallback={<Icon className="size-3.5 text-ink-3" />}
              />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{hit.label}</span>
                  {hit.detail && <span className="block truncate text-xs text-ink-2">{hit.detail}</span>}
                </span>
                <span className="shrink-0 text-right text-[11px] text-ink-3">
                  <span className="block">{KIND_LABEL[hit.kind]}</span>
                  {hit.meta && <span className="block">{hit.meta}</span>}
                </span>
              </li>
            );
          })}
          <li
            role="option"
            aria-selected={false}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => submit(value)}
            className="cursor-pointer border-t border-line px-3 py-2 text-xs text-ink-2 hover:bg-card-2"
          >
            {loading ? "Searching…" : hits.length === 0 ? "No quick matches — " : ""}
            {!loading && (
              <span className="font-medium text-ink">
                {hits.length === 0 ? "search everything" : "See all results"} for “{normalizeQuery(value)}”
              </span>
            )}
          </li>
        </ul>
      )}
    </form>
  );
}
