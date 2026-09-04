"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, GitCompareArrows } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

/**
 * The from / to (and platform) picker of the compare page. `compact` is the
 * inline variant on the repository page: two dropdowns and a button.
 */
export function CompareBar({
  base,
  tags,
  from,
  to,
  platform,
  platforms = [],
  compact = false,
}: {
  /** Repository URL (the compare page lives at `${base}/compare`). */
  base: string;
  tags: string[];
  from?: string | null;
  to?: string | null;
  platform?: string | null;
  /** Platforms offered when at least one side is a multi-arch index. */
  platforms?: string[];
  compact?: boolean;
}) {
  const router = useRouter();
  const [f, setF] = useState(from ?? "");
  const [t, setT] = useState(to ?? "");
  const [p, setP] = useState(platform ?? "");
  const [pending, start] = useTransition();

  const refs = Array.from(new Set([...tags, ...[from, to].filter((v): v is string => !!v)]));
  const options = refs.map((name) => ({ value: name, label: name.startsWith("sha256:") ? name.slice(7, 19) : name }));
  const platformOptions = platforms.map((v) => ({ value: v, label: v }));

  function go(next: { from: string; to: string; platform: string }) {
    const q = new URLSearchParams();
    if (next.from) q.set("from", next.from);
    if (next.to) q.set("to", next.to);
    if (next.platform) q.set("platform", next.platform);
    start(() => router.push(`${base}/compare?${q.toString()}`));
  }

  function swap() {
    setF(t);
    setT(f);
    if (!compact && t && f) go({ from: t, to: f, platform: p });
  }

  const ready = !!f && !!t && f !== t;

  return (
    <div className={compact ? "flex flex-wrap items-center gap-2" : "flex flex-wrap items-end gap-2 sm:gap-3"}>
      <div className={compact ? "w-36" : "min-w-40 flex-1 sm:flex-none"}>
        {!compact && <div className="eyebrow mb-1">From</div>}
        <Select
          aria-label="Compare from"
          size={compact ? "sm" : "md"}
          options={options}
          value={f}
          onChange={(v) => {
            setF(v);
            if (!compact && v && t && v !== t) go({ from: v, to: t, platform: p });
          }}
          placeholder="from…"
        />
      </div>
      <button
        type="button"
        onClick={swap}
        aria-label="Swap"
        title="Swap"
        className={`inline-flex shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-card-2 hover:text-ink cursor-pointer ${compact ? "size-7" : "size-9 mb-0.5"}`}
      >
        <ArrowLeftRight className="size-4" />
      </button>
      <div className={compact ? "w-36" : "min-w-40 flex-1 sm:flex-none"}>
        {!compact && <div className="eyebrow mb-1">To</div>}
        <Select
          aria-label="Compare to"
          size={compact ? "sm" : "md"}
          options={options}
          value={t}
          onChange={(v) => {
            setT(v);
            if (!compact && v && f && v !== f) go({ from: f, to: v, platform: p });
          }}
          placeholder="to…"
        />
      </div>
      {!compact && platformOptions.length > 0 && (
        <div className="min-w-40">
          <div className="eyebrow mb-1">Platform</div>
          <Select
            aria-label="Platform"
            options={platformOptions}
            value={p}
            onChange={(v) => {
              setP(v);
              if (f && t) go({ from: f, to: t, platform: v });
            }}
            placeholder="platform…"
          />
        </div>
      )}
      {compact && (
        <Button type="button" size="sm" variant="secondary" disabled={!ready || pending} onClick={() => go({ from: f, to: t, platform: "" })}>
          <GitCompareArrows className="size-3.5" /> Compare
        </Button>
      )}
    </div>
  );
}
