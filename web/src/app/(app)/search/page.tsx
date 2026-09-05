import type { Metadata } from "next";
import Link from "next/link";
import { Building2, Container, Fingerprint, Tag as TagIcon } from "lucide-react";
import { getSession } from "@/lib/session";
import { digestHref, searchAll, tagHref } from "@/lib/search";
import { normalizeQuery } from "@/lib/search-shared";
import { viewerFromSession } from "@/lib/viewer";
import { formatCount, relativeTime, shortDigest } from "@/lib/format";
import { repoHref } from "@/lib/proxy-shared";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PaginationFooter } from "@/components/ui/pagination";
import { pageParam } from "@/lib/paginate-shared";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { SearchBox } from "@/components/shell/search-box";
import { StarCount } from "@/components/star-button";
import { EntityLogo } from "@/components/entity-logo";
import { logoRef } from "@/lib/logo-shared";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const q = normalizeQuery(Array.isArray(params.q) ? params.q[0] : params.q);
  const session = await getSession();
  const results = await searchAll(viewerFromSession(session), q, {
    repositories: pageParam(params, "repos"),
    tags: pageParam(params, "tags"),
    digests: pageParam(params, "digests"),
    organizations: pageParam(params, "orgs"),
  });

  return (
    <>
      <PageHeader
        eyebrow="Search"
        title={q ? `Results for “${q}”` : "Search"}
        description={
          q
            ? `${results.total} match${results.total === 1 ? "" : "es"}.`
            : "Find repositories, tags, images by digest, and organizations."
        }
      />
      <SearchBox defaultValue={q} size="lg" autoFocus={!q} className="mb-6" placeholder="Search images, tags, digests, organizations…" />

      {q && results.total === 0 && (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-3" data-search-empty>
          Nothing matches “{q}”. Try a shorter name, <code className="font-mono">org/repo:tag</code> or the start of a digest.
        </p>
      )}

      <div className="space-y-6">
        {results.digests.state.total > 0 && (
          <Card>
            <CardHeader
              eyebrow="Content"
              title={`Digests (${results.digests.state.total.toLocaleString("en-US")})`}
              description="Digests starting with what you typed."
            />
            <ul data-search-group="digests">
              {results.digests.rows.map((d) => (
                <li key={`${d.orgSlug}/${d.repoName}@${d.digest}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 hover:bg-card-2 sm:px-5">
                  <Fingerprint className="size-4 shrink-0 text-ink-3" aria-hidden />
                  <Link href={digestHref(d)} className="min-w-0 break-all font-mono text-[13px] font-medium text-ink hover:underline">
                    {d.orgSlug}/{d.repoName}@{shortDigest(d.digest, 19)}
                  </Link>
                  <VisibilityBadge visibility={d.visibility} />
                  {d.tags.map((t) => (
                    <Badge key={t} tone="info" className="font-mono">
                      :{t}
                    </Badge>
                  ))}
                  <span className="ml-auto text-xs text-ink-3">pushed {relativeTime(d.createdAt)}</span>
                </li>
              ))}
            </ul>
            <PaginationFooter state={results.digests.state} noun="digests" basePath="/search" params={params} paramKey="digests" label="Digest result pages" />
          </Card>
        )}

        {results.repositories.state.total > 0 && (
          <Card>
            <CardHeader eyebrow="Images" title={`Repositories (${results.repositories.state.total.toLocaleString("en-US")})`} />
            <ul data-search-group="repositories">
              {results.repositories.rows.map((r) => (
                <li key={r.id} className="border-b border-line px-4 py-3 last:border-0 hover:bg-card-2 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <EntityLogo
                      kind="repository"
                      name={r.name}
                      logo={logoRef("repository", r.id, r.logoVersion)}
                      size={20}
                      fallback={<Container className="size-4 text-ink-3" />}
                    />
                    <Link href={repoHref(r.orgSlug ?? "", r.name)} className="min-w-0 break-all text-sm font-medium text-ink hover:underline">
                      <span className="text-ink-2">{r.orgSlug}/</span>
                      {r.name}
                    </Link>
                    <VisibilityBadge visibility={r.visibility} />
                    <StarCount count={r.starCount} />
                    <span className="ml-auto font-mono text-xs text-ink-3">
                      {formatCount(r.pullCount)} pulls · updated {relativeTime(r.updatedAt)}
                    </span>
                  </div>
                  {r.description && <p className="mt-1 pl-6 text-[13px] text-ink-2">{r.description}</p>}
                </li>
              ))}
            </ul>
            <PaginationFooter state={results.repositories.state} noun="repositories" basePath="/search" params={params} paramKey="repos" label="Repository result pages" />
          </Card>
        )}

        {results.tags.state.total > 0 && (
          <Card>
            <CardHeader
              eyebrow="References"
              title={`Tags (${results.tags.state.total.toLocaleString("en-US")})`}
              description="Search org/repo:tag to narrow down."
            />
            <ul data-search-group="tags">
              {results.tags.rows.map((t) => (
                <li key={`${t.orgSlug}/${t.repoName}:${t.tag}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 hover:bg-card-2 sm:px-5">
                  <TagIcon className="size-4 shrink-0 text-ink-3" aria-hidden />
                  <Link href={tagHref(t)} className="min-w-0 break-all font-mono text-[13px] font-medium text-ink hover:underline">
                    {t.orgSlug}/{t.repoName}:{t.tag}
                  </Link>
                  <VisibilityBadge visibility={t.visibility} />
                  <span className="font-mono text-xs text-ink-3">{shortDigest(t.digest)}</span>
                  <span className="ml-auto text-xs text-ink-3">pushed {relativeTime(t.updatedAt)}</span>
                </li>
              ))}
            </ul>
            <PaginationFooter state={results.tags.state} noun="tags" basePath="/search" params={params} paramKey="tags" label="Tag result pages" />
          </Card>
        )}

        {results.organizations.state.total > 0 && (
          <Card>
            <CardHeader eyebrow="Namespaces" title={`Organizations (${results.organizations.state.total.toLocaleString("en-US")})`} />
            <ul data-search-group="organizations">
              {results.organizations.rows.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 hover:bg-card-2 sm:px-5">
                  <EntityLogo
                    kind="organization"
                    name={o.name}
                    logo={logoRef("organization", o.id, o.logoVersion)}
                    size={20}
                    fallback={<Building2 className="size-4 text-ink-3" />}
                  />
                  <Link href={`/${o.slug}`} className="font-medium text-ink hover:underline">
                    {o.name}
                  </Link>
                  <span className="font-mono text-xs text-ink-3">{o.slug}</span>
                  {o.member && <Badge tone="info">member</Badge>}
                  <span className="ml-auto text-xs text-ink-3">
                    {o.repoCount} repositor{o.repoCount === 1 ? "y" : "ies"}
                  </span>
                </li>
              ))}
            </ul>
            <PaginationFooter state={results.organizations.state} noun="organizations" basePath="/search" params={params} paramKey="orgs" label="Organization result pages" />
          </Card>
        )}
      </div>
    </>
  );
}
