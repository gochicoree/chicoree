import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { latestRunsByJob, listJobs, recentJobRuns } from "@/lib/jobs";
import { listSchedules } from "@/lib/schedules";
import { schedulerStatus } from "@/lib/scheduler";
import { describeCron, formatRunTime } from "@/lib/schedule-shared";
import { env } from "@/lib/env";
import { relativeTime } from "@/lib/format";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { RunsTable, statusTone } from "./runs-table";

export const metadata: Metadata = { title: "Jobs" };

export default async function JobsOverviewPage() {
  const [jobs, runs, schedules, latest] = await Promise.all([listJobs(), recentJobRuns(25), listSchedules(), latestRunsByJob()]);
  const scheduler = schedulerStatus();

  return (
    <>
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
        <span className="text-xs text-ink-3">Schedules are checked every 30 s; one instance at a time runs the jobs that are due.</span>
      </div>

      <Card>
        <CardHeader eyebrow="Maintenance" title={`Jobs (${jobs.length})`} description="Open a job to run it, change its schedule or read its history." />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-5">Job</th>
                <th className="hidden px-4 py-2.5 text-xs font-medium text-ink-2 md:table-cell">Schedule</th>
                <th className="hidden px-4 py-2.5 text-xs font-medium text-ink-2 lg:table-cell">Next run</th>
                <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Last run</th>
                <th className="px-2 py-2.5 sm:px-3" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => {
                const schedule = schedules.get(job.name);
                const last = latest.get(job.name);
                const href = `/admin/jobs/${job.name}`;
                let scheduleText = "manual or API only";
                try {
                  if (schedule?.enabled) scheduleText = describeCron(schedule.cron);
                  else if (schedule) scheduleText = `paused · ${describeCron(schedule.cron)}`;
                } catch {
                  scheduleText = schedule?.cron ?? scheduleText;
                }
                return (
                  <tr key={job.name} className="border-b border-line last:border-0 hover:bg-card-2">
                    <td className="px-4 py-3 sm:px-5">
                      <Link href={href} className="font-medium text-ink hover:underline">
                        {job.title}
                      </Link>
                      <div className="font-mono text-xs text-ink-3">{job.name}</div>
                    </td>
                    <td className="hidden px-4 py-3 text-ink-2 md:table-cell">
                      {schedule?.enabled ? <Badge tone="accent">scheduled</Badge> : null} <span className="text-xs">{scheduleText}</span>
                      {schedule && schedule.timezone !== "UTC" && <span className="text-xs text-ink-3"> ({schedule.timezone})</span>}
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-3 text-xs text-ink-2 lg:table-cell">
                      {schedule?.enabled && schedule.nextRunAt ? formatRunTime(schedule.nextRunAt, schedule.timezone) : <span className="text-ink-3">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      {last ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge tone={statusTone(last.status)}>{last.status}</Badge>
                          <span className="whitespace-nowrap text-xs text-ink-3">{relativeTime(last.startedAt)}</span>
                        </span>
                      ) : (
                        <span className="text-xs text-ink-3">never</span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-right sm:px-3">
                      <Link href={href} aria-label={`Open ${job.title}`} className="inline-flex text-ink-3 hover:text-ink">
                        <ChevronRight className="size-4" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader eyebrow="History" title={`Recent runs (${runs.length})`} description="The latest runs across every job; each job's tab has its full history." />
        <RunsTable runs={runs} showJob />
      </Card>

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
    </>
  );
}
