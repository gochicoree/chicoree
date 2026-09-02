import { clsx } from "clsx";
import { ShieldCheck, ShieldQuestion, Loader2, ShieldAlert } from "lucide-react";

// Severity display. Status colors never carry meaning alone: every rendering
// pairs the color with the severity's letter and count.

export const SEVERITIES = [
  { key: "Critical", letter: "C", varName: "--sev-critical" },
  { key: "High", letter: "H", varName: "--sev-high" },
  { key: "Medium", letter: "M", varName: "--sev-medium" },
  { key: "Low", letter: "L", varName: "--sev-low" },
  { key: "Negligible", letter: "N", varName: "--sev-negligible" },
  { key: "Unknown", letter: "?", varName: "--sev-unknown" },
] as const;

export type SeveritySummary = Partial<Record<(typeof SEVERITIES)[number]["key"], number>>;

export function totalFindings(summary: SeveritySummary | null | undefined): number {
  if (!summary) return 0;
  return SEVERITIES.reduce((sum, s) => sum + (summary[s.key] ?? 0), 0);
}

/** Compact chip row: `C 2 · H 14 …` — zero-count severities are omitted. */
export function SeverityChips({
  summary,
  status,
  className,
}: {
  summary: SeveritySummary | null | undefined;
  status?: string | null;
  className?: string;
}) {
  if (status === "pending" || status === "indexing") {
    return (
      <span className={clsx("inline-flex items-center gap-1.5 text-xs text-ink-2", className)}>
        <Loader2 className="size-3.5 animate-spin" /> scanning
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className={clsx("inline-flex items-center gap-1.5 text-xs text-danger", className)}>
        <ShieldAlert className="size-3.5" /> scan failed
      </span>
    );
  }
  if (!summary || status !== "scanned") {
    return (
      <span className={clsx("inline-flex items-center gap-1.5 text-xs text-ink-3", className)}>
        <ShieldQuestion className="size-3.5" /> not scanned
      </span>
    );
  }
  const present = SEVERITIES.filter((s) => (summary[s.key] ?? 0) > 0);
  if (present.length === 0) {
    return (
      <span className={clsx("inline-flex items-center gap-1.5 text-xs font-medium text-ok", className)}>
        <ShieldCheck className="size-3.5" /> clean
      </span>
    );
  }
  return (
    <span className={clsx("inline-flex flex-wrap items-center gap-2 font-mono text-xs", className)}>
      {present.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1" title={`${summary[s.key]} ${s.key}`}>
          <span
            aria-hidden
            className="inline-block size-2 rounded-full"
            style={{ background: `var(${s.varName})` }}
          />
          <span className="text-ink">
            {s.letter} {summary[s.key]}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Stacked severity bar with 2px gaps; always render chips or text nearby. */
export function SeverityBar({ summary, height = 8 }: { summary: SeveritySummary; height?: number }) {
  const total = totalFindings(summary);
  if (total === 0) return null;
  return (
    <div
      className="flex w-full gap-0.5"
      style={{ height }}
      role="img"
      aria-label={SEVERITIES.filter((s) => (summary[s.key] ?? 0) > 0)
        .map((s) => `${summary[s.key]} ${s.key}`)
        .join(", ")}
    >
      {SEVERITIES.filter((s) => (summary[s.key] ?? 0) > 0).map((s) => (
        <div
          key={s.key}
          className="min-w-[3px] rounded-[3px]"
          style={{ flexGrow: summary[s.key]!, flexBasis: 0, background: `var(${s.varName})` }}
        />
      ))}
    </div>
  );
}
