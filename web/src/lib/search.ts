// Global search over repositories, tags, manifest digests and organizations,
// filtered by what the viewer may see (lib/viewer.ts). Matching is
// case-insensitive substring search (ILIKE); the pg_trgm GIN indexes on
// repositories.name / description and tags.name (see docs/wip/discovery.md)
// make it fast on big instances, but nothing here depends on them.
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { mapRepoRow, repoListSelect, type RepoListItem } from "./data";
import { formatCount, relativeTime, shortDigest } from "./format";
import { repoHref } from "./proxy-shared";
import { PAGE_SIZES, paginate, paginatedQuery, type PageState } from "./paginate-shared";
import { digestQuery, likeEscape, normalizeQuery, splitTagQuery, type SearchHit } from "./search-shared";
import { memberOfOrganizationFilter, visibleRepositoriesFilter, type Viewer } from "./viewer";

export interface TagHit {
  orgSlug: string;
  repoName: string;
  tag: string;
  digest: string;
  updatedAt: Date;
  visibility: "public" | "private";
}

export interface DigestHit {
  orgSlug: string;
  repoName: string;
  digest: string;
  mediaType: string;
  createdAt: Date;
  /** Tags in that repository pointing at the digest. */
  tags: string[];
  visibility: "public" | "private";
}

export interface OrgHit {
  id: string;
  slug: string;
  name: string;
  /** Repositories the viewer can see in it. */
  repoCount: number;
  member: boolean;
}

/** One group of the results page: the rows shown plus their page state. */
export interface SearchGroup<T> {
  rows: T[];
  state: PageState;
}

export interface SearchResults {
  q: string;
  repositories: SearchGroup<RepoListItem>;
  tags: SearchGroup<TagHit>;
  digests: SearchGroup<DigestHit>;
  organizations: SearchGroup<OrgHit>;
  /** Matches across every group, not just the pages shown. */
  total: number;
}

/** The page of each group, read from the URL by the search page. */
export interface SearchPages {
  repositories?: number;
  tags?: number;
  digests?: number;
  organizations?: number;
}

const contains = (q: string) => `%${likeEscape(q)}%`;
const startsWith = (q: string) => `${likeEscape(q)}%`;

export type RepoSort = "updated" | "pulls" | "name";

export interface RepoSearchOptions {
  q?: string;
  /** Restrict to one organization (slug). */
  orgSlug?: string;
  /** Only one visibility; default both (subject to the viewer filter). */
  visibility?: "public" | "private";
  sort?: RepoSort;
  limit?: number;
}

function repoOrder(sort: RepoSort, q: string): SQL {
  const boost = q ? sql`(r.name ILIKE ${startsWith(q)}) DESC,` : sql``;
  switch (sort) {
    case "name":
      return sql`${boost} o.slug ASC, r.name ASC`;
    case "updated":
      return sql`${boost} r.updated_at DESC, r.pull_count DESC`;
    default:
      return sql`${boost} r.pull_count DESC, r.updated_at DESC`;
  }
}

/**
 * Repositories the viewer may see, optionally filtered by a text query
 * (name, description or `org/name`), organization and visibility. This is
 * the explore page and the repository group of the search page.
 */
function repoWhere(viewer: Viewer, opts: RepoSearchOptions, q: string): SQL {
  const conditions: SQL[] = [visibleRepositoriesFilter(viewer)];
  if (q) {
    const pattern = contains(q);
    conditions.push(
      sql`(r.name ILIKE ${pattern} ESCAPE '\\' OR r.description ILIKE ${pattern} ESCAPE '\\' OR (o.slug || '/' || r.name) ILIKE ${pattern} ESCAPE '\\')`,
    );
  }
  if (opts.orgSlug) conditions.push(sql`o.slug = ${opts.orgSlug}`);
  if (opts.visibility) conditions.push(sql`r.visibility = ${opts.visibility}`);
  return sql.join(conditions, sql` AND `);
}

export async function searchRepositories(viewer: Viewer, opts: RepoSearchOptions = {}): Promise<RepoListItem[]> {
  const q = normalizeQuery(opts.q);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const { rows } = await db.execute(sql`
    SELECT ${repoListSelect}
    FROM repositories r JOIN organization o ON o.id = r.organization_id
    WHERE ${repoWhere(viewer, opts, q)}
    ORDER BY ${repoOrder(opts.sort ?? "pulls", q)}
    LIMIT ${limit}`);
  return rows.map(mapRepoRow);
}

