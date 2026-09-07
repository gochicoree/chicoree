import Link from "next/link";
import { notFound } from "next/navigation";
import { Globe, Settings, Tag as TagIcon, Package } from "lucide-react";
import { getOrgContext } from "@/lib/session";
import { countArtifactTags, egressSeries, getRepoByPath, listRepoTags, pullSeries, repoTagOverview, sizeSeries, trafficSummary } from "@/lib/data";
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
import { countUntaggedArtifacts, describeIndexChild, describeMediaType, untaggedManifestsPage } from "@/lib/manifests";
import { showArtifactsFor } from "@/lib/artifact-visibility";
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
import { getRepoContext } from "@/lib/repo-access";
import { helmCommands } from "@/lib/helm-shared";
import { imagePath } from "@/lib/library-shared";
import { NO_PREVIEW, repoMetadata, repoShare } from "@/lib/share";
import type { Metadata } from "next";

// Share preview: a public repository describes itself (the card comes from
// opengraph-image.tsx next to this file); anything else is kept out of
// previews and search results, with a tab title only for people who may see it.
export async function generateMetadata({ params }: { params: Promise<{ org: string; repo: string }> }): Promise<Metadata> {
  const { org: orgSlug, repo: rawRepo } = await params;
  const repoName = decodeRepoParam(rawRepo);
  const share = await repoShare(orgSlug, repoName);
  if (share) return repoMetadata(share);
  const access = await getRepoContext(orgSlug, repoName);
  return access ? { title: imagePath(orgSlug, repoName), ...NO_PREVIEW } : NO_PREVIEW;
}

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
  const access = await getRepoContext(orgSlug, repoName);
  const role = access?.role ?? null;
  if (found.repo.visibility === "private" && !role) notFound();
  const session = await getSession();

  // Signature tags, attached artifacts and BuildKit attestation entries stay
  // out of the lists unless the viewer (Settings → Display) or, failing a
  // choice there, the instance (Administration → Branding) wants them.
  const hideArtifacts = !(await showArtifactsFor(session?.user.id ?? null));
  const [tags, overview, series, proxy, egress, sizes, traffic, rules, untagged, star, about, storage, hiddenTags, hiddenUntagged] = await Promise.all([
    listRepoTags(found.repo.id, { page: pageParam(query, "tags"), pageSize: PAGE_SIZES.tags, hideArtifacts }),
    repoTagOverview(found.repo.id),
    role ? pullSeries({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    getOrgProxy(found.org.id),
    role ? egressSeries({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    role ? sizeSeries({ repoId: found.repo.id, days: 90 }) : Promise.resolve(null),
    role ? trafficSummary({ repoId: found.repo.id, days: 30 }) : Promise.resolve(null),
    effectiveTagRules(found.repo.organizationId, found.repo.id),
    untaggedManifestsPage(found.repo.id, { page: pageParam(query, "untagged"), pageSize: PAGE_SIZES.untagged, hideArtifacts }),
    repoStarState(found.repo.id, session?.user.id ?? null),
    // The About block only matters when there is no README.
    found.repo.readme ? Promise.resolve(null) : imageAbout(found.repo.id),
    repositoryStorage(found.repo.id),
    hideArtifacts ? countArtifactTags(found.repo.id) : Promise.resolve(0),
    hideArtifacts ? countUntaggedArtifacts(found.repo.id) : Promise.resolve(0),
  ]);
  const hiddenNote = (n: number, what: string) =>
    n > 0 ? (
      <p className="border-t border-line px-4 py-2 text-xs text-ink-3 sm:px-5">
        {n} {what}
        {n === 1 ? " is" : " are"} hidden
        {session ? (
          <>
            {" "}
            (
            <Link href="/settings#display" className="underline hover:text-ink">
              show them
            </Link>
            )
          </>
        ) : (
          " (sign in to change this)"
        )}
        .
      </p>
    ) : null;
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
  // Helm charts: the newest tag's chart metadata drives the commands shown; chart
  // repositories skip the image-only columns (layers, vulnerabilities, layer compare).
  const latestChart = tags.rows.find((t) => t.chart)?.chart ?? null;
  const scanning = (await scanningEnabled()) && !latestChart;
  // Deleting tags follows the registry access model: admin permission (role or grant; instance admins act as owners).
  const canDelete = !!access?.can.delete;
  const latestDigest = overview.latestDigest;
  // Which tag rules lock each tag (immutable / protected) — for badges and the delete button.
  const flagsByTag = new Map(tagList.map((t) => [t.name, tagFlags(rules, t.name)]));
  // Digests referenced by other manifests in this repository (index children); those cannot be deleted alone.
  const showUntagged = untagged.state.total > 0 || hiddenUntagged > 0 || canDelete;

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
          {access?.can.manage && (
            <Link href={`${base}/settings`} className={buttonClasses("secondary", "sm")}>
              <Settings className="size-3.5" /> Settings
            </Link>
          )}
        </div>
      </div>

      {latestChart ? (
        <div className="space-y-2">
          <CommandLine command={helmCommands(env.registryHost, imagePath(orgSlug, repoName), latestChart.version, latestChart.name).pull} />
          <CommandLine command={helmCommands(env.registryHost, imagePath(orgSlug, repoName), latestChart.version, latestChart.name).install} />
        </div>
      ) : (
        <CommandLine command={`docker pull ${imageReference(env.registryHost, orgSlug, repoName, overview.names[0])}`} />
      )}

      <Card>
        <CardHeader
          eyebrow="Tags"
          title={`Tags (${overview.total.toLocaleString("en-US")})`}
          action={
            overview.names.length >= 2 && !latestChart ? (
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
                  {!latestChart && <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 lg:table-cell">Layers</th>}
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
                      {tag.chart && (
                        <Badge tone="info" className="ml-2 align-middle" title={`Helm chart ${tag.chart.name} ${tag.chart.version}${tag.chart.appVersion ? `, app ${tag.chart.appVersion}` : ""}`}>
                          <Package className="size-3" /> chart {tag.chart.version}
                        </Badge>
                      )}
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
                    <td className="px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2" title={tag.variantPlatform ? `${tag.variantPlatform} variant` : undefined}>
                      {formatBytes(tag.sizeBytes)}
                    </td>
                    {!latestChart && (
                      <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 lg:table-cell" title={tag.variantPlatform ? `${tag.variantPlatform} variant` : undefined}>
                        {tag.layerCount ?? "—"}
                      </td>
                    )}
                    {scanning && (
                      <td className="px-4 py-3">
                        <SeverityChips summary={tag.scanSummary} status={tag.scanStatus} />
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
        {hiddenNote(hiddenTags, hiddenTags === 1 ? "signature or SBOM tag" : "signature and SBOM tags")}
        <PaginationFooter
          state={tags.state}
          noun="tags"
          basePath={base}
          params={query}
          paramKey="tags"
          label="Tag pages"
        />
      </Card>

      <ReadmeCard html={readmeHtml} about={about} canEdit={!!access?.can.manage} settingsHref={`${base}/settings`} />

      {showUntagged && (
        <Card>
          <CardHeader
            eyebrow="Untagged"
            title={`Untagged manifests (${untagged.state.total.toLocaleString("en-US")})`}
            description="Images no tag points at: old versions of re-pointed tags, members of a multi-arch index, or attached artifacts."
          />
          {untagged.state.total === 0 ? (
            <CardBody>
              <p className="text-sm text-ink-3">
                {hiddenUntagged > 0
                  ? "Nothing loose: every untagged manifest here belongs to an index or is attached to an image."
                  : "Every manifest in this repository has a tag."}
              </p>
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
                    const blocked = m.isChild ? describeIndexChild(m) : null;
                    return (
                      <tr key={m.digest} className="border-b border-line last:border-0 hover:bg-card-2">
                        <td className="px-4 py-3 sm:px-5">
                          <Link href={`/${path}/tags/${encodeURIComponent(m.digest)}`} className="hover:underline">
                            <Digest digest={m.digest} />
                          </Link>
                          <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                            {m.isChild && (
                              <Badge tone="info" title={describeIndexChild(m)}>
                                <Layers className="size-3" />
                                {m.isAttestation ? "attestation" : "variant"}
                                {m.parentTags.length > 0 ? ` of ${m.parentTags.slice(0, 2).join(", ")}${m.parentTags.length > 2 ? ", …" : ""}` : " of an index"}
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
                          {m.isAttestation ? "BuildKit attestation" : describeMediaType(m.mediaType, m.artifactType)}
                          {m.isIndex ? (
                            <span className="ml-2 rounded bg-card-2 px-1.5 py-0.5 text-[11px] text-ink-2">multi-arch</span>
                          ) : m.isAttestation ? (
                            <span className="ml-2 text-xs text-ink-3">provenance / SBOM, not an image</span>
                          ) : (
                            m.platform && <span className="ml-2 font-mono text-xs text-ink-3">{m.platform}</span>
                          )}
                        </td>
                        <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 md:table-cell">
                          {formatBytes(m.contentBytes)}
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
          {hiddenNote(hiddenUntagged, hiddenUntagged === 1 ? "index member or attached artifact" : "index members and attached artifacts")}
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
          {sizes && sizes.some((d) => d.bytes > 0) && (
            <Card className="lg:col-span-2">
              <CardHeader
                eyebrow="Size"
                title={latestChart ? "Chart size over time" : "Image size over time"}
                description={latestChart ? "Compressed size of the newest chart pushed each day, last 90 days" : "Compressed size of the newest image pushed each day, last 90 days; indexes and attached artifacts are left out"}
              />
              <CardBody>
                <PullsChart data={sizes.map((d) => ({ day: d.day, count: d.bytes }))} height={130} kind="bytes" emptyLabel="No images pushed in the last 90 days." />
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
