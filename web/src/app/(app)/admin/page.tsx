import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { instanceStats } from "@/lib/data";
import { recentJobRuns } from "@/lib/jobs";
import { credentialStats } from "@/lib/credential-auth";
import { registryHealth } from "@/lib/registry-client";
import { formatBytes, relativeTime } from "@/lib/format";
import { PageHeader, StatTile } from "@/components/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { AdminNav } from "./admin-nav";
import { adminSetupChecklist } from "@/lib/admin-checklist";
import { SetupChecklist } from "@/components/admin/setup-checklist";
import { ApiRevisionCard } from "@/components/admin/api-revision-card";
import { apiRevisionNotice } from "@/lib/api/revision-notice";

export const metadata: Metadata = { title: "Administration" };

export default async function AdminPage() {
  const session = await requireAdmin();
  const [stats, health, runs, checklist, credentials, apiNotice] = await Promise.all([
    instanceStats(),
    registryHealth(),
    recentJobRuns(6),
    adminSetupChecklist(session.user.id),
    credentialStats(),
    apiRevisionNotice(),
  ]);
  const dedupSaved = Math.max(stats.logicalBytes - stats.blobBytes, 0);

  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Registry-wide health, storage, people and maintenance."
        action={
          <Badge tone={health.ok ? "ok" : "danger"}>
            registry {health.ok ? `up · ${health.storage} storage` : "unreachable"}
          </Badge>
        }
      />
      <AdminNav />

      {!checklist.dismissed && <SetupChecklist checklist={checklist} />}
      <ApiRevisionCard notice={apiNotice} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Users" value={stats.users} />
        <StatTile label="Organizations" value={stats.orgs} />
        <StatTile label="Repositories" value={stats.repos} />
        <StatTile label="Events, 24h" value={stats.events24h} />
        <StatTile label="Unique blobs" value={stats.blobs} />
        <StatTile label="Physical storage" value={formatBytes(stats.blobBytes)} />
        <StatTile label="Logical storage" value={formatBytes(stats.logicalBytes)} />
        <StatTile label="Saved by dedup" value={formatBytes(dedupSaved)} />
      </div>

      <Card className="mt-6" data-credentials-card>
        <CardHeader
          eyebrow="Credentials"
          title="Access tokens and service accounts"
          description="Expiry across every user and organization. The token-expiry job emails owners a week ahead; revoke individual tokens from a user's page."
          action={
            <Link href="/admin/users" className={buttonClasses("secondary", "sm")}>
              Users
            </Link>
          }
        />
        <div className="grid grid-cols-3 divide-x divide-line">
          <div className="px-4 py-3 sm:px-5">
            <div className="eyebrow">Expiring within 7 days</div>
            <div className={`font-display text-xl font-semibold ${credentials.expiringSoon > 0 ? "text-danger" : ""}`} data-stat="expiring">
              {credentials.expiringSoon}
            </div>
            <div className="text-xs text-ink-3">
              {credentials.tokens.expiringSoon} tokens · {credentials.serviceAccounts.expiringSoon} service accounts
            </div>
          </div>
          <div className="px-4 py-3 sm:px-5">
            <div className="eyebrow">Never expiring</div>
            <div className="font-display text-xl font-semibold" data-stat="never">
              {credentials.neverExpiring}
            </div>
            <div className="text-xs text-ink-3">
              {credentials.tokens.neverExpiring} tokens · {credentials.serviceAccounts.neverExpiring} service accounts
            </div>
          </div>
          <div className="px-4 py-3 sm:px-5">
            <div className="eyebrow">Expired</div>
            <div className="font-display text-xl font-semibold" data-stat="expired">
              {credentials.expired}
            </div>
            <div className="text-xs text-ink-3">
              {credentials.tokens.expired} tokens · {credentials.serviceAccounts.expired} service accounts
            </div>
          </div>
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader
          eyebrow="Maintenance"
          title="Recent job runs"
          description="Garbage collection, re-scans and pruning. Run or schedule them from the Jobs tab or the jobs API."
          action={
            <Link href="/admin/jobs" className={buttonClasses("secondary", "sm")}>
              Open jobs
            </Link>
          }
        />
        {runs.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">No jobs have run yet.</p>
        ) : (
          <div>
            {runs.map((run) => (
              <div key={run.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm last:border-0 sm:px-5">
                <span className="font-mono text-[13px] font-medium">{run.job}</span>
                <Badge tone={run.status === "succeeded" ? "ok" : run.status === "failed" ? "danger" : "neutral"}>
                  {run.status}
                </Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
                  {run.error ?? JSON.stringify(run.result ?? {})}
                </span>
                <span className="shrink-0 text-xs text-ink-3">{relativeTime(run.startedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
