"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";

interface DetailLine {
  repository: string;
  kind: string;
  ref: string;
  reason: string;
  status: string;
  error?: string;
}

interface Counts {
  planned?: number;
  deleted?: number;
  failed?: number;
}

function short(ref: string): string {
  return ref.startsWith("sha256:") ? ref.slice(7, 19) : ref;
}

/**
 * The result cell of the run history. Plain results are printed as JSON;
 * results that carry a `detail` list (the retention job) get a one-line
 * summary and a modal with the readable per-item list.
 */
export function RunResult({ job, result, error }: { job: string; result: unknown; error: string | null }) {
  const [open, setOpen] = useState(false);
  if (error) {
    return (
      <span className="block truncate text-danger" title={error}>
        {error}
      </span>
    );
  }
  const r = (result ?? {}) as Record<string, unknown>;
  const detail = Array.isArray(r.detail) ? (r.detail as DetailLine[]) : null;
  if (!detail) {
    const text = JSON.stringify(r);
    return (
      <span className="block truncate" title={text}>
        {text}
      </span>
    );
  }

  const dryRun = r.dryRun === true;
  const tags = (r.tags ?? {}) as Counts;
  const manifests = (r.manifests ?? {}) as Counts;
  const verb = dryRun ? "would delete" : "deleted";
  const tagCount = dryRun ? (tags.planned ?? 0) : (tags.deleted ?? 0);
  const manifestCount = dryRun ? (manifests.planned ?? 0) : (manifests.deleted ?? 0);
  const failed = (tags.failed ?? 0) + (manifests.failed ?? 0);
  const truncated = Number(r.truncated ?? 0);
  const summary = `${dryRun ? "dry run: " : ""}${verb} ${tagCount} tag${tagCount === 1 ? "" : "s"}, ${manifestCount} manifest${manifestCount === 1 ? "" : "s"} in ${r.repositories ?? 0} repo${r.repositories === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`;

  const byRepo = new Map<string, DetailLine[]>();
  for (const line of detail) {
    const list = byRepo.get(line.repository) ?? [];
    list.push(line);
    byRepo.set(line.repository, list);
  }

  return (
    <>
      <span className="flex items-center gap-2">
        <span className="truncate" title={summary}>
          {summary}
        </span>
        {detail.length > 0 && (
          <button type="button" onClick={() => setOpen(true)} className="shrink-0 text-action hover:underline cursor-pointer">
            details
          </button>
        )}
      </span>
      <Modal open={open} onClose={() => setOpen(false)} title={`${job}: ${summary}`}>
        <div className="space-y-4 font-sans">
          {[...byRepo.entries()].map(([repo, lines]) => (
            <div key={repo}>
              <div className="mb-1 font-mono text-[13px] font-medium">{repo}</div>
              <ul className="space-y-1">
                {lines.map((line, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-2 text-[13px]">
                    <Badge tone={line.status === "failed" ? "danger" : line.status === "deleted" ? "ok" : "neutral"}>{line.status}</Badge>
                    <span className="text-ink-3">{line.kind}</span>
                    <span className="font-mono">{line.kind === "manifest" ? short(line.ref) : line.ref}</span>
                    <span className="text-ink-3">{line.error ?? line.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {truncated > 0 && <p className="text-xs text-ink-3">… and {truncated} more not recorded.</p>}
        </div>
      </Modal>
    </>
  );
}
