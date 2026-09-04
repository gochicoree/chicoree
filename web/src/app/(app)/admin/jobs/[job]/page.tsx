import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { jobDefinition, jobRunsPage, listJobs } from "@/lib/jobs";
import { lastScheduledRun, listSchedules, toScheduleView } from "@/lib/schedules";
import { schedulerStatus } from "@/lib/scheduler";
import { env } from "@/lib/env";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { PaginationFooter } from "@/components/ui/pagination";
import { pageParam } from "@/lib/paginate-shared";
import { RunJobForm, ScheduleForm } from "../job-forms";
import { RunsTable } from "../runs-table";

export async function generateMetadata({ params }: { params: Promise<{ job: string }> }): Promise<Metadata> {
  const { job } = await params;
  return { title: jobDefinition(job)?.title ?? "Jobs" };
}

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ job: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { job: name } = await params;
  const job = jobDefinition(name);
  // Jobs hidden for this deployment (no scanner) are not reachable either.
  if (!job || !(await listJobs()).some((j) => j.name === name)) notFound();
  const urlParams = await searchParams;
  const [runs, schedules, last] = await Promise.all([
    jobRunsPage({ job: name, page: pageParam(urlParams) }),
    listSchedules(),
    lastScheduledRun(name),
  ]);
  const schedule = schedules.get(name);
  const scheduler = schedulerStatus();
  const info = { name: job.name, title: job.title, description: job.description, params: job.params };
  const query = job.params.length ? `?${job.params.map((p) => `${p.name}=${encodeURIComponent(p.default)}`).join("&")}` : "";

  return (
    <>
      <div className="mb-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-lg font-bold tracking-tight">{job.title}</h2>
          <span className="font-mono text-xs text-ink-3">{job.name}</span>
          {schedule?.enabled && <Badge tone="accent">scheduled</Badge>}
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-2">{job.description}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader eyebrow="Manual" title="Run now" description="Runs immediately with the parameters below; blanks use the defaults." />
          <CardBody>
            <RunJobForm job={info} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader eyebrow="Automation" title="Schedule" description="Runs on a cron schedule by the instance that holds the scheduler lock." />
          <CardBody>
            <ScheduleForm
              job={info}
              schedule={schedule ? toScheduleView(schedule) : null}
              lastScheduled={last ? { id: last.id, status: last.status, error: last.error, startedAt: last.startedAt.toISOString() } : null}
              schedulerEnabled={scheduler.enabled}
            />
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader eyebrow="History" title={`Runs (${runs.state.total.toLocaleString("en-US")})`} description="Every run of this job, newest first." />
        <RunsTable runs={runs.rows} showJob={false} emptyText="This job has not run yet." />
        <PaginationFooter
          state={runs.state}
          noun="runs"
          basePath={`/admin/jobs/${job.name}`}
          params={urlParams}
          label="Run history pages"
        />
      </Card>

      <Card className="mt-6">
        <CardHeader eyebrow="Automation" title="Jobs API" description="The same job from cron or CI, authenticated with JOBS_API_TOKEN or an administrator's read & write access token." />
        <CardBody>
          <CommandLine command={`curl -X POST -H "Authorization: Bearer $TOKEN" "${env.appUrl}/api/jobs/${job.name}${query}"`} />
        </CardBody>
      </Card>
    </>
  );
}