/** One page of the same repositories, plus how many match (explore, search). */
export async function searchRepositoriesPage(
  viewer: Viewer,
  opts: RepoSearchOptions & { page?: number; pageSize?: number } = {},
): Promise<SearchGroup<RepoListItem>> {
  const q = normalizeQuery(opts.q);
  const where = repoWhere(viewer, opts, q);
  return paginatedQuery<RepoListItem>({
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? PAGE_SIZES.explore,
    count: async () => {
      const { rows } = await db.execute(sql`
        SELECT count(*)::int AS n FROM repositories r JOIN organization o ON o.id = r.organization_id WHERE ${where}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
        SELECT ${repoListSelect}
        FROM repositories r JOIN organization o ON o.id = r.organization_id
        WHERE ${where}
        ORDER BY ${repoOrder(opts.sort ?? "pulls", q)}
        LIMIT ${limit} OFFSET ${offset}`);
      return rows.map(mapRepoRow);
    },
  });
}

function tagWhere(viewer: Viewer, q: string): { where: SQL; tagQ: string } {
  const split = splitTagQuery(q);
  const tagQ = split ? split.tag : q;
  const conditions: SQL[] = [visibleRepositoriesFilter(viewer), sql`t.name ILIKE ${contains(tagQ)} ESCAPE '\\'`];
  if (split) {
    const p = contains(split.repo);
    conditions.push(sql`(r.name ILIKE ${p} ESCAPE '\\' OR (o.slug || '/' || r.name) ILIKE ${p} ESCAPE '\\')`);
  }
  return { where: sql.join(conditions, sql` AND `), tagQ };
}

function mapTagHit(r: Record<string, unknown>): TagHit {
  return {
    orgSlug: r.org_slug as string,
    repoName: r.repo_name as string,
    tag: r.tag as string,
    digest: r.manifest_digest as string,
    updatedAt: new Date(r.updated_at as string),
    visibility: r.visibility as "public" | "private",
  };
}

/** Tags whose name contains the query; `repo:tag` narrows the repository too. */
export async function searchTags(viewer: Viewer, rawQuery: string, limit = 20): Promise<TagHit[]> {
  const q = normalizeQuery(rawQuery);
  if (!q) return [];
  const { where, tagQ } = tagWhere(viewer, q);
  const { rows } = await db.execute(sql`
    SELECT t.name AS tag, t.manifest_digest, t.updated_at, r.name AS repo_name, r.visibility, o.slug AS org_slug
    FROM tags t
    JOIN repositories r ON r.id = t.repository_id
    JOIN organization o ON o.id = r.organization_id
    WHERE ${where}
    ORDER BY (t.name ILIKE ${startsWith(tagQ)} ESCAPE '\\') DESC, t.updated_at DESC
    LIMIT ${limit}`);
  return rows.map((r) => mapTagHit(r as Record<string, unknown>));
}

