"use client";

import { useEffect, useState, useTransition } from "react";
import { Star } from "lucide-react";
import { clsx } from "clsx";
import { toggleStar } from "@/app/actions/stars";
import { useToast } from "@/components/ui/toast";

/** Compact "★ 12" marker for listings; hidden at zero. */
export function StarCount({ count, className }: { count: number; className?: string }) {
  if (!count) return null;
  return (
    <span className={clsx("inline-flex items-center gap-0.5 font-mono text-xs tabular-nums text-ink-3", className)} title={`${count} star${count === 1 ? "" : "s"}`} data-star-count>
      <Star className="size-3" aria-hidden />
      {count}
    </span>
  );
}

/** Toggle on the repository page: optimistic, reverts on error. */
export function StarButton({ repositoryId, starred, count }: { repositoryId: string; starred: boolean; count: number }) {
  const [state, setState] = useState({ starred, count });
  const [pending, startTransition] = useTransition();
  const { toast } = useToast();

  useEffect(() => {
    setState({ starred, count });
  }, [starred, count]);

  function onClick() {
    const next = !state.starred;
    const before = state;
    setState({ starred: next, count: Math.max(0, state.count + (next ? 1 : -1)) });
    startTransition(async () => {
      const result = await toggleStar(repositoryId, next);
      if (result.error) {
        setState(before);
        toast({ title: result.error, tone: "error" });
      } else {
        setState({ starred: result.starred, count: result.count });
      }
    });
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={state.starred}
      data-star-button
      data-starred={state.starred ? "true" : "false"}
      className={clsx(
        "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-colors pointer-coarse:h-9",
        state.starred ? "border-accent/40 bg-accent-soft text-accent-ink hover:opacity-90" : "border-line-2 bg-card text-ink hover:bg-card-2 hover:border-ink-3",
        pending && "opacity-70",
      )}
    >
      <Star className={clsx("size-3.5", state.starred && "fill-current")} aria-hidden />
      {state.starred ? "Starred" : "Star"}
      <span className="rounded bg-card-2 px-1.5 font-mono text-xs tabular-nums text-ink-2" data-star-total>
        {state.count}
      </span>
    </button>
  );
}
