"use client";

import { useState } from "react";
import { formatBytes, shortDigest } from "@/lib/format";

export interface StratumLayer {
  digest: string;
  size: number;
  mediaType?: string;
  command?: string | null;
}

/**
 * The strata bar: an image rendered as the proportional stack of its layers,
 * like a cargo loading plan. Alternating steps of one hue keep neighboring
 * layers distinct; identity comes from order and the hover tooltip, never
 * from color alone.
 */
export function StrataBar({
  layers,
  height = 34,
  showScale = true,
}: {
  layers: StratumLayer[];
  height?: number;
  showScale?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const total = layers.reduce((sum, l) => sum + l.size, 0);
  if (total === 0 || layers.length === 0) {
    return <div className="text-sm text-ink-3">No layer data</div>;
  }

  return (
    <div>
      <div
        className="flex w-full gap-0.5 overflow-hidden touch-pan-y"
        style={{ height }}
        role="img"
        aria-label={`${layers.length} layers, ${formatBytes(total)} total`}
        onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
      >
        {layers.map((layer, i) => (
          <button
            key={`${layer.digest}-${i}`}
            type="button"
            aria-label={`Layer ${i + 1}: ${formatBytes(layer.size)}`}
            onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
            // Touch screens have no hover: a tap selects, tapping again clears.
            onClick={() => setActive((cur) => (cur === i ? null : i))}
            onFocus={() => setActive(i)}
            className="relative min-w-[3px] cursor-pointer rounded-[4px] transition-opacity"
            style={{
              flexGrow: layer.size,
              flexBasis: 0,
              background: i % 2 === 0 ? "var(--chart-1)" : "var(--chart-1-soft)",
              opacity: active === null || active === i ? 1 : 0.35,
            }}
          />
        ))}
      </div>
      {showScale && (
        <div className="mt-1.5 flex items-baseline justify-between font-mono text-xs text-ink-2">
          {active !== null && layers[active] ? (
            <span className="min-w-0 truncate text-ink">
              <span className="text-accent">#{active + 1}</span>{" "}
              {formatBytes(layers[active].size)} · {shortDigest(layers[active].digest)}
              {layers[active].command ? ` · ${layers[active].command}` : ""}
            </span>
          ) : (
            <span>
              {layers.length} {layers.length === 1 ? "layer" : "layers"}
            </span>
          )}
          <span className="shrink-0 pl-3">{formatBytes(total)}</span>
        </div>
      )}
    </div>
  );
}

/** Small, non-interactive variant for table rows. */
export function MiniStrata({ layers }: { layers: { size: number }[] }) {
  const total = layers.reduce((sum, l) => sum + l.size, 0);
  if (total === 0) return null;
  return (
    <div className="flex h-2 w-24 gap-px" aria-hidden>
      {layers.slice(0, 24).map((layer, i) => (
        <div
          key={i}
          className="min-w-px rounded-[2px]"
          style={{
            flexGrow: layer.size,
            flexBasis: 0,
            background: i % 2 === 0 ? "var(--chart-1)" : "var(--chart-1-soft)",
          }}
        />
      ))}
    </div>
  );
}
