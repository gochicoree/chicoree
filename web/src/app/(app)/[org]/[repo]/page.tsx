import Link from "next/link";
import { notFound } from "next/navigation";
import { Globe, Settings, Tag as TagIcon } from "lucide-react";
import { getOrgContext } from "@/lib/session";
import { egressSeries, getRepoByPath, listRepoTags, pullSeries, trafficSummary } from "@/lib/data";
import { env } from "@/lib/env";
import { formatBytes, formatCount, relativeTime } from "@/lib/format";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { ShieldBan } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CommandLine, Digest } from "@/components/ui/copy";
import { SeverityChips } from "@/components/severity";
import { PullsChart } from "@/components/pulls-chart";
import { buttonClasses } from "@/components/ui/button";
import { imageReference } from "@/lib/library";
import { getOrgProxy } from "@/lib/proxy";
import { decodeRepoParam, displayHost, isDockerHubUrl, proxyUpstreamPath, repoHref } from "@/lib/proxy-shared";
import { DeleteTagButton } from "./tag-actions";

export default async function RepoPage({
  params,
}: {
  params: Promise<{ org: string; repo: string }>;
}) {
  const { org: orgSlug, repo: rawRepo } = await params;
  const repoName = decodeRepoParam(rawRepo);
  const found = await getRepoByPath(orgSlug, repoName);
  if (!found) notFound();
  const ctx = await getOrgContext(orgSlug);
  const role = ctx?.role ?? null;
  if (found.repo.visibility === "private" && !role) notFound();

  const [tagList, series, proxy, egress, traffic] = await Promise.all([
    listRepoTags(found.repo.id),
    role ? pullSeries({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    getOrgProxy(found.org.id),
    role ? egressSeries({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    role ? trafficSummary({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
  ]);
  const path = `${orgSlug}/${repoName}`;
  const base = repoHref(orgSlug, repoName);
  const lastChecked = tagList.reduce<Date | null>(
    (latest, t) => (t.proxyCheckedAt && (!latest || t.proxyCheckedAt > latest) ? t.proxyCheckedAt : latest),
    null,
  );
  const scanning = env.clairEnabled;
  // Deleting tags follows the registry access model: owners and admins (instance admins act as owners).
  const canDelete = role === "owner" || role === "admin";
  const latestDigest = tagList.find((t) => t.name === "latest")?.manifestDigest ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow mb-1">Repository</div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="break-all font-display text-xl font-bold tracking-tight">
              <Link href={`/${orgSlug}`} className="text-ink-2 hover:text-ink">
                {orgSlug}
              </Link>
              <span className="text-ink-3">/</span>
              {repoName}
            </h1>
            <VisibilityBadge visibility={found.repo.visibility} />
            {proxy && (
              <Badge tone="accent" title={`${proxy.upstreamUrl}/v2/${proxyUpstreamPath(isDockerHubUrl(proxy.upstreamUrl), repoName)}`}>
                <Globe className="size-3" /> cached from {displayHost(proxy.upstreamUrl)}
              </Badge>
            )}
          </div>
          {found.repo.description && <p className="mt-1 text-sm text-ink-2">{found.repo.description}</p>}
          <p className="mt-1 font-mono text-xs text-ink-3">
            {formatCount(found.repo.pullCount)} pulls
            {traffic && ` · ${formatBytes(traffic.egressBytes + traffic.redirectBytes)} egress in 30 days`}
            {" · "}updated {relativeTime(found.repo.updatedAt)}
            {proxy && ` · upstream checked ${lastChecked ? relativeTime(lastChecked) : "never"}`}
          </p>
        </div>
        {(role === "owner" || role === "admin") && (
          <Link href={`${base}/settings`} className={buttonClasses("secondary", "sm")}>
            <Settings className="size-3.5" /> Settings
          </Link>
        )}
      </div>

      <CommandLine command={`docker pull ${imageReference(env.registryHost, orgSlug, repoName, tagList[0]?.name)}`} />

      <Card>
        <CardHeader eyebrow="Tags" title={`Tags (${tagList.length})`} />
        {tagList.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-3">
              {proxy ? (
                <>
                  Nothing cached yet. Pull{" "}
                  <code className="font-mono">{imageReference(env.registryHost, orgSlug, repoName, "latest")}</code> to fetch it from{" "}
                  {displayHost(proxy.upstreamUrl)}.
                </>
              ) : (
                <>
                  Nothing pushed yet. Tag an image as{" "}
                  <code className="font-mono">{imageReference(env.registryHost, orgSlug, repoName, "latest")}</code> and push it.
                </>
              )}
            </p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-5">Tag</th>
                  <th className="hidden px-4 py-2.5 text-xs font-medium text-ink-2 md:table-cell">Digest</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-2">Size</th>
                  <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 lg:table-cell">Layers</th>
                  {scanning && <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Vulnerabilities</th>}
                  <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell">Pushed</th>
                  {canDelete && <th className="w-10 px-2 py-2.5" aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {tagList.map((tag) => (
                  <tr key={tag.name} className="border-b border-line last:border-0 hover:bg-card-2">
                    <td className="px-4 py-3 sm:px-5">
                      <Link
                        href={`${base}/tags/${encodeURIComponent(tag.name)}`}
                        className="inline-flex items-start gap-1.5 break-all font-mono text-[13px] font-medium text-ink hover:underline"
                      >
                        <TagIcon className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                        {tag.name}
                      </Link>
                      {tag.isIndex && (
                        <span className="ml-2 rounded bg-card-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                          multi-arch
                        </span>
                      )}
                      {tag.blocked && (
                        <Badge tone="danger" className="ml-2 align-middle" title={tag.blocked}>
                          <ShieldBan className="size-3" /> pull blocked
                        </Badge>
                      )}
                      <div className="mt-0.5 text-xs text-ink-3 sm:hidden">pushed {relativeTime(tag.updatedAt)}</div>
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      <Digest digest={tag.manifestDigest} />
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2">
                      {tag.isIndex ? "—" : formatBytes(tag.sizeBytes)}
                    </td>
                    <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 lg:table-cell">
                      {tag.isIndex ? "—" : (tag.layerCount ?? "—")}
                    </td>
                    {scanning && (
                      <td className="px-4 py-3">
                        <SeverityChips summary={tag.scanSummary} status={tag.isIndex ? "index" : tag.scanStatus} />
                      </td>
                    )}
                    <td className="hidden px-4 py-3 text-right text-[13px] text-ink-2 sm:table-cell">
                      {relativeTime(tag.updatedAt)}
                    </td>
                    {canDelete && (
                      <td className="px-2 py-2 text-right">
                        <DeleteTagButton
                          repositoryId={found.repo.id}
                          tag={tag.name}
                          latestFollows={tag.name !== "latest" && latestDigest !== null && latestDigest === tag.manifestDigest}
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {role && series && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader eyebrow="Activity" title="Pulls per day" description="Last 30 days, this repository" />
            <CardBody>
              <PullsChart data={series} height={130} />
            </CardBody>
          </Card>
          {egress && (
            <Card>
              <CardHeader eyebrow="Activity" title="Egress per day" description="Bytes served by the registry, last 30 days" />
              <CardBody>
                <PullsChart data={egress} height={130} kind="bytes" />
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
