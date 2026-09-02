import { formatBytes } from "@/lib/format";

/** "used of limit" with a proportional bar; unlimited shows just the count. */
export function UsageMeter({
  label,
  used,
  limit,
  bytes = false,
}: {
  label: string;
  used: number;
  limit: number | null;
  bytes?: boolean;
}) {
  const fmt = (n: number) => (bytes ? formatBytes(n) : String(n));
  const ratio = limit ? Math.min(used / limit, 1) : 0;
  const over = limit !== null && used >= limit;
  return (
    <div className="rounded-xl border border-line bg-card px-4 py-3.5 shadow-card">
      <div className="text-[13px] text-ink-2">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums">
        {fmt(used)}
        <span className="text-sm font-normal text-ink-3"> / {limit === null ? "∞" : fmt(limit)}</span>
      </div>
      {limit !== null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-card-2">
          <div
            className="h-full rounded-full"
            style={{ width: `${ratio * 100}%`, background: over ? "var(--danger)" : "var(--chart-1)" }}
          />
        </div>
      )}
    </div>
  );
}
