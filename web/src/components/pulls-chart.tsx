"use client";

import { useEffect, useRef, useState } from "react";
import { formatCount } from "@/lib/format";

export interface DayCount {
  /** ISO date, e.g. "2026-08-30" */
  day: string;
  count: number;
}

/**
 * Daily pull activity as a single-series bar chart. One series, so the card
 * title carries the identity (no legend). Hover (or tap) shows the exact
 * value. The SVG is laid out at the container's real pixel width so axis
 * text stays 10px on a phone instead of being scaled down with a viewBox.
 */
export function PullsChart({ data, height = 160 }: { data: DayCount[]; height?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setWidth(Math.max(200, Math.floor(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const pad = { top: 12, right: 6, bottom: 22, left: 34 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...data.map((d) => d.count));
  // Round the axis top to a friendly number.
  const step = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / step) * step;
  const ticks = [0, top / 2, top];

  const barGap = 2;
  const slot = innerW / Math.max(data.length, 1);
  const barW = Math.max(2, slot - barGap);
  // Label every week, or less often when the slots get cramped.
  const labelEvery = slot * 7 >= 44 ? 7 : 14;

  if (data.length === 0 || data.every((d) => d.count === 0)) {
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-line text-sm text-ink-3"
        style={{ height }}
      >
        No pulls in this period yet
      </div>
    );
  }

  const activeDatum = active !== null ? data[active] : null;

  return (
    <div ref={hostRef} className="relative touch-pan-y" onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block max-w-full"
        role="img"
        aria-label={`Daily pulls over the last ${data.length} days`}
      >
        {ticks.map((t) => {
          const y = pad.top + innerH - (t / top) * innerH;
          return (
            <g key={t}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y}
                y2={y}
                stroke="var(--chart-grid)"
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={y + 3.5}
                textAnchor="end"
                fontSize={10}
                fill="var(--ink-3)"
                fontFamily="var(--font-mono)"
              >
                {formatCount(t)}
              </text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = (d.count / top) * innerH;
          const x = pad.left + i * slot + barGap / 2;
          const y = pad.top + innerH - h;
          const labelled = i % labelEvery === 0;
          return (
            <g key={d.day}>
              {/* generous hit target; tap toggles on touch screens */}
              <rect
                x={x - barGap / 2}
                y={pad.top}
                width={barW + barGap}
                height={innerH}
                fill="transparent"
                onPointerEnter={(e) => e.pointerType === "mouse" && setActive(i)}
                onPointerDown={(e) => e.pointerType !== "mouse" && setActive(active === i ? null : i)}
              />
              {d.count > 0 && (
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={Math.max(h, 2)}
                  rx={Math.min(3, barW / 2)}
                  fill="var(--chart-1)"
                  opacity={active === null || active === i ? 1 : 0.4}
                  pointerEvents="none"
                />
              )}
              {labelled && (
                <text
                  x={x + barW / 2}
                  y={height - 6}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--ink-3)"
                  fontFamily="var(--font-mono)"
                >
                  {d.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {activeDatum && (
        <div
          className="pointer-events-none absolute -top-1 whitespace-nowrap rounded-md border border-line bg-card px-2 py-1 font-mono text-xs text-ink shadow-card"
          style={{
            left: `${Math.min(Math.max(((pad.left + (active! + 0.5) * slot) / width) * 100, 18), 82)}%`,
            transform: "translateX(-50%)",
          }}
        >
          {activeDatum.day} · {activeDatum.count} {activeDatum.count === 1 ? "pull" : "pulls"}
        </div>
      )}
    </div>
  );
}
