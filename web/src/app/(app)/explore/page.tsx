import type { Metadata } from "next";
import { getSession } from "@/lib/session";
import { listVisibleOrganizations, searchRepositoriesPage, type RepoSort } from "@/lib/search";
import { normalizeQuery } from "@/lib/search-shared";
import { viewerFromSession } from "@/lib/viewer";
import { PageHeader } from "@/components/page-header";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, pageParam } from "@/lib/paginate-shared";
import { RepoTable } from "@/components/repo-table";
import { ExploreFilters } from "./explore-filters";

export const metadata: Metadata = { title: "Explore" };

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function ExplorePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const q = normalizeQuery(one(params.q));
  const org = one(params.org).trim();
  const visibilityParam = one(params.visibility);
  const visibility = visibilityParam === "public" || visibilityParam === "private" ? visibilityParam : undefined;
  const sortParam = one(params.sort);
  const sort: RepoSort = sortParam === "updated" || sortParam === "name" ? sortParam : "pulls";

  const session = await getSession();
  const viewer = viewerFromSession(session);
  const [repos, orgs] = await Promise.all([
    searchRepositoriesPage(viewer, {
      q,
      orgSlug: org || undefined,
      visibility,
      sort,
      page: pageParam(params),
      pageSize: PAGE_SIZES.explore,
    }),
    listVisibleOrganizations(viewer),
  ]);
  const filtered = !!(q || org || visibility);

  return (
    <>
      <PageHeader
        eyebrow="Browse"
        title="Explore images"
        description={
          viewer.kind === "user"
            ? "Every public repository on this registry, plus the private ones you have access to."
            : "Every public repository on this registry."
        }
      />
      <ExploreFilters value={{ q, org, visibility: visibility ?? "all", sort }} orgs={orgs} showVisibility={viewer.kind === "user"} />
      {repos.state.total === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sm text-ink-3" data-explore-empty>
          {filtered
            ? "No repositories match these filters."
            : "No public repositories yet. Make a repository public in its settings and it will appear here."}
        </p>
      ) : (
        <div data-explore-results data-sort={sort} data-count={repos.state.total}>
          <RepoTable repos={repos.rows} showOrg />
          <Pagination
            state={repos.state}
            noun="repositories"
            basePath="/explore"
            params={params}
            label="Repository pages"
            className="mt-3"
          />
        </div>
      )}
    </>
  );
}