/** One page of matching tags, plus how many there are. */
export async function searchTagsPage(
  viewer: Viewer,
  rawQuery: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<SearchGroup<TagHit>> {
  const pageSize = opts.pageSize ?? PAGE_SIZES.search;
  const q = normalizeQuery(rawQuery);
  if (!q) return { rows: [], state: paginate(0, 1, pageSize) };
  const { where, tagQ } = tagWhere(viewer, q);
  return paginatedQuery<TagHit>({
    page: opts.page ?? 1,
    pageSize,
    count: async () => {
      const { rows } = await db.execute(sql`
        SELECT count(*)::int AS n FROM tags t
        JOIN repositories r ON r.id = t.repository_id
        JOIN organization o ON o.id = r.organization_id
        WHERE ${where}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
        SELECT t.name AS tag, t.manifest_digest, t.updated_at, r.name AS repo_name, r.visibility, o.slug AS org_slug
        FROM tags t
        JOIN repositories r ON r.id = t.repository_id
        JOIN organization o ON o.id = r.organization_id
        WHERE ${where}
        ORDER BY (t.name ILIKE ${startsWith(tagQ)} ESCAPE '\\') DESC, t.updated_at DESC
        LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((r) => mapTagHit(r as Record<string, unknown>));
    },
  });
}

function digestWhere(viewer: Viewer, rawQuery: string): SQL | null {
  const d = digestQuery(normalizeQuery(rawQuery));
  if (!d) return null;
  const pattern = d.exact ? `sha256:${d.hex}` : `sha256:${d.hex}%`;
  return sql`${d.exact ? sql`m.digest = ${pattern}` : sql`m.digest LIKE ${pattern}`} AND ${visibleRepositoriesFilter(viewer)}`;
}

function mapDigestHit(r: Record<string, unknown>): DigestHit {
  return {
    orgSlug: r.org_slug as string,
    repoName: r.repo_name as string,
    digest: r.digest as string,
    mediaType: r.media_type as string,
    createdAt: new Date(r.created_at as string),
    tags: (r.tag_names as string[]) ?? [],
    visibility: r.visibility as "public" | "private",
  };
}

const DIGEST_SELECT = sql`
    SELECT m.digest, m.media_type, m.created_at, r.name AS repo_name, r.visibility, o.slug AS org_slug,
      COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM tags t
        WHERE t.repository_id = m.repository_id AND t.manifest_digest = m.digest), '{}') AS tag_names
    FROM manifests m
    JOIN repositories r ON r.id = m.repository_id
    JOIN organization o ON o.id = r.organization_id`;

/** Manifests whose digest starts with the hex prefix (12+ characters), with the tags pointing at them. */
export async function searchDigests(viewer: Viewer, rawQuery: string, limit = 20): Promise<DigestHit[]> {
  const where = digestWhere(viewer, rawQuery);
  if (!where) return [];
  const { rows } = await db.execute(sql`${DIGEST_SELECT}
    WHERE ${where}
    ORDER BY m.created_at DESC
    LIMIT ${limit}`);
  return rows.map((r) => mapDigestHit(r as Record<string, unknown>));
}

/** One page of matching manifests, plus how many there are. */
export async function searchDigestsPage(
  viewer: Viewer,
  rawQuery: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<SearchGroup<DigestHit>> {
  const pageSize = opts.pageSize ?? PAGE_SIZES.search;
  const where = digestWhere(viewer, rawQuery);
  if (!where) return { rows: [], state: paginate(0, 1, pageSize) };
  return paginatedQuery<DigestHit>({
    page: opts.page ?? 1,
    pageSize,
    count: async () => {
      const { rows } = await db.execute(sql`
        SELECT count(*)::int AS n FROM manifests m
        JOIN repositories r ON r.id = m.repository_id
        JOIN organization o ON o.id = r.organization_id
        WHERE ${where}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`${DIGEST_SELECT}
        WHERE ${where}
        ORDER BY m.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((r) => mapDigestHit(r as Record<string, unknown>));
    },
  });
}

/**
 * Organizations by name or slug. Anonymous viewers see organizations with a
 * public repository; members see theirs; administrators everything.
 */
function orgWhere(viewer: Viewer, q: string): SQL {
  const pattern = contains(q);
  return sql`(o.name ILIKE ${pattern} ESCAPE '\\' OR o.slug ILIKE ${pattern} ESCAPE '\\')
      AND (${memberOfOrganizationFilter(viewer)}
        OR EXISTS (SELECT 1 FROM repositories r WHERE r.organization_id = o.id AND r.visibility = 'public'))`;
}

function mapOrgHit(r: Record<string, unknown>): OrgHit {
  return {
    id: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    repoCount: Number(r.repo_count),
    member: Boolean(r.is_member),
  };
}

export async function searchOrganizations(viewer: Viewer, rawQuery: string, limit = 10): Promise<OrgHit[]> {
  const q = normalizeQuery(rawQuery);
  if (!q) return [];
  const { rows } = await db.execute(sql`
    SELECT o.id, o.slug, o.name,
      (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id AND ${visibleRepositoriesFilter(viewer)}) AS repo_count,
      (${memberOfOrganizationFilter(viewer)}) AS is_member
    FROM organization o
    WHERE ${orgWhere(viewer, q)}
    ORDER BY (o.slug ILIKE ${startsWith(q)} ESCAPE '\\') DESC, is_member DESC, o.name ASC
    LIMIT ${limit}`);
  return rows.map((r) => mapOrgHit(r as Record<string, unknown>));
}

/** One page of matching organizations, plus how many there are. */
export async function searchOrganizationsPage(
  viewer: Viewer,
  rawQuery: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<SearchGroup<OrgHit>> {
  const pageSize = opts.pageSize ?? PAGE_SIZES.search;
  const q = normalizeQuery(rawQuery);
  if (!q) return { rows: [], state: paginate(0, 1, pageSize) };
  const where = orgWhere(viewer, q);
  return paginatedQuery<OrgHit>({
    page: opts.page ?? 1,
    pageSize,
    count: async () => {
      const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM organization o WHERE ${where}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
        SELECT o.id, o.slug, o.name,
          (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id AND ${visibleRepositoriesFilter(viewer)}) AS repo_count,
          (${memberOfOrganizationFilter(viewer)}) AS is_member
        FROM organization o
        WHERE ${where}
        ORDER BY (o.slug ILIKE ${startsWith(q)} ESCAPE '\\') DESC, is_member DESC, o.name ASC
        LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((r) => mapOrgHit(r as Record<string, unknown>));
    },
  });
}

/** The results page: every group, each paged on its own search parameter. */
export async function searchAll(viewer: Viewer, rawQuery: string, pages: SearchPages = {}): Promise<SearchResults> {
  const q = normalizeQuery(rawQuery);
  const empty = <T,>(): SearchGroup<T> => ({ rows: [], state: paginate(0, 1, PAGE_SIZES.search) });
  if (!q) return { q, repositories: empty(), tags: empty(), digests: empty(), organizations: empty(), total: 0 };
  const [repositories, tags, digests, organizations] = await Promise.all([
    searchRepositoriesPage(viewer, { q, sort: "pulls", page: pages.repositories, pageSize: PAGE_SIZES.search }),
    searchTagsPage(viewer, q, { page: pages.tags }),
    searchDigestsPage(viewer, q, { page: pages.digests }),
    searchOrganizationsPage(viewer, q, { page: pages.organizations }),
  ]);
  return {
    q,
    repositories,
    tags,
    digests,
    organizations,
    total: repositories.state.total + tags.state.total + digests.state.total + organizations.state.total,
  };
}

export function tagHref(hit: { orgSlug: string; repoName: string; tag: string }): string {
  return `${repoHref(hit.orgSlug, hit.repoName)}/tags/${encodeURIComponent(hit.tag)}`;
}

export function digestHref(hit: { orgSlug: string; repoName: string; digest: string }): string {
  return `${repoHref(hit.orgSlug, hit.repoName)}/tags/${encodeURIComponent(hit.digest)}`;
}

/** The typeahead: a short mixed list, best group first. */
export async function quickSearch(viewer: Viewer, rawQuery: string, limit = 8): Promise<SearchHit[]> {
  const q = normalizeQuery(rawQuery);
  if (!q) return [];
  const isDigest = !!digestQuery(q);
  const [digests, repositories, organizations, tags] = await Promise.all([
    isDigest ? searchDigests(viewer, q, limit) : Promise.resolve([]),
    isDigest ? Promise.resolve([]) : searchRepositories(viewer, { q, limit: 5, sort: "pulls" }),
    isDigest ? Promise.resolve([]) : searchOrganizations(viewer, q, 2),
    isDigest ? Promise.resolve([]) : searchTags(viewer, q, 4),
  ]);
  const hits: SearchHit[] = [
    ...digests.map<SearchHit>((d) => ({
      kind: "digest",
      label: `${d.orgSlug}/${d.repoName}@${shortDigest(d.digest)}`,
      href: digestHref(d),
      detail: d.tags.length ? `tags: ${d.tags.join(", ")}` : d.mediaType,
      meta: relativeTime(d.createdAt),
    })),
    ...repositories.map<SearchHit>((r) => ({
      kind: "repository",
      label: `${r.orgSlug}/${r.name}`,
      href: repoHref(r.orgSlug ?? "", r.name),
      detail: r.description || undefined,
      meta: `${r.visibility} · ${formatCount(r.pullCount)} pulls`,
    })),
    ...organizations.map<SearchHit>((o) => ({
      kind: "organization",
      label: o.name,
      href: `/${o.slug}`,
      detail: o.slug,
      meta: `${o.repoCount} repositor${o.repoCount === 1 ? "y" : "ies"}`,
    })),
    ...tags.map<SearchHit>((t) => ({
      kind: "tag",
      label: `${t.orgSlug}/${t.repoName}:${t.tag}`,
      href: tagHref(t),
      detail: shortDigest(t.digest),
      meta: relativeTime(t.updatedAt),
    })),
  ];
  return hits.slice(0, limit);
}

/** Organizations that have at least one repository the viewer can see (explore filter). */
export async function listVisibleOrganizations(viewer: Viewer): Promise<{ slug: string; name: string }[]> {
  const { rows } = await db.execute(sql`
    SELECT o.slug, o.name FROM organization o
    WHERE EXISTS (SELECT 1 FROM repositories r WHERE r.organization_id = o.id AND ${visibleRepositoriesFilter(viewer)})
    ORDER BY o.name`);
  return rows.map((r) => ({ slug: r.slug as string, name: r.name as string }));
}
