// Read-side queries for the UI. Server components call these directly.
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  events,
  manifests,
  member,
  organization,
  repositories,
  tags,
  user as userTable,
  vulnerabilityScans,
} from "@/db/schema";
import type { SeveritySummary } from "@/components/severity";
import { PAGE_SIZES, paginatedQuery, type PageState } from "./paginate-shared";

export interface OrgWithMeta {
  id: string;
  name: string;
  slug: string;
  role: string;
  repoCount: number;
  storageBytes: number;
}

/** The few organizations the navigation shows, and how many there are in total. */
export interface NavOrgs {
  orgs: { id: string; name: string; slug: string }[];
  total: number;
}

/**
 * Organizations for the sidebar: the ones this user opened most recently
 * first (falling back to when they joined, then the name), capped at
 * `limit`. Deliberately light — the layout runs it on every page, unlike
 * listUserOrgs, which also sums storage.
 */
export async function listNavOrgs(userId: string, limit = 8): Promise<NavOrgs> {
  const { rows } = await db.execute(sql`
    SELECT o.id, o.name, o.slug,
      (SELECT max(v.last_visited_at)
         FROM repository_visits v
         JOIN repositories r ON r.id = v.repository_id
        WHERE v.user_id = ${userId} AND r.organization_id = o.id) AS last_seen,
      m.created_at AS joined_at,
      count(*) OVER () AS total
    FROM organization o
    JOIN member m ON m.organization_id = o.id
    WHERE m.user_id = ${userId}
    ORDER BY last_seen DESC NULLS LAST, joined_at DESC, o.name
    LIMIT ${limit}`);
  return {
    orgs: rows.map((r) => ({ id: r.id as string, name: r.name as string, slug: r.slug as string })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}

export async function listUserOrgs(userId: string): Promise<OrgWithMeta[]> {
  const { rows } = await db.execute(sql`
    SELECT o.id, o.name, o.slug, m.role,
      (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id) AS repo_count,
      COALESCE((
        SELECT sum(size)::bigint FROM (
          SELECT DISTINCT b.digest, b.size
          FROM blobs b
          JOIN repository_blobs rb ON rb.blob_digest = b.digest
          JOIN repositories r ON r.id = rb.repository_id
          WHERE r.organization_id = o.id
        ) t
      ), 0) AS storage_bytes
    FROM organization o
    JOIN member m ON m.organization_id = o.id
    WHERE m.user_id = ${userId}
    ORDER BY o.name`);
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    slug: r.slug as string,
    role: r.role as string,
    repoCount: Number(r.repo_count),
    storageBytes: Number(r.storage_bytes),
  }));
}

export interface RepoListItem {
  id: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  pullCount: number;
  updatedAt: Date;
  tagCount: number;
  sizeBytes: number;
  lastPushedAt: Date | null;
  orgSlug?: string;
  /** The organization is a proxy cache; the repository was filled from its upstream. */
  proxy: boolean;
  /** Proxy caches: the most recent upstream check of any tag in the repository. */
  lastCheckedAt: Date | null;
  /** Users who starred the repository. */
  starCount: number;
}

export const repoListSelect = sql`
  r.id, r.name, r.description, r.visibility, r.pull_count, r.updated_at, o.slug AS org_slug,
  (SELECT count(*)::int FROM repository_stars s WHERE s.repository_id = r.id) AS star_count,
  (SELECT count(*)::int FROM tags t WHERE t.repository_id = r.id) AS tag_count,
  COALESCE((SELECT sum(b.size)::bigint FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest
    WHERE rb.repository_id = r.id), 0) AS size_bytes,
  (SELECT max(m.created_at) FROM manifests m WHERE m.repository_id = r.id) AS last_pushed_at,
  EXISTS (SELECT 1 FROM organization_proxies p WHERE p.organization_id = r.organization_id) AS is_proxy,
  (SELECT max(t.proxy_checked_at) FROM tags t WHERE t.repository_id = r.id) AS last_checked_at`;

