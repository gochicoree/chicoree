"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Layers, Lock } from "lucide-react";
import type { SharedLayerInfo } from "@/lib/shared-layers";

/**
 * "shared ×N" marker for a layer row: how many other images reference the
 * blob, with a popover listing the ones the viewer may see. References in
 * private repositories the viewer cannot access are counted, never named.
 */
export function SharedLayerBadge({ info }: { info: SharedLayerInfo | null | undefined }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!info || info.total === 0) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-ink-3" title="No other image references this layer">
        unique
      </span>
    );
  }
  const more = info.total - info.hidden - info.visible.length;

  return (
    <span ref={rootRef} className="relative inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line bg-card-2 px-1.5 py-0.5 text-xs font-medium text-ink-2 hover:border-ink-3 hover:text-ink cursor-pointer"
        title={`Shared with ${info.total} other ${info.total === 1 ? "image" : "images"}`}
      >
        <Layers className="size-3" /> shared ×{info.total}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          className="absolute right-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-card p-3 text-left shadow-card"
        >
          <div className="eyebrow mb-1.5">Also used by</div>
          {info.visible.length > 0 ? (
            <ul className="max-h-56 space-y-1 overflow-y-auto font-mono text-xs text-ink">
              {info.visible.map((ref) => (
                <li key={ref} className="truncate" title={ref}>
                  {ref}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-3">Nothing you have access to.</p>
          )}
          {more > 0 && <p className="mt-1.5 text-xs text-ink-3">+{more} more</p>}
          {info.hidden > 0 && (
            <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-ink-3">
              <Lock className="size-3" /> +{info.hidden} private
            </p>
          )}
        </div>
      )}
    </span>
  );
}
