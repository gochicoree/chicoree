import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { getOrgContext } from "@/lib/session";
import { egressSeries, listOrgRepos, pullSeries, trafficSummary } from "@/lib/data";
import { formatBytes } from "@/lib/format";
import { RepoTable } from "@/components/repo-table";
import { StatTile } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PullsChart } from "@/components/pulls-chart";
import { buttonClasses } from "@/components/ui/button";
import { WRITER_ROLES } from "@/lib/org-roles";
import { Download } from "lucide-react";
import { imagePath } from "@/lib/library";
import { getOrgProxy } from "@/lib/proxy";
import { displayHost, isDockerHubUrl } from "@/lib/proxy-shared";
import { env } from "@/lib/env";

export default async function OrgPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  const { org, role } = ctx;

  const [repos, series, proxy, egress, traffic] = await Promise.all([
    listOrgRepos(org.id, !!role),
    role ? pullSeries({ orgId: org.id, days: 30 }) : Promise.resolve(null),
    getOrgProxy(org.id),
    role ? egressSeries({ orgId: org.id, days: 30 }) : Promise.resolve(null),
    role ? trafficSummary({ orgId: org.id, days: 30 }) : Promise.resolve(null),
  ]);
  // Proxy caches are filled by pulls, never by pushes or the UI.
  const canWrite = !!role && WRITER_ROLES.includes(role) && !proxy;
  const totalSize = repos.reduce((sum, r) => sum + r.sizeBytes, 0);
  const totalPulls = repos.reduce((sum, r) => sum + r.pullCount, 0);

  return (
    <div className="space-y-6">
      {role && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Repositories" value={repos.length} />
          <StatTile label="Logical size" value={formatBytes(totalSize)} />
          <StatTile label="Total pulls" value={totalPulls} />
          <StatTile
            label="Egress, 30 days"
            value={formatBytes((traffic?.egressBytes ?? 0) + (traffic?.redirectBytes ?? 0))}
            detail={traffic?.redirectBytes ? `${formatBytes(traffic.redirectBytes)} via storage redirects` : `${formatBytes(traffic?.ingressBytes ?? 0)} ingress`}
          />
        </div>
      )}

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-base font-semibold">
            {role ? "Repositories" : "Public repositories"}
          </h2>
          {canWrite && (
            <div className="flex items-center gap-2">
              <Link href={`/${slug}/new-repository?mode=mirror`} className={buttonClasses("secondary", "sm")}>
                <Download className="size-3.5" /> Import
              </Link>
              <Link href={`/${slug}/new-repository`} className={buttonClasses("primary", "sm")}>
                <Plus className="size-3.5" /> New repository
              </Link>
            </div>
          )}
        </div>
        {repos.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center">
            <p className="text-sm text-ink-2">
              {proxy
                ? `Nothing cached yet. Pull any ${displayHost(proxy.upstreamUrl)} image through this organization and it shows up here.`
                : "No repositories yet. Create one here, or just push — repositories are created on first push."}
            </p>
            {proxy && (
              <code className="mt-3 inline-block max-w-full rounded-md bg-card-2 px-3 py-1.5 font-mono text-[13px] text-ink-2 [overflow-wrap:anywhere]">
                docker pull {env.registryHost}/{slug}/{isDockerHubUrl(proxy.upstreamUrl) ? "nginx:1.27" : "<namespace>/<image>:<tag>"}
              </code>
            )}
            {canWrite && (
              <code className="mt-3 inline-block max-w-full rounded-md bg-card-2 px-3 py-1.5 font-mono text-[13px] text-ink-2 [overflow-wrap:anywhere]">
                docker push &lt;registry&gt;/{imagePath(slug, "<name>")}:latest
              </code>
            )}
          </div>
        ) : (
          <RepoTable repos={repos} />
        )}
      </div>

      {role && series && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader eyebrow="Activity" title="Pulls per day" description="Last 30 days, this organization" />
            <CardBody>
              <PullsChart data={series} height={140} />
            </CardBody>
          </Card>
          {egress && (
            <Card>
              <CardHeader eyebrow="Activity" title="Egress per day" description="Bytes served by the registry, last 30 days" />
              <CardBody>
                <PullsChart data={egress} height={140} kind="bytes" />
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