export function mapRepoRow(r: Record<string, unknown>): RepoListItem {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string) ?? "",
    visibility: r.visibility as "public" | "private",
    pullCount: Number(r.pull_count),
    updatedAt: new Date(r.updated_at as string),
    tagCount: Number(r.tag_count),
    sizeBytes: Number(r.size_bytes),
    lastPushedAt: r.last_pushed_at ? new Date(r.last_pushed_at as string) : null,
    orgSlug: r.org_slug as string,
    proxy: !!r.is_proxy,
    lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at as string) : null,
    starCount: Number(r.star_count ?? 0),
  };
}

export async function listOrgRepos(orgId: string, includePrivate: boolean): Promise<RepoListItem[]> {
  const { rows } = await db.execute(sql`
    SELECT ${repoListSelect}
    FROM repositories r JOIN organization o ON o.id = r.organization_id
    WHERE r.organization_id = ${orgId} ${includePrivate ? sql`` : sql`AND r.visibility = 'public'`}
    ORDER BY r.updated_at DESC`);
  return rows.map(mapRepoRow);
}

export interface OrgRepoTotals {
  count: number;
  sizeBytes: number;
  pullCount: number;
}

/**
 * One page of an organization's repositories (newest first) with the totals
 * the header tiles show — the count query doubles as the totals query.
 */
