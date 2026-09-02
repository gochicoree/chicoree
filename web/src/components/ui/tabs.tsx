"use client";

import { useState, type ReactNode } from "react";
import { clsx } from "clsx";

/**
 * Client-side tabs over server-rendered content: every panel is rendered by
 * the server, inactive ones are hidden. Counts can be shown per tab.
 */
export function Tabs({
  tabs,
}: {
  tabs: { label: string; badge?: string | number; content: ReactNode }[];
}) {
  const [active, setActive] = useState(0);
  return (
    <div>
      <div
        role="tablist"
        className="-mx-4 flex gap-1 overflow-x-auto border-b border-line px-4 scrollbar-none sm:mx-0 sm:px-0"
      >
        {tabs.map((tab, i) => (
          <button
            key={tab.label}
            role="tab"
            aria-selected={active === i}
            onClick={() => setActive(i)}
            className={clsx(
              "-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer sm:py-2",
              active === i
                ? "border-accent text-ink"
                : "border-transparent text-ink-2 hover:border-line-2 hover:text-ink",
            )}
          >
            {tab.label}
            {tab.badge !== undefined && (
              <span className="rounded-full bg-card-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>
      {tabs.map((tab, i) => (
        <div key={tab.label} role="tabpanel" hidden={active !== i} className="pt-5">
          {tab.content}
        </div>
      ))}
    </div>
  );
}
