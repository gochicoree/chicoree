import Link from "next/link";
import { notFound } from "next/navigation";
import { Plus } from "lucide-react";
import { getOrgContext } from "@/lib/session";
import { egressSeries, orgReposPage, pullSeries, trafficSummary } from "@/lib/data";
import { pageParam } from "@/lib/paginate-shared";
import { formatBytes } from "@/lib/format";
import { RepoTable } from "@/components/repo-table";
import { StatTile } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { PullsChart } from "@/components/pulls-chart";
import { buttonClasses } from "@/components/ui/button";
import { WRITER_ROLES } from "@/lib/org-roles";
import { Download } from "lucide-react";
import { imagePath } from "@/lib/library";
import { getOrgProxy } from "@/lib/proxy";
import { displayHost, isDockerHubUrl } from "@/lib/proxy-shared";
import { env } from "@/lib/env";
import { NO_PREVIEW, orgMetadata, orgShare } from "@/lib/share";
import type { Metadata } from "next";

// Share preview: an organization's public face (its card lives next to this file).
export async function generateMetadata({ params }: { params: Promise<{ org: string }> }): Promise<Metadata> {
  const { org: slug } = await params;
  const share = await orgShare(slug);
  return share ? orgMetadata(share) : NO_PREVIEW;
}

export default async function OrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  const { org, role } = ctx;
  const query = await searchParams;

  const [repos, series, proxy, egress, traffic] = await Promise.all([
    orgReposPage(org.id, !!role, { page: pageParam(query) }),
    role ? pullSeries({ orgId: org.id, days: 30 }) : Promise.resolve(null),
    getOrgProxy(org.id),
    role ? egressSeries({ orgId: org.id, days: 30 }) : Promise.resolve(null),
    role ? trafficSummary({ orgId: org.id, days: 30 }) : Promise.resolve(null),
  ]);
  // Proxy caches are filled by pulls, never by pushes or the UI.
  const canWrite = !!role && WRITER_ROLES.includes(role) && !proxy;
  const totalSize = repos.totals.sizeBytes;
  const totalPulls = repos.totals.pullCount;

  return (
    <div className="space-y-6">
      {role && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Repositories" value={repos.totals.count} />
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
        {repos.totals.count === 0 ? (
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
          <>
            <RepoTable repos={repos.rows} />
            <Pagination
              state={repos.state}
              noun="repositories"
              basePath={`/${slug}`}
              params={query}
              label="Repository pages"
              className="mt-3"
            />
          </>
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