export async function orgReposPage(
  orgId: string,
  includePrivate: boolean,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ rows: RepoListItem[]; state: PageState; totals: OrgRepoTotals }> {
  const visibility = includePrivate ? sql`` : sql`AND r.visibility = 'public'`;
  let totals: OrgRepoTotals = { count: 0, sizeBytes: 0, pullCount: 0 };
  const { rows, state } = await paginatedQuery<RepoListItem>({
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? PAGE_SIZES.repositories,
    count: async () => {
      const { rows } = await db.execute(sql`
        SELECT count(*)::int AS n, COALESCE(sum(t.pulls), 0)::bigint AS pulls, COALESCE(sum(t.bytes), 0)::bigint AS bytes
        FROM (
          SELECT r.pull_count AS pulls,
            COALESCE((SELECT sum(b.size) FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest
              WHERE rb.repository_id = r.id), 0) AS bytes
          FROM repositories r
          WHERE r.organization_id = ${orgId} ${visibility}) t`);
      const r = rows[0] ?? {};
      totals = { count: Number(r.n ?? 0), sizeBytes: Number(r.bytes ?? 0), pullCount: Number(r.pulls ?? 0) };
      return totals.count;
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
        SELECT ${repoListSelect}
        FROM repositories r JOIN organization o ON o.id = r.organization_id
        WHERE r.organization_id = ${orgId} ${visibility}
        ORDER BY r.updated_at DESC
        LIMIT ${limit} OFFSET ${offset}`);
      return rows.map(mapRepoRow);
    },
  });
  return { rows, state, totals };
}

export async function listPublicRepos(limit = 50): Promise<RepoListItem[]> {
  const { rows } = await db.execute(sql`
    SELECT ${repoListSelect}
    FROM repositories r JOIN organization o ON o.id = r.organization_id
    WHERE r.visibility = 'public'
    ORDER BY r.pull_count DESC, r.updated_at DESC
    LIMIT ${limit}`);
  return rows.map(mapRepoRow);
}

export async function getRepoByPath(orgSlug: string, repoName: string) {
  const org = await db.query.organization.findFirst({ where: eq(organization.slug, orgSlug) });
  if (!org) return null;
  const repo = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, org.id), eq(repositories.name, repoName)),
  });
  if (!repo) return null;
  return { org, repo };
}

export interface TagListItem {
  name: string;
  manifestDigest: string;
  updatedAt: Date;
  mediaType: string | null;
  isIndex: boolean;
  sizeBytes: number | null;
  layerCount: number | null;
  scanStatus: string | null;
  scanSummary: SeveritySummary | null;
  /** Pull-policy block reason, when the registry refuses pulls of this image. */
  blocked: string | null;
  /** Proxy caches: when the upstream last confirmed this tag. */
  proxyCheckedAt: Date | null;
  /** A cosign signature from a trusted key verifies this image (manifest_signatures). */
  signed: boolean;
}

/** Tag names offered in the compare selector (a dropdown, not a list). */
export const COMPARE_TAG_LIMIT = 500;

export interface RepoTagOverview {
  /** Tags in the repository. */
  total: number;
  /** The most recently pushed tag names, capped at COMPARE_TAG_LIMIT. */
  names: string[];
  /** Digest the "latest" tag points at, when there is one. */
  latestDigest: string | null;
  /** Proxy caches: the newest upstream check of any tag. */
  lastCheckedAt: Date | null;
}

/**
 * Everything the repository page needs about the tags as a whole — the count
 * for the pager, the names for the compare selector, and the two derived
 * values the tag table used to read off the full list. One query.
 */
export async function repoTagOverview(repoId: string, nameLimit = COMPARE_TAG_LIMIT): Promise<RepoTagOverview> {
  const { rows } = await db.execute(sql`
    SELECT (SELECT count(*)::int FROM tags WHERE repository_id = ${repoId}) AS total,
      (SELECT max(manifest_digest) FROM tags WHERE repository_id = ${repoId} AND name = 'latest') AS latest_digest,
      (SELECT max(proxy_checked_at) FROM tags WHERE repository_id = ${repoId}) AS last_checked,
      COALESCE((SELECT array_agg(s.name) FROM (
        SELECT name FROM tags WHERE repository_id = ${repoId} ORDER BY updated_at DESC LIMIT ${nameLimit}
      ) s), '{}') AS names`);
  const r = rows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    names: (r.names as string[] | null) ?? [],
    latestDigest: (r.latest_digest as string | null) ?? null,
    lastCheckedAt: r.last_checked ? new Date(r.last_checked as string) : null,
  };
}

/** One page of a repository's tags, newest first, plus how many there are. */
export async function listRepoTags(
  repoId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ rows: TagListItem[]; state: PageState }> {
  return paginatedQuery<TagListItem>({
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? PAGE_SIZES.tags,
    count: async () => {
      const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM tags WHERE repository_id = ${repoId}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
    SELECT t.name, t.manifest_digest, t.updated_at, t.proxy_checked_at, m.media_type, m.size AS manifest_size,
      EXISTS (SELECT 1 FROM manifest_signatures ms WHERE ms.repository_id = t.repository_id
        AND ms.manifest_digest = t.manifest_digest AND ms.kind = 'signature' AND ms.status = 'verified') AS signed,
      (SELECT sum(b.size)::bigint FROM manifest_refs mr JOIN blobs b ON b.digest = mr.ref_digest
        WHERE mr.repository_id = t.repository_id AND mr.manifest_digest = t.manifest_digest) AS content_bytes,
      (SELECT count(*)::int FROM manifest_refs mr WHERE mr.repository_id = t.repository_id
        AND mr.manifest_digest = t.manifest_digest) AS ref_count,
      vs.status AS scan_status, vs.summary AS scan_summary, mb.reason AS blocked
    FROM tags t
    JOIN manifests m ON m.repository_id = t.repository_id AND m.digest = t.manifest_digest
    LEFT JOIN vulnerability_scans vs ON vs.digest = t.manifest_digest
    LEFT JOIN manifest_blocks mb ON mb.repository_id = t.repository_id AND mb.digest = t.manifest_digest
    WHERE t.repository_id = ${repoId}
    ORDER BY t.updated_at DESC
    LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((r) => {
        const mediaType = r.media_type as string | null;
        const isIndex = !!mediaType && (mediaType.includes("index") || mediaType.includes("list"));
        return {
          name: r.name as string,
          manifestDigest: r.manifest_digest as string,
          updatedAt: new Date(r.updated_at as string),
          mediaType,
          isIndex,
          sizeBytes: r.content_bytes != null ? Number(r.content_bytes) : null,
          layerCount: r.ref_count != null ? Math.max(Number(r.ref_count) - 1, 0) : null,
          scanStatus: (r.scan_status as string) ?? null,
          scanSummary: (r.scan_summary as SeveritySummary) ?? null,
          blocked: (r.blocked as string | null) ?? null,
          proxyCheckedAt: r.proxy_checked_at ? new Date(r.proxy_checked_at as string) : null,
          signed: Boolean(r.signed),
        };
      });
    },
  });
}

export async function getManifestWithScan(repoId: string, digest: string) {
  const m = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repoId), eq(manifests.digest, digest)),
  });
  if (!m) return null;
  const scan = await db.query.vulnerabilityScans.findFirst({
    where: eq(vulnerabilityScans.digest, digest),
  });
  return { manifest: m, scan: scan ?? null };
}

export interface DayCountRow {
  day: string;
  count: number;
}

/** Daily pull counts for the last `days` days, zero-filled. */
export async function pullSeries(opts: {
  days?: number;
  repoId?: string;
  orgId?: string;
  userId?: string;
}): Promise<DayCountRow[]> {
  const days = opts.days ?? 30;
  const scope = opts.repoId
    ? sql`AND e.repository_id = ${opts.repoId}`
    : opts.orgId
      ? sql`AND e.repository_id IN (SELECT id FROM repositories WHERE organization_id = ${opts.orgId})`
      : opts.userId
        ? sql`AND e.repository_id IN (
            SELECT r.id FROM repositories r
            JOIN member m ON m.organization_id = r.organization_id
            WHERE m.user_id = ${opts.userId})`
        : sql``;
  const { rows } = await db.execute(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.count, 0)::int AS count
    FROM generate_series(
      (now() AT TIME ZONE 'utc')::date - ${days - 1}::int,
      (now() AT TIME ZONE 'utc')::date,
      interval '1 day') AS d(day)
    LEFT JOIN (
      SELECT (e.created_at AT TIME ZONE 'utc')::date AS day, count(*) AS count
      FROM events e
      WHERE e.type = 'pull' AND e.created_at > now() - make_interval(days => ${days})
      ${scope}
      GROUP BY 1
    ) c ON c.day = d.day
    ORDER BY d.day`);
  return rows.map((r) => ({ day: r.day as string, count: Number(r.count) }));
}

// --- Traffic in bytes (repository_traffic, written by registryd) ---

type TrafficScope = { repoId?: string; orgId?: string; days?: number };

function trafficScopeSql(opts: TrafficScope) {
  return opts.repoId
    ? sql`AND t.repository_id = ${opts.repoId}`
    : opts.orgId
      ? sql`AND t.repository_id IN (SELECT id FROM repositories WHERE organization_id = ${opts.orgId})`
      : sql``;
}

/** Bytes served by registryd per day (zero-filled), for the egress chart. */
export async function egressSeries(opts: TrafficScope): Promise<DayCountRow[]> {
  const days = opts.days ?? 30;
  const { rows } = await db.execute(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(c.bytes, 0)::bigint AS count
    FROM generate_series(
      (now() AT TIME ZONE 'utc')::date - ${days - 1}::int,
      (now() AT TIME ZONE 'utc')::date,
      interval '1 day') AS d(day)
    LEFT JOIN (
      SELECT t.day, sum(t.pull_bytes) AS bytes
      FROM repository_traffic t
      WHERE t.day >= (now() AT TIME ZONE 'utc')::date - ${days - 1}::int
      ${trafficScopeSql(opts)}
      GROUP BY t.day
    ) c ON c.day = d.day
    ORDER BY d.day`);
  return rows.map((r) => ({ day: r.day as string, count: Number(r.count) }));
}

export interface TrafficSummary {
  egressBytes: number;
  ingressBytes: number;
  redirectBytes: number;
}

/** Totals over the last N days for a repository or organization. */
export async function trafficSummary(opts: TrafficScope): Promise<TrafficSummary> {
  const days = opts.days ?? 30;
  const { rows } = await db.execute(sql`
    SELECT COALESCE(sum(t.pull_bytes), 0)::bigint AS egress,
      COALESCE(sum(t.push_bytes), 0)::bigint AS ingress,
      COALESCE(sum(t.redirect_bytes), 0)::bigint AS redirect
    FROM repository_traffic t
    WHERE t.day >= (now() AT TIME ZONE 'utc')::date - ${days - 1}::int
    ${trafficScopeSql(opts)}`);
  const r = rows[0];
  return { egressBytes: Number(r?.egress ?? 0), ingressBytes: Number(r?.ingress ?? 0), redirectBytes: Number(r?.redirect ?? 0) };
}

export interface ActivityItem {
  id: number;
  type: string;
  actorType: string;
  actorName: string | null;
  repoPath: string;
  tag: string | null;
  digest: string | null;
  createdAt: Date;
}

/** One page of the push / delete feed for a repository, organization or user. */
export async function recentActivity(opts: {
  repoId?: string;
  orgId?: string;
  userId?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ rows: ActivityItem[]; state: PageState }> {
  const scope = opts.repoId
    ? sql`AND e.repository_id = ${opts.repoId}`
    : opts.orgId
      ? sql`AND r.organization_id = ${opts.orgId}`
      : opts.userId
        ? sql`AND r.organization_id IN (SELECT organization_id FROM member WHERE user_id = ${opts.userId})`
        : sql``;
  return paginatedQuery<ActivityItem>({
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? PAGE_SIZES.activity,
    count: async () => {
      const { rows } = await db.execute(sql`
        SELECT count(*)::int AS n
        FROM events e
        JOIN repositories r ON r.id = e.repository_id
        WHERE e.type IN ('push', 'delete') ${scope}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
    SELECT e.id, e.type, e.actor_type, e.tag, e.manifest_digest, e.created_at,
      o.slug || '/' || r.name AS repo_path,
      CASE e.actor_type
        WHEN 'user' THEN CASE WHEN e.actor_id = 'system' THEN 'system'
          ELSE COALESCE((SELECT u.name FROM "user" u WHERE u.id = e.actor_id), 'deleted user') END
        WHEN 'sa' THEN COALESCE((SELECT sa.name FROM service_accounts sa WHERE sa.id = e.actor_id), 'deleted service account')
        ELSE NULL
      END AS actor_name
    FROM events e
    JOIN repositories r ON r.id = e.repository_id
    JOIN organization o ON o.id = r.organization_id
    WHERE e.type IN ('push', 'delete') ${scope}
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((r) => ({
        id: Number(r.id),
        type: r.type as string,
        actorType: r.actor_type as string,
        actorName: r.actor_name as string | null,
        repoPath: r.repo_path as string,
        tag: r.tag as string | null,
        digest: r.manifest_digest as string | null,
        createdAt: new Date(r.created_at as string),
      }));
    },
  });
}

