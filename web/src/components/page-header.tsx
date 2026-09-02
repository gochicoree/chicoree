import type { ReactNode } from "react";

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-7">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="font-display text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
        {description && <div className="mt-1 text-sm text-ink-2">{description}</div>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/** Small statistic tile: value + label, no chart. */
export function StatTile({
  label,
  value,
  detail,
  className,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  className?: string;
}) {
  return (
    <div
      className={`min-w-0 rounded-xl border border-line bg-card px-3.5 py-3 shadow-card sm:px-4 sm:py-3.5 ${className ?? ""}`}
    >
      <div className="truncate font-mono text-xl font-semibold leading-tight tabular-nums sm:text-[22px]">{value}</div>
      <div className="mt-0.5 text-[13px] text-ink-2">{label}</div>
      {detail && <div className="mt-0.5 text-xs text-ink-3">{detail}</div>}
    </div>
  );
}
