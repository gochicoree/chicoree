import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { getSession } from "@/lib/session";
import { getBranding } from "@/lib/branding";
import { shareMetadata } from "@/lib/share";
import { searchRepositories, searchRepositoriesPage, type RepoSort } from "@/lib/search";
import { exploreOrganizations, trendingRepositories, TRENDING_DAYS } from "@/lib/explore";
import { normalizeQuery } from "@/lib/search-shared";
import { viewerFromSession } from "@/lib/viewer";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/ui/pagination";
import { buttonClasses } from "@/components/ui/button";
import { PAGE_SIZES, pageParam } from "@/lib/paginate-shared";
import { RepoTable } from "@/components/repo-table";
import { ExploreFilters } from "./explore-filters";
import { OrgGrid, OrgHeader, Section, TrendingGrid } from "./sections";

export async function generateMetadata(): Promise<Metadata> {
  const b = await getBranding();
  return shareMetadata({
    title: "Explore",
    description: `Public container images and Helm charts on ${b.instanceName}: what is pulled this week, who publishes and what changed.`,
    url: "/explore",
    withSiteName: true,
  });
}

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Two faces: the overview (what is pulled this week, who publishes, what
 * changed) when nothing is filtered, and the filterable list once a query,
 * organization, visibility, sort, page or `view=all` is in the URL. An
 * organization card drills down into the list for that organization.
 */
export default async function ExplorePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const q = normalizeQuery(one(params.q));
  const org = one(params.org).trim();
  const visibilityParam = one(params.visibility);
  const visibility = visibilityParam === "public" || visibilityParam === "private" ? visibilityParam : undefined;
  const sortParam = one(params.sort);
  const sort: RepoSort = sortParam === "updated" || sortParam === "name" ? sortParam : "pulls";
  const listMode = !!(q || org || visibility || sortParam || one(params.page) || one(params.view) === "all");

  const session = await getSession();
  const viewer = viewerFromSession(session);
  const orgs = await exploreOrganizations(viewer);
  const filterOrgs = orgs.map((o) => ({ slug: o.slug, name: o.name }));
  const showVisibility = viewer.kind === "user";
  const description = viewer.kind === "user" ? "Public images, plus the private ones you can see." : "Public images on this registry.";
  const filterValue = { q, org, visibility: visibility ?? "all", sort, view: listMode ? "all" : "" };

  if (!listMode) {
    const [trending, recent] = await Promise.all([trendingRepositories(viewer, 8), searchRepositories(viewer, { sort: "updated", limit: 8 })]);
    const total = orgs.reduce((n, o) => n + o.repoCount, 0);
    return (
      <>
        <PageHeader eyebrow="Browse" title="Explore" description={description} />
        <ExploreFilters value={filterValue} orgs={filterOrgs} showVisibility={showVisibility} />
        {total === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-3" data-explore-empty>
            No public repositories yet. Make a repository public in its settings and it will appear here.
          </p>
        ) : (
          <>
            {trending.length > 0 && (
              <Section title="Trending" hint={`Most pulled in the last ${TRENDING_DAYS} days`}>
                <TrendingGrid repos={trending} />
              </Section>
            )}
            <Section title="Organizations" hint={`${orgs.length} ${orgs.length === 1 ? "organization publishes" : "organizations publish"} ${total} ${total === 1 ? "image" : "images"}`}>
              <OrgGrid orgs={orgs} hrefFor={(o) => `/explore?org=${encodeURIComponent(o.slug)}`} />
            </Section>
            <Section
              title="Recently updated"
              action={
                <Link href="/explore?view=all" className={buttonClasses("secondary")}>
                  All images <ArrowRight className="size-4" />
                </Link>
              }
            >
              <RepoTable repos={recent} showOrg />
            </Section>
          </>
        )}
      </>
    );
  }

  const repos = await searchRepositoriesPage(viewer, {
    q,
    orgSlug: org || undefined,
    visibility,
    sort,
    page: pageParam(params),
    pageSize: PAGE_SIZES.explore,
  });
  const drilled = org ? orgs.find((o) => o.slug === org) : undefined;
  const filtered = !!(q || org || visibility);

  return (
    <>
      <PageHeader eyebrow="Browse" title={drilled ? `Images in ${drilled.name}` : "All images"} description={description} />
      <ExploreFilters value={filterValue} orgs={filterOrgs} showVisibility={showVisibility} />
      {drilled && <OrgHeader org={drilled} count={repos.state.total} />}
      {repos.state.total === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-3" data-explore-empty>
          {filtered ? "No repositories match these filters." : "No public repositories yet. Make a repository public in its settings and it will appear here."}
        </p>
      ) : (
        <div data-explore-results data-sort={sort} data-count={repos.state.total}>
          <RepoTable repos={repos.rows} showOrg={!drilled} />
          <Pagination state={repos.state} noun="repositories" basePath="/explore" params={params} label="Repository pages" className="mt-3" />
        </div>
      )}
    </>
  );
}
