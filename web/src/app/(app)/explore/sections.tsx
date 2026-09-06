import Link from "next/link";
import { ArrowRight, Container, Flame, Globe } from "lucide-react";
import { EntityLogo } from "@/components/entity-logo";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import type { ExploreOrg, TrendingRepo } from "@/lib/explore";
import { formatCount, relativeTime } from "@/lib/format";
import { imagePath, isLibrary } from "@/lib/library-shared";
import { logoRef } from "@/lib/logo-shared";
import { repoHref } from "@/lib/proxy-shared";

export function Section({ title, hint, action, children }: { title: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-display text-base font-semibold">{title}</h2>
          {hint && <p className="text-xs text-ink-3">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Cards for the most pulled repositories of the week. */
export function TrendingGrid({ repos }: { repos: TrendingRepo[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {repos.map((repo, i) => (
        <li key={repo.id} className="relative flex flex-col rounded-xl border border-line bg-card p-4 shadow-card transition-colors hover:bg-card-2">
          <div className="flex items-start gap-3">
            <EntityLogo
              kind="repository"
              name={repo.name}
              logo={logoRef("repository", repo.id, repo.logoVersion)}
              size={36}
              fallback={
                <span className="flex size-full items-center justify-center rounded-lg bg-card-2 text-ink-3">
                  {repo.proxy ? <Globe className="size-4 text-accent" /> : <Container className="size-4" />}
                </span>
              }
            />
            <div className="min-w-0 flex-1">
              <Link href={repoHref(repo.orgSlug ?? "", repo.name)} className="block truncate font-medium text-ink after:absolute after:inset-0 after:rounded-xl">
                {imagePath(repo.orgSlug, repo.name)}
              </Link>
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                <span className="font-mono">#{i + 1}</span>
                {repo.visibility === "private" && <VisibilityBadge visibility="private" />}
                {repo.kind === "chart" && <Badge tone="info">chart</Badge>}
                {repo.proxy && <Badge tone="accent">cached</Badge>}
              </div>
            </div>
          </div>
          {repo.description && <p className="mt-3 line-clamp-2 text-xs text-ink-2">{repo.description}</p>}
          <dl className="mt-auto flex items-center justify-between gap-3 pt-3 text-xs text-ink-3">
            <div className="flex items-center gap-1 text-ink-2">
              <Flame className="size-3.5 text-accent" aria-hidden />
              <span className="font-mono tabular-nums">{formatCount(repo.recentPulls)}</span> this week
            </div>
            <div>
              <span className="font-mono tabular-nums">{formatCount(repo.pullCount)}</span> total
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function orgLabel(o: ExploreOrg): string {
  if (isLibrary(o.slug)) return "top-level images, no prefix";
  return `${o.slug}/`;
}

/** Cards for the organizations that publish images; each opens its images. */
export function OrgGrid({ orgs, hrefFor }: { orgs: ExploreOrg[]; hrefFor: (o: ExploreOrg) => string }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {orgs.map((o) => (
        <li key={o.id} className="relative rounded-xl border border-line bg-card p-4 shadow-card transition-colors hover:bg-card-2">
          <div className="flex items-center gap-3">
            <EntityLogo
              kind="organization"
              name={o.name}
              logo={logoRef("organization", o.id, o.logoVersion)}
              size={40}
              fallback={
                <span className="flex size-full items-center justify-center rounded-xl bg-action text-action-ink">
                  {o.proxy ? <Globe className="size-5" /> : <Container className="size-5" />}
                </span>
              }
            />
            <div className="min-w-0 flex-1">
              <Link href={hrefFor(o)} className="block truncate font-medium text-ink after:absolute after:inset-0 after:rounded-xl">
                {o.name}
              </Link>
              <div className="truncate font-mono text-xs text-ink-3">{orgLabel(o)}</div>
            </div>
            <ArrowRight className="size-4 shrink-0 text-ink-3" aria-hidden />
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-2">
            <div>
              <dt className="text-xs text-ink-3">{o.proxy ? "Cached" : "Images"}</dt>
              <dd className="font-mono text-sm tabular-nums">{formatCount(o.repoCount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Pulls, 7 days</dt>
              <dd className="font-mono text-sm tabular-nums">{formatCount(o.recentPulls)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Last push</dt>
              <dd className="text-sm">{o.lastPushedAt ? relativeTime(o.lastPushedAt) : "never"}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

/** The organization behind a drilled-down list. */
export function OrgHeader({ org, count }: { org: ExploreOrg; count: number }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-card px-4 py-3 shadow-card">
      <EntityLogo
        kind="organization"
        name={org.name}
        logo={logoRef("organization", org.id, org.logoVersion)}
        size={40}
        fallback={
          <span className="flex size-full items-center justify-center rounded-xl bg-action text-action-ink">
            {org.proxy ? <Globe className="size-5" /> : <Container className="size-5" />}
          </span>
        }
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="truncate font-display text-base font-semibold">{org.name}</h2>
          {org.proxy && <Badge tone="accent">proxy cache</Badge>}
        </div>
        <div className="font-mono text-xs text-ink-3">
          {orgLabel(org)} · {formatCount(count)} {count === 1 ? "image" : "images"} · {formatCount(org.recentPulls)} pulls this week
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href="/explore" className={buttonClasses("ghost")}>
          All organizations
        </Link>
        <Link href={`/${org.slug}`} className={buttonClasses("secondary")}>
          Organization page
        </Link>
      </div>
    </div>
  );
}
