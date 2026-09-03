import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { listJobs, recentJobRuns } from "@/lib/jobs";
import { lastScheduledRun, listSchedules, toScheduleView } from "@/lib/schedules";
import { schedulerStatus } from "@/lib/scheduler";
import { env } from "@/lib/env";
import { relativeTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { AdminNav } from "../admin-nav";
import { JobCard } from "./job-card";
import { RunResult } from "./run-result";

export const metadata: Metadata = { title: "Jobs" };

/** How a run was started, for the history table. */
function trigger(triggeredBy: string): { label: string; tone: "neutral" | "info" | "accent" } {
  if (triggeredBy === "schedule") return { label: "schedule", tone: "accent" };
  if (triggeredBy === "api-token") return { label: "API", tone: "info" };
  if (triggeredBy.startsWith("user:")) return { label: "manual", tone: "neutral" };
  return { label: triggeredBy, tone: "neutral" };
}

export default async function JobsPage() {
  await requireAdmin();
  const [jobs, runs, schedules] = await Promise.all([listJobs(), recentJobRuns(40), listSchedules()]);
  const lastScheduled = await Promise.all(jobs.map((j) => lastScheduledRun(j.name)));
  const scheduler = schedulerStatus();

  return (
    <>
      <PageHeader eyebrow="Instance" title="Administration" />
      <AdminNav />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-ink-2">
        <span className="font-medium text-ink">Scheduler</span>
        {!scheduler.enabled ? (
          <Badge tone="danger">disabled by JOB_SCHEDULER=false</Badge>
        ) : scheduler.hasLock ? (
          <Badge tone="ok">active on this instance</Badge>
        ) : scheduler.started ? (
          <Badge>standing by — another instance runs the schedules</Badge>
        ) : (
          <Badge>not started</Badge>
        )}
        {scheduler.lastTickAt && <span className="text-xs text-ink-3">checked {relativeTime(scheduler.lastTickAt)}</span>}
        {scheduler.lastError && <span className="text-xs text-danger">{scheduler.lastError}</span>}
        <span className="text-xs text-ink-3">
          Schedules are checked every 30 s; one instance at a time runs the jobs that are due.
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {jobs.map((job, i) => {
          const row = schedules.get(job.name);
          const last = lastScheduled[i];
          return (
            <JobCard
              key={job.name}
              job={{ name: job.name, title: job.title, description: job.description, params: job.params }}
              schedule={row ? toScheduleView(row) : null}
              lastScheduled={
                last
                  ? { id: last.id, status: last.status, error: last.error, startedAt: last.startedAt.toISOString() }
                  : null
              }
              schedulerEnabled={scheduler.enabled}
            />
          );
        })}
      </div>

      <Card className="mt-6">
        <CardHeader
          eyebrow="Automation"
          title="Jobs API"
          description="Trigger the same jobs from cron, CI or an operator script. Authenticate with JOBS_API_TOKEN or an administrator's read & write access token. Installs that only use external cron can set JOB_SCHEDULER=false."
        />
        <CardBody className="space-y-2">
          <CommandLine command={`curl -X POST -H "Authorization: Bearer $TOKEN" ${env.appUrl}/api/jobs/gc?grace=30m`} />
          <CommandLine command={`curl -X POST -H "Authorization: Bearer $TOKEN" "${env.appUrl}/api/jobs/scan-stale?olderThan=7d&wait=false"`} />
          <CommandLine command={`curl -H "Authorization: Bearer $TOKEN" ${env.appUrl}/api/jobs/runs`} />
        </CardBody>
      </Card>

      <Card className="mt-6">
        <CardHeader eyebrow="History" title={`Recent runs (${runs.length})`} />
        {runs.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">Nothing has run yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-5">Job</th>
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Status</th>
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
                      <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[13px] font-medium sm:px-5">{run.job}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "neutral"}>
                          {run.status}
                        </Badge>
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
        )}
      </Card>
    </>
  );
}
