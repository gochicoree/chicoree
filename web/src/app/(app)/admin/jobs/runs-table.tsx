import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/format";
import { RunResult } from "./run-result";

export interface RunRow {
  id: string;
  job: string;
  status: string;
  params: unknown;
  result: unknown;
  error: string | null;
  triggeredBy: string;
  startedAt: Date;
}

/** How a run was started, for the history table. */
export function trigger(triggeredBy: string): { label: string; tone: "neutral" | "info" | "accent" } {
  if (triggeredBy === "schedule") return { label: "schedule", tone: "accent" };
  if (triggeredBy === "api-token") return { label: "API", tone: "info" };
  if (triggeredBy.startsWith("user:")) return { label: "manual", tone: "neutral" };
  return { label: triggeredBy, tone: "neutral" };
}

export function statusTone(status: string): "ok" | "danger" | "neutral" {
  return status === "succeeded" ? "ok" : status === "failed" ? "danger" : "neutral";
}

/** Run history; `showJob` adds the job column for the cross-job overview. */
export function RunsTable({ runs, showJob, emptyText = "Nothing has run yet." }: { runs: RunRow[]; showJob: boolean; emptyText?: string }) {
  if (runs.length === 0) return <p className="px-5 py-4 text-sm text-ink-3">{emptyText}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            {showJob && <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-5">Job</th>}
            <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-5">Status</th>
            <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Trigger</th>
            <th className="hidden px-4 py-2.5 text-xs font-medium text-ink-2 md:table-cell">Parameters</th>
            <th className="hidden px-4 py-2.5 text-xs font-medium text-ink-2 sm:table-cell">Result</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-2">Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const t = trigger(run.triggeredBy);
            return (
              <tr key={run.id} className="border-b border-line last:border-0">
                {showJob && <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[13px] font-medium sm:px-5">{run.job}</td>}
                <td className="px-4 py-2.5 sm:px-5">
                  <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={t.tone} title={run.triggeredBy}>
                    {t.label}
                  </Badge>
                </td>
                <td className="hidden px-4 py-2.5 font-mono text-xs text-ink-2 md:table-cell">{JSON.stringify(run.params ?? {})}</td>
                <td className="hidden max-w-xs px-4 py-2.5 font-mono text-xs text-ink-2 sm:table-cell">
                  <RunResult job={run.job} result={run.result} error={run.error} />
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs text-ink-3">{relativeTime(run.startedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