export async function instanceStats() {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM "user") AS users,
      (SELECT count(*)::int FROM organization) AS orgs,
      (SELECT count(*)::int FROM repositories) AS repos,
      (SELECT count(*)::int FROM blobs) AS blobs,
      COALESCE((SELECT sum(size)::bigint FROM blobs), 0) AS blob_bytes,
      COALESCE((SELECT sum(size)::bigint FROM (
        SELECT b.size FROM blobs b JOIN repository_blobs rb ON rb.blob_digest = b.digest
      ) t), 0) AS linked_bytes,
      (SELECT count(*)::int FROM events WHERE created_at > now() - interval '24 hours') AS events_24h`);
  const r = rows[0];
  return {
    users: Number(r.users),
    orgs: Number(r.orgs),
    repos: Number(r.repos),
    blobs: Number(r.blobs),
    blobBytes: Number(r.blob_bytes),
    logicalBytes: Number(r.linked_bytes),
    events24h: Number(r.events_24h),
  };
}

export async function listMembersWithUsers(orgId: string) {
  return db
    .select({
      id: member.id,
      role: member.role,
      createdAt: member.createdAt,
      userId: userTable.id,
      userName: userTable.name,
      userEmail: userTable.email,
    })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(eq(member.organizationId, orgId))
    .orderBy(member.createdAt);
}

/** One page of the instance's users, newest first, plus how many there are. */
export async function listAdminUsers(opts: { page?: number; pageSize?: number } = {}) {
  return paginatedQuery({
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? PAGE_SIZES.users,
    count: () => db.$count(userTable),
    rows: (limit, offset) =>
      db
        .select({
          id: userTable.id,
          name: userTable.name,
          email: userTable.email,
          role: userTable.role,
          banned: userTable.banned,
          createdAt: userTable.createdAt,
          emailVerified: userTable.emailVerified,
        })
        .from(userTable)
        .orderBy(desc(userTable.createdAt))
        .limit(limit)
        .offset(offset),
  });
}
