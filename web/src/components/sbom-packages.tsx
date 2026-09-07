"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/field";
import type { SbomComponent, SbomPackage } from "@/lib/signatures-shared";

/** Packages per request; the next page follows when the end of the list scrolls into view. */
const PAGE = 100;

interface PackagePage {
  items: SbomPackage[];
  page: number;
  pages: number;
  total: number;
}

function Chip({ name, version, title }: { name: string; version?: string | null; title?: string }) {
  return (
    <li
      title={title}
      className="max-w-full rounded-md border border-line bg-card-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2 [overflow-wrap:anywhere]"
    >
      {name}
      {version && <span className="text-ink-3">@{version}</span>}
    </li>
  );
}

/**
 * The first few packages of an SBOM, with the rest a click away. Only a
 * preview is stored next to the image; the dialog pages through the full
 * list from the artifact's packages route (parsed and cached on the
 * server), one page per scroll, with a server-side filter — the browser
 * never loads a document with thousands of packages.
 */
export function SbomPackages({
  preview,
  packageCount,
  packagesHref,
  label,
}: {
  preview: SbomComponent[];
  packageCount: number;
  /** Route serving pages of the SBOM's packages (`?q=&page=&per_page=`). */
  packagesHref: string;
  /** What the dialog is about, e.g. the image reference. */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SbomPackage[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const sentinel = useRef<HTMLLIElement>(null);
  const request = useRef(0);
  const hidden = packageCount - preview.length;

  // Typing filters after a short pause, not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(filter.trim()), 250);
    return () => clearTimeout(t);
  }, [filter]);

  const load = useCallback(
    async (next: number, q: string, reset: boolean) => {
      const id = ++request.current;
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`${packagesHref}?page=${next}&per_page=${PAGE}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
        if (!res.ok) throw new Error(`The package list could not be loaded (${res.status}).`);
        const data = (await res.json()) as PackagePage;
        if (id !== request.current) return;
        setItems((prev) => (reset ? data.items : [...prev, ...data.items]));
        setTotal(data.total);
        setPage(data.page);
        setPages(data.pages);
      } catch (err) {
        if (id !== request.current) return;
        setError(err instanceof Error ? err.message : "The package list could not be loaded.");
      } finally {
        if (id === request.current) setBusy(false);
      }
    },
    [packagesHref],
  );

  // Page 1 whenever the dialog opens or the filter changes.
  useEffect(() => {
    if (!open) return;
    void load(1, query, true);
  }, [open, query, load]);

  const more = page < pages;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more || busy) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void load(page + 1, query, false);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [more, busy, page, query, load]);

  return (
    <>
      <ul className="flex flex-wrap gap-1.5">
        {preview.map((c, i) => (
          <Chip key={`${c.name}-${i}`} name={c.name} version={c.version} title={c.license ? `license ${c.license}` : undefined} />
        ))}
        {hidden > 0 && (
          <li>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="cursor-pointer rounded-md border border-dashed border-line-2 px-1.5 py-0.5 text-[11px] text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
            >
              +{hidden} more
            </button>
          </li>
        )}
      </ul>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Packages (${(query && total !== null ? total : packageCount).toLocaleString()})`}
        description={<span className="font-mono text-xs [overflow-wrap:anywhere]">{label}</span>}
        size="lg"
      >
        <div className="space-y-3">
          {packageCount > 12 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter packages…" aria-label="Filter packages" />}
          {error && <p className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
          {total !== null && total > items.length && (
            <p className="text-xs text-ink-3">
              Showing {items.length.toLocaleString()} of {total.toLocaleString()}
            </p>
          )}
          <ul className="flex flex-wrap gap-1.5">
            {items.map((p, i) => (
              <Chip key={`${p.name}-${p.version ?? ""}-${i}`} name={p.name} version={p.version} title={p.license ? `license ${p.license}` : undefined} />
            ))}
            {total === 0 && !busy && <li className="text-sm text-ink-3">No package matches that filter.</li>}
            {busy && items.length === 0 && <li className="text-sm text-ink-3">Loading…</li>}
            {more && (
              <li ref={sentinel} className="basis-full pt-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void load(page + 1, query, false)}
                  className="cursor-pointer rounded-md border border-dashed border-line-2 px-2 py-1 text-xs text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:cursor-default disabled:opacity-60"
                >
                  {busy ? "Loading…" : "Show more"}
                </button>
              </li>
            )}
          </ul>
        </div>
      </Modal>
    </>
  );
}
