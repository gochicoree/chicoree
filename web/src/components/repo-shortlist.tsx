"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, Container, Globe } from "lucide-react";
import { VisibilityBadge } from "@/components/ui/badge";

export interface ShortlistItem {
  id: string;
  /** "org/name" */
  path: string;
  href: string;
  visibility: "public" | "private";
  proxy: boolean;
  /** Right-aligned hint: "starred 2d ago", "viewed 5m ago". */
  meta: string;
}

/**
 * Compact repository list for the dashboard: the first `initial` rows, and a
 * "Show all" toggle that expands the rest in place.
 */
export function RepoShortlist({
  items,
  initial = 8,
  emptyText,
  name,
}: {
  items: ShortlistItem[];
  initial?: number;
  emptyText: string;
  /** data attribute for tests / styling hooks. */
  name: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-ink-3" data-shortlist={name} data-count="0">
        {emptyText}
      </p>
    );
  }
  const shown = expanded ? items : items.slice(0, initial);
  const hidden = items.length - shown.length;
  return (
    <div data-shortlist={name} data-count={items.length}>
      <ul className="space-y-0.5">
        {shown.map((item) => (
          <li key={item.id}>
            <Link href={item.href} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-card-2">
              {item.proxy ? <Globe className="size-3.5 shrink-0 text-accent" aria-hidden /> : <Container className="size-3.5 shrink-0 text-ink-3" aria-hidden />}
              <span className="min-w-0 flex-1 truncate font-medium text-ink">{item.path}</span>
              <VisibilityBadge visibility={item.visibility} />
              <span className="hidden shrink-0 text-xs text-ink-3 sm:block">{item.meta}</span>
            </Link>
          </li>
        ))}
      </ul>
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-2 hover:bg-card-2 hover:text-ink"
          aria-expanded={expanded}
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3.5" /> Show fewer
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5" /> Show all {items.length}
            </>
          )}
        </button>
      )}
    </div>
  );
}
