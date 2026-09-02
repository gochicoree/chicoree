import Link from "next/link";
import { notFound } from "next/navigation";
import { Settings, Tag as TagIcon } from "lucide-react";
import { getOrgContext } from "@/lib/session";
import { getRepoByPath, listRepoTags, pullSeries } from "@/lib/data";
import { env } from "@/lib/env";
import { formatBytes, formatCount, relativeTime } from "@/lib/format";
import { VisibilityBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CommandLine, Digest } from "@/components/ui/copy";
import { SeverityChips } from "@/components/severity";
import { PullsChart } from "@/components/pulls-chart";
import { buttonClasses } from "@/components/ui/button";
import { imageReference } from "@/lib/library";

export default async function RepoPage({
  params,
}: {
  params: Promise<{ org: string; repo: string }>;
}) {
  const { org: orgSlug, repo: repoName } = await params;
  const found = await getRepoByPath(orgSlug, repoName);
  if (!found) notFound();
  const ctx = await getOrgContext(orgSlug);
  const role = ctx?.role ?? null;
  if (found.repo.visibility === "private" && !role) notFound();

  const [tagList, series] = await Promise.all([
    listRepoTags(found.repo.id),
    role ? pullSeries({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
  ]);
  const path = `${orgSlug}/${repoName}`;

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
          </div>
          {found.repo.description && <p className="mt-1 text-sm text-ink-2">{found.repo.description}</p>}
          <p className="mt-1 font-mono text-xs text-ink-3">
            {formatCount(found.repo.pullCount)} pulls · updated {relativeTime(found.repo.updatedAt)}
          </p>
        </div>
        {(role === "owner" || role === "admin") && (
          <Link href={`/${path}/settings`} className={buttonClasses("secondary", "sm")}>
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
              Nothing pushed yet. Tag an image as{" "}
              <code className="font-mono">{imageReference(env.registryHost, orgSlug, repoName, "latest")}</code> and push it.
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
                  <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Vulnerabilities</th>
                  <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell">Pushed</th>
                </tr>
              </thead>
              <tbody>
                {tagList.map((tag) => (
                  <tr key={tag.name} className="border-b border-line last:border-0 hover:bg-card-2">
                    <td className="px-4 py-3 sm:px-5">
                      <Link
                        href={`/${path}/tags/${encodeURIComponent(tag.name)}`}
                        className="inline-flex items-center gap-1.5 font-mono text-[13px] font-medium text-ink hover:underline"
                      >
                        <TagIcon className="size-3.5 text-ink-3" />
                        {tag.name}
                      </Link>
                      {tag.isIndex && (
                        <span className="ml-2 rounded bg-card-2 px-1.5 py-0.5 text-[11px] text-ink-2">
                          multi-arch
                        </span>
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
                    <td className="px-4 py-3">
                      <SeverityChips summary={tag.scanSummary} status={tag.isIndex ? "index" : tag.scanStatus} />
                    </td>
                    <td className="hidden px-4 py-3 text-right text-[13px] text-ink-2 sm:table-cell">
                      {relativeTime(tag.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {role && series && (
        <Card>
          <CardHeader eyebrow="Activity" title="Pulls per day" description="Last 30 days, this repository" />
          <CardBody>
            <PullsChart data={series} height={130} />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
