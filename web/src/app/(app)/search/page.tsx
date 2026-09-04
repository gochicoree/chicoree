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
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { SearchBox } from "@/components/shell/search-box";
import { StarCount } from "@/components/star-button";

export const metadata: Metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const params = await searchParams;
  const q = normalizeQuery(Array.isArray(params.q) ? params.q[0] : params.q);
  const session = await getSession();
  const results = await searchAll(viewerFromSession(session), q);

  return (
    <>
      <PageHeader
        eyebrow="Search"
        title={q ? `Results for “${q}”` : "Search"}
        description={
          q
            ? `${results.total} match${results.total === 1 ? "" : "es"} across repositories, tags, digests and organizations you can see.`
            : "Find repositories by name or description, tags as org/repo:tag, images by digest prefix, and organizations."
        }
      />
      <SearchBox defaultValue={q} size="lg" autoFocus={!q} className="mb-6" placeholder="Search images, tags, digests, organizations…" />

      {q && results.total === 0 && (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-3" data-search-empty>
          Nothing matches “{q}”. Try a shorter name, an <code className="font-mono">org/repo:tag</code> reference or at least 12 hex characters of a digest.
        </p>
      )}

      <div className="space-y-6">
        {results.digests.length > 0 && (
          <Card>
            <CardHeader eyebrow="Content" title={`Digests (${results.digests.length})`} description="Manifests whose digest starts with what you typed." />
            <ul data-search-group="digests">
              {results.digests.map((d) => (
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
          </Card>
        )}

        {results.repositories.length > 0 && (
          <Card>
            <CardHeader eyebrow="Images" title={`Repositories (${results.repositories.length})`} />
            <ul data-search-group="repositories">
              {results.repositories.map((r) => (
                <li key={r.id} className="border-b border-line px-4 py-3 last:border-0 hover:bg-card-2 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Container className="size-4 shrink-0 text-ink-3" aria-hidden />
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
          </Card>
        )}

        {results.tags.length > 0 && (
          <Card>
            <CardHeader eyebrow="References" title={`Tags (${results.tags.length})`} description="Narrow the repository with org/repo:tag." />
            <ul data-search-group="tags">
              {results.tags.map((t) => (
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
          </Card>
        )}

        {results.organizations.length > 0 && (
          <Card>
            <CardHeader eyebrow="Namespaces" title={`Organizations (${results.organizations.length})`} />
            <ul data-search-group="organizations">
              {results.organizations.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 hover:bg-card-2 sm:px-5">
                  <Building2 className="size-4 shrink-0 text-ink-3" aria-hidden />
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
          </Card>
        )}
      </div>
    </>
  );
}
