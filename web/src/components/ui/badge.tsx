import { clsx } from "clsx";
import type { ReactNode } from "react";

type Tone = "neutral" | "ok" | "danger" | "accent" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-card-2 text-ink-2 border-line",
  ok: "bg-ok-soft text-ok border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  accent: "bg-accent-soft text-accent-ink border-transparent",
  info: "bg-card-2 text-ink border-line",
};

export function Badge({
  tone = "neutral",
  className,
  title,
  children,
}: {
  tone?: Tone;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Public/private repo marker — consistent everywhere a repo is listed. */
export function VisibilityBadge({ visibility }: { visibility: string }) {
  return (
    <Badge tone={visibility === "public" ? "ok" : "neutral"}>
      {visibility === "public" ? "public" : "private"}
    </Badge>
  );
}
