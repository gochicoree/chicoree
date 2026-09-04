import Link from "next/link";
import { notFound } from "next/navigation";
import { Globe, Settings, Tag as TagIcon } from "lucide-react";
import { getOrgContext } from "@/lib/session";
import { egressSeries, getRepoByPath, listRepoTags, pullSeries, trafficSummary } from "@/lib/data";
import { env } from "@/lib/env";
import { scanningEnabled } from "@/lib/scanners";
import { formatBytes, formatCount, relativeTime } from "@/lib/format";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { Layers, Link2, ShieldBan } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CommandLine, Digest } from "@/components/ui/copy";
import { SeverityChips } from "@/components/severity";
import { PullsChart } from "@/components/pulls-chart";
import { buttonClasses } from "@/components/ui/button";
import { RuleBadges } from "@/components/tag-rules-manager";
import { imageReference } from "@/lib/library";
import { getOrgProxy } from "@/lib/proxy";
import { decodeRepoParam, displayHost, isDockerHubUrl, proxyUpstreamPath, repoHref } from "@/lib/proxy-shared";
import { describeMediaType, listUntaggedManifests } from "@/lib/manifests";
import { effectiveTagRules, tagFlags } from "@/lib/tag-rules";
import { DeleteManifestButton, DeleteTagButton } from "./tag-actions";
import { after } from "next/server";
import { getSession } from "@/lib/session";
import { imageAbout, renderReadme } from "@/lib/readme";
import { recordRepositoryVisit, repoStarState } from "@/lib/stars";
import { ReadmeCard } from "@/components/readme/readme-card";
import { StarButton } from "@/components/star-button";
import { redirectMovedRepository } from "@/lib/redirects";
import { repositoryStorage } from "@/lib/shared-layers";
import { CompareBar } from "./compare/compare-bar";

