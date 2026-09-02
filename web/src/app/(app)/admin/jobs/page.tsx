import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { listJobs, recentJobRuns } from "@/lib/jobs";
import { env } from "@/lib/env";
import { relativeTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { AdminNav } from "../admin-nav";
import { JobCard } from "./job-card";

export const metadata: Metadata = { title: "Jobs" };

export default async function JobsPage() {
  await requireAdmin();
  const [jobs, runs] = await Promise.all([listJobs(), recentJobRuns(40)]);

  return (
    <>
      <PageHeader eyebrow="Instance" title="Administration" />
      <AdminNav />

      <div className="grid gap-4 lg:grid-cols-3">
        {jobs.map((job) => (
          <JobCard
            key={job.name}
            job={{ name: job.name, title: job.title, description: job.description, params: job.params }}
          />
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader
          eyebrow="Automation"
          title="Jobs API"
          description="Trigger the same jobs from cron, CI or an operator script. Authenticate with JOBS_API_TOKEN or an administrator's read & write access token."
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
                  <th className="hidden px-4 py-2.5 text-xs font-medium text-ink-2 md:table-cell">Parameters</th>
                  <th className="hidden px-4 py-2.5 text-xs font-medium text-ink-2 sm:table-cell">Result</th>
                  <th className="hidden px-4 py-2.5 text-xs font-medium text-ink-2 lg:table-cell">Triggered by</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-2">Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5 font-mono text-[13px] font-medium sm:px-5">{run.job}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "neutral"}>
                        {run.status}
                      </Badge>
                    </td>
                    <td className="hidden px-4 py-2.5 font-mono text-xs text-ink-2 md:table-cell">{JSON.stringify(run.params ?? {})}</td>
                    <td className="hidden max-w-xs truncate px-4 py-2.5 font-mono text-xs text-ink-2 sm:table-cell" title={run.error ?? ""}>
                      {run.error ?? JSON.stringify(run.result ?? {})}
                    </td>
                    <td className="hidden px-4 py-2.5 font-mono text-xs text-ink-2 lg:table-cell">{run.triggeredBy}</td>
                    <td className="px-4 py-2.5 text-right text-xs text-ink-3">{relativeTime(run.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
