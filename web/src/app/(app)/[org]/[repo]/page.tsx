import Link from "next/link";
import { notFound } from "next/navigation";
import { Globe, Settings, Tag as TagIcon } from "lucide-react";
import { getOrgContext } from "@/lib/session";
import { egressSeries, getRepoByPath, listRepoTags, pullSeries, repoTagOverview, trafficSummary } from "@/lib/data";
import { PAGE_SIZES, pageParam } from "@/lib/paginate-shared";
import { env } from "@/lib/env";
import { scanningEnabled } from "@/lib/scanners";
import { formatBytes, formatCount, relativeTime } from "@/lib/format";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { Layers, Link2, ShieldBan, ShieldCheck } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PaginationFooter } from "@/components/ui/pagination";
import { CommandLine, Digest } from "@/components/ui/copy";
import { SeverityChips } from "@/components/severity";
import { PullsChart } from "@/components/pulls-chart";
import { buttonClasses } from "@/components/ui/button";
import { RuleBadges } from "@/components/tag-rules-manager";
import { imageReference } from "@/lib/library";
import { getOrgProxy } from "@/lib/proxy";
import { decodeRepoParam, displayHost, isDockerHubUrl, proxyUpstreamPath, repoHref } from "@/lib/proxy-shared";
import { describeMediaType, untaggedManifestsPage } from "@/lib/manifests";
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
import { EntityLogo } from "@/components/entity-logo";
import { logoVersionOf } from "@/lib/logo";
import { logoRef } from "@/lib/logo-shared";

export default async function RepoPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; repo: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org: orgSlug, repo: rawRepo } = await params;
  const query = await searchParams;
  const repoName = decodeRepoParam(rawRepo);
  const found = await getRepoByPath(orgSlug, repoName);
  // Renamed / transferred repositories: 308 to the new address.
  if (!found) return redirectMovedRepository(orgSlug, repoName);
  const ctx = await getOrgContext(orgSlug);
  const role = ctx?.role ?? null;
  if (found.repo.visibility === "private" && !role) notFound();
  const session = await getSession();

  const [tags, overview, series, proxy, egress, traffic, rules, untagged, star, about, storage] = await Promise.all([
    listRepoTags(found.repo.id, { page: pageParam(query, "tags"), pageSize: PAGE_SIZES.tags }),
    repoTagOverview(found.repo.id),
    role ? pullSeries({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    getOrgProxy(found.org.id),
    role ? egressSeries({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    role ? trafficSummary({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    effectiveTagRules(found.repo.organizationId, found.repo.id),
    untaggedManifestsPage(found.repo.id, { page: pageParam(query, "untagged"), pageSize: PAGE_SIZES.untagged }),
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
  const tagList = tags.rows;
  const lastChecked = overview.lastCheckedAt;
  const scanning = await scanningEnabled();
  // Deleting tags follows the registry access model: owners and admins (instance admins act as owners).
  const canDelete = role === "owner" || role === "admin";
  const latestDigest = overview.latestDigest;
  // Which tag rules lock each tag (immutable / protected) — for badges and the delete button.
  const flagsByTag = new Map(tagList.map((t) => [t.name, tagFlags(rules, t.name)]));
  // Digests referenced by other manifests in this repository (index children); those cannot be deleted alone.
  const showUntagged = untagged.state.total > 0 || canDelete;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="eyebrow mb-1">Repository</div>
          <div className="flex flex-wrap items-center gap-2.5">
            <EntityLogo
              kind="repository"
              name={repoName}
              logo={logoRef("repository", found.repo.id, logoVersionOf(found.repo.logo))}
              size={28}
            />
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

      <CommandLine command={`docker pull ${imageReference(env.registryHost, orgSlug, repoName, overview.names[0])}`} />

      <Card>
        <CardHeader
          eyebrow="Tags"
          title={`Tags (${overview.total.toLocaleString("en-US")})`}
          action={
            overview.names.length >= 2 ? (
              <CompareBar base={base} tags={overview.names} from={overview.names[1]} to={overview.names[0]} compact />
            ) : undefined
          }
        />
        {overview.total === 0 ? (
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
                      {tag.signed && (
                        <Badge tone="ok" className="ml-2 align-middle" title="Signed: a cosign signature from a trusted key verifies this image">
                          <ShieldCheck className="size-3" /> signed
                        </Badge>
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
        <PaginationFooter
          state={tags.state}
          noun="tags"
          basePath={base}
          params={query}
          paramKey="tags"
          label="Tag pages"
        />
      </Card>

      <ReadmeCard html={readmeHtml} about={about} canEdit={role === "owner" || role === "admin"} settingsHref={`${base}/settings`} />

      {showUntagged && (
        <Card>
          <CardHeader
            eyebrow="Untagged"
            title={`Untagged manifests (${untagged.state.total.toLocaleString("en-US")})`}
            description="Images no tag points at: old versions of re-pointed tags, platform variants of a multi-arch image, or attached artifacts."
          />
          {untagged.state.total === 0 ? (
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
                  {untagged.rows.map((m) => {
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
          <PaginationFooter
            state={untagged.state}
            noun="manifests"
            basePath={base}
            params={query}
            paramKey="untagged"
            label="Untagged manifest pages"
          />
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
