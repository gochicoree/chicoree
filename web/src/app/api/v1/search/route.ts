// GET /api/v1/search?q=… — repositories, tags, digests and organizations the caller may see.
import { route } from "@/lib/api/handler";
import { badRequest, forbidden, json, paged, pageParams } from "@/lib/api/respond";
import { absolute, repoJson } from "@/lib/api/serialize";
import { iso } from "@/lib/api/respond";
import { repoHref } from "@/lib/proxy-shared";
import { searchDigestsPage, searchOrganizationsPage, searchRepositoriesPage, searchTagsPage } from "@/lib/search";
import { normalizeQuery, SEARCH_MIN_TYPEAHEAD } from "@/lib/search-shared";
import { paginate } from "@/lib/paginate-shared";

export const dynamic = "force-dynamic";

const TYPES = ["repositories", "tags", "digests", "organizations"] as const;
type SearchType = (typeof TYPES)[number];

export const GET = route(async (_req, { caller, url }) => {
  const q = normalizeQuery(url.searchParams.get("q"));
  if (q.length < SEARCH_MIN_TYPEAHEAD) throw badRequest(`"q" must be at least ${SEARCH_MIN_TYPEAHEAD} characters.`);
  // Search spans the whole registry; a token limited to one organization cannot use it.
  if (caller.kind === "user" && caller.caller.restriction) throw forbidden("This access token is limited to one organization; search spans the whole registry.");
  const typeParam = url.searchParams.get("type");
  if (typeParam && !TYPES.includes(typeParam as SearchType)) throw badRequest(`"type" must be one of ${TYPES.join(", ")}.`);
  const only = (typeParam as SearchType | null) ?? null;
  const { page, pageSize } = pageParams(url, { defaultSize: 20 });
  const wanted = (t: SearchType) => !only || only === t;
  // Service accounts search as anonymous callers: public repositories only.
  const viewer = caller.viewer;
  const skip = { rows: [], state: paginate(0, 1, pageSize) };

  const [repositories, tags, digests, organizations] = await Promise.all([
    wanted("repositories") ? searchRepositoriesPage(viewer, { q, sort: "pulls", page, pageSize }) : skip,
    wanted("tags") ? searchTagsPage(viewer, q, { page, pageSize }) : skip,
    wanted("digests") ? searchDigestsPage(viewer, q, { page, pageSize }) : skip,
    wanted("organizations") ? searchOrganizationsPage(viewer, q, { page, pageSize }) : skip,
  ]);
  return json({
    q,
    total: repositories.state.total + tags.state.total + digests.state.total + organizations.state.total,
    repositories: paged(repositories.rows.map((r) => repoJson(r)), repositories.state),
    tags: paged(
      tags.rows.map((t) => ({
        organization: t.orgSlug,
        repository: t.repoName,
        tag: t.tag,
        digest: t.digest,
        pushedAt: iso(t.updatedAt),
        visibility: t.visibility,
        url: absolute(`${repoHref(t.orgSlug, t.repoName)}/tags/${encodeURIComponent(t.tag)}`),
      })),
      tags.state,
    ),
    digests: paged(
      digests.rows.map((d) => ({
        organization: d.orgSlug,
        repository: d.repoName,
        digest: d.digest,
        mediaType: d.mediaType,
        tags: d.tags,
        pushedAt: iso(d.createdAt),
        visibility: d.visibility,
        url: absolute(`${repoHref(d.orgSlug, d.repoName)}/tags/${encodeURIComponent(d.digest)}`),
      })),
      digests.state,
    ),
    organizations: paged(
      organizations.rows.map((o) => ({ id: o.id, slug: o.slug, name: o.name, repositoryCount: o.repoCount, member: o.member, url: absolute(`/${o.slug}`) })),
      organizations.state,
    ),
  });
});