export default async function RepoPage({
  params,
}: {
  params: Promise<{ org: string; repo: string }>;
}) {
  const { org: orgSlug, repo: rawRepo } = await params;
  const repoName = decodeRepoParam(rawRepo);
  const found = await getRepoByPath(orgSlug, repoName);
  // Renamed / transferred repositories: 308 to the new address.
  if (!found) return redirectMovedRepository(orgSlug, repoName);
  const ctx = await getOrgContext(orgSlug);
  const role = ctx?.role ?? null;
  if (found.repo.visibility === "private" && !role) notFound();
  const session = await getSession();

  const [tagList, series, proxy, egress, traffic, rules, untagged, star, about, storage] = await Promise.all([
    listRepoTags(found.repo.id),
    role ? pullSeries({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    getOrgProxy(found.org.id),
    role ? egressSeries({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    role ? trafficSummary({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    effectiveTagRules(found.repo.organizationId, found.repo.id),
    listUntaggedManifests(found.repo.id),
    repoStarState(found.repo.id, session?.user.id ?? null),
    // The About block only matters when there is no README.
    found.repo.readme ? Promise.resolve(null) : imageAbout(found.repo.id),
    repositoryStorage(found.repo.id),
  ]);
  const readmeHtml = found.repo.readme ? renderReadme(found.repo.readme) : null;
  // "Recently viewed" on the dashboard; throttled to one write per minute inside.
  if (session) {
    const userId = session.user.id;
    after(() => recordRepositoryVisit(userId, found.repo.id).catch((err) => console.error("visit record failed:", err)));
  }
  const path = `${orgSlug}/${repoName}`;
  const base = repoHref(orgSlug, repoName);
  const lastChecked = tagList.reduce<Date | null>(
    (latest, t) => (t.proxyCheckedAt && (!latest || t.proxyCheckedAt > latest) ? t.proxyCheckedAt : latest),
    null,
  );
  const scanning = await scanningEnabled();
  // Deleting tags follows the registry access model: owners and admins (instance admins act as owners).
  const canDelete = role === "owner" || role === "admin";
  const latestDigest = tagList.find((t) => t.name === "latest")?.manifestDigest ?? null;
  // Which tag rules lock each tag (immutable / protected) — for badges and the delete button.
  const flagsByTag = new Map(tagList.map((t) => [t.name, tagFlags(rules, t.name)]));
  // Digests referenced by other manifests in this repository (index children); those cannot be deleted alone.
  const showUntagged = untagged.length > 0 || canDelete;

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
          {storage.physicalBytes > 0 && (
            <p
              className="mt-0.5 font-mono text-xs text-ink-3"
              title="Logical: every tag counted on its own. Stored: distinct layers, deduplicated. Shared: layers other repositories also use."
            >
              Storage: {formatBytes(storage.logicalBytes)} logical · {formatBytes(storage.physicalBytes)} stored
              {storage.sharedBytes > 0 &&
                ` · ${formatBytes(storage.sharedBytes)} shared with ${storage.sharedWithRepos} other ${storage.sharedWithRepos === 1 ? "repository" : "repositories"}`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {session && <StarButton repositoryId={found.repo.id} starred={star.starred} count={star.count} />}
          {(role === "owner" || role === "admin") && (
            <Link href={`${base}/settings`} className={buttonClasses("secondary", "sm")}>
              <Settings className="size-3.5" /> Settings
            </Link>
          )}
        </div>
      </div>

      <CommandLine command={`docker pull ${imageReference(env.registryHost, orgSlug, repoName, tagList[0]?.name)}`} />

      <Card>
        <CardHeader
          eyebrow="Tags"
          title={`Tags (${tagList.length})`}
          action={
            tagList.length >= 2 ? (
              <CompareBar base={base} tags={tagList.map((t) => t.name)} from={tagList[1]?.name} to={tagList[0]?.name} compact />
            ) : undefined
          }
        />
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
                      {(flagsByTag.get(tag.name)?.immutable || flagsByTag.get(tag.name)?.protected) && (
                        <span className="ml-2 inline-flex gap-1 align-middle">
                          <RuleBadges
                            immutable={!!flagsByTag.get(tag.name)?.immutable}
                            isProtected={!!flagsByTag.get(tag.name)?.protected}
                            title={[
                              flagsByTag.get(tag.name)?.immutable && `Immutable (rule "${flagsByTag.get(tag.name)!.immutable!.pattern}"): cannot be re-pointed`,
                              flagsByTag.get(tag.name)?.protected && `Protected (rule "${flagsByTag.get(tag.name)!.protected!.pattern}"): cannot be deleted`,
                            ]
                              .filter(Boolean)
                              .join("; ")}
                          />
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
                          protectedBy={flagsByTag.get(tag.name)?.protected?.pattern ?? null}
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

      <ReadmeCard html={readmeHtml} about={about} canEdit={role === "owner" || role === "admin"} settingsHref={`${base}/settings`} />

      {showUntagged && (
        <Card>
          <CardHeader
            eyebrow="Untagged"
            title={`Untagged manifests (${untagged.length})`}
            description="Images no tag points at: left behind by deleted or re-pointed tags, platform variants of a multi-arch index, or artifacts attached to another image. Retention policies and the prune job clean them up; layer data is reclaimed by garbage collection."
          />
          {untagged.length === 0 ? (
            <CardBody>
              <p className="text-sm text-ink-3">Every manifest in this repository has a tag.</p>
            </CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-5">Digest</th>
                    <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Type</th>
                    <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 md:table-cell">Size</th>
                    <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell">Pushed</th>
                    {canDelete && <th className="w-10 px-2 py-2.5" aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {untagged.map((m) => {
                    const blocked = m.isChild
                      ? "Platform variant of a multi-arch index that still exists; delete the index instead."
                      : null;
                    return (
                      <tr key={m.digest} className="border-b border-line last:border-0 hover:bg-card-2">
                        <td className="px-4 py-3 sm:px-5">
                          <Link href={`/${path}/tags/${encodeURIComponent(m.digest)}`} className="hover:underline">
                            <Digest digest={m.digest} />
                          </Link>
                          <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                            {m.isChild && (
                              <Badge tone="info" title="Referenced by a multi-arch index in this repository">
                                <Layers className="size-3" /> index child
                              </Badge>
                            )}
                            {m.isReferrer && (
                              <Badge tone="info" title={`Attached to ${m.subjectDigest?.slice(7, 19)} (subject)`}>
                                <Link2 className="size-3" /> referrer
                              </Badge>
                            )}
                            {m.referrerCount > 0 && (
                              <Badge tone="neutral" title="Other manifests are attached to this one">
                                {m.referrerCount} attached
                              </Badge>
                            )}
                          </span>
                          <div className="mt-0.5 text-xs text-ink-3 sm:hidden">pushed {relativeTime(m.pushedAt)}</div>
                        </td>
                        <td className="px-4 py-3 text-[13px] text-ink-2">
                          {describeMediaType(m.mediaType, m.artifactType)}
                          {m.isIndex ? (
                            <span className="ml-2 rounded bg-card-2 px-1.5 py-0.5 text-[11px] text-ink-2">multi-arch</span>
                          ) : (
                            m.platform && <span className="ml-2 font-mono text-xs text-ink-3">{m.platform}</span>
                          )}
                        </td>
                        <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 md:table-cell">
                          {m.isIndex ? "—" : formatBytes(m.contentBytes)}
                        </td>
                        <td className="hidden px-4 py-3 text-right text-[13px] text-ink-2 sm:table-cell">{relativeTime(m.pushedAt)}</td>
                        {canDelete && (
                          <td className="px-2 py-2 text-right">
                            <DeleteManifestButton repositoryId={found.repo.id} digest={m.digest} tags={[]} blocked={blocked} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

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
