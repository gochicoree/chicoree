// Security dashboards and CVE search over the scan_findings side table, plus
// the vulnerability exceptions (accepted risks). Tagged images are what
// counts: every tag's manifest and, for multi-arch indexes, their platform
// children, deduplicated by digest.
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { organization, repositories, vulnerabilityExceptions } from "@/db/schema";
import { refreshOrganizationBlocks, refreshRepositoryBlocks } from "./pull-policy";
import { PAGE_SIZES, paginate, paginatedQuery, type PageState } from "./paginate-shared";
import { SEVERITY_ORDER, type Severity } from "./scanner-shared";

/** Tag → manifest digest, plus tag → index child digests. */
const TAGGED_CTE = sql`
  tagged AS (
    SELECT t.repository_id, t.name AS tag, t.manifest_digest AS tag_digest, t.manifest_digest AS digest
    FROM tags t
    UNION
    SELECT t.repository_id, t.name, t.manifest_digest, mr.ref_digest
    FROM tags t
    JOIN manifest_refs mr ON mr.repository_id = t.repository_id AND mr.manifest_digest = t.manifest_digest
    JOIN manifests c ON c.repository_id = mr.repository_id AND c.digest = mr.ref_digest
  )`;

/** An active exception of the repository's organization covers this scan_findings row (alias sf, repository alias r). */
const EXCEPTED = sql`EXISTS (
  SELECT 1 FROM vulnerability_exceptions ve
  WHERE ve.organization_id = r.organization_id
    AND (ve.repository_id IS NULL OR ve.repository_id = r.id)
    AND lower(ve.vulnerability_id) = lower(sf.vulnerability_id)
    AND (ve.package IS NULL OR ve.package = sf.package)
    AND (ve.expires_at IS NULL OR ve.expires_at > now()))`;

const SEVERITY_RANK_SQL = sql`CASE sf.severity WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 WHEN 'Negligible' THEN 4 ELSE 5 END`;

function orgFilter(organizationId: string | null): SQL {
  return organizationId ? sql`r.organization_id = ${organizationId}` : sql`TRUE`;
}

export interface SecurityTotals {
  /** Findings no exception accepts, per severity, deduplicated by digest. */
  summary: Record<Severity, number>;
  /** Findings an exception accepts. */
  accepted: number;
  /** Tagged single-platform images by scan state. */
  images: { scanned: number; unscanned: number; failed: number };
  blocked: number;
}

export interface WorstRepository {
  id: string;
  name: string;
  orgSlug: string;
  orgName: string;
  visibility: string;
  images: number;
  summary: Record<Severity, number>;
}

export interface BlockedImage {
  repositoryId: string;
  digest: string;
  reason: string;
  createdAt: Date;
  repoName: string;
  orgSlug: string;
  tags: string[];
}

export interface ExceptionView {
  id: string;
  organizationId: string;
  orgSlug: string;
  orgName: string;
  repositoryId: string | null;
  repoName: string | null;
  vulnerabilityId: string;
  package: string | null;
  justification: string;
  expiresAt: Date | null;
  expired: boolean;
  createdAt: Date;
  createdBy: string | null;
  createdByLabel: string | null;
  /** Findings in tagged images this exception currently covers. */
  covers: number;
}

function summaryFromRows(rows: Record<string, unknown>[]): Record<Severity, number> {
  const out = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  for (const r of rows) {
    const sev = String(r.severity) as Severity;
    if (SEVERITY_ORDER.includes(sev)) out[sev] = Number(r.n);
  }
  return out;
}

export async function securityTotals(organizationId: string | null): Promise<SecurityTotals> {
  const where = orgFilter(organizationId);
  const [bySeverity, accepted, images, blocked] = await Promise.all([
    db.execute(sql`
      WITH ${TAGGED_CTE}
      SELECT x.severity, count(*)::int AS n FROM (
        SELECT DISTINCT sf.digest, sf.vulnerability_id, sf.package, sf.version, sf.severity
        FROM tagged tg
        JOIN repositories r ON r.id = tg.repository_id
        JOIN scan_findings sf ON sf.digest = tg.digest
        WHERE ${where} AND NOT ${EXCEPTED}) x
      GROUP BY x.severity`),
    db.execute(sql`
      WITH ${TAGGED_CTE}
      SELECT count(*)::int AS n FROM (
        SELECT DISTINCT sf.digest, sf.vulnerability_id, sf.package, sf.version
        FROM tagged tg
        JOIN repositories r ON r.id = tg.repository_id
        JOIN scan_findings sf ON sf.digest = tg.digest
        WHERE ${where} AND ${EXCEPTED}) x`),
    db.execute(sql`
      WITH ${TAGGED_CTE}
      SELECT count(DISTINCT tg.digest) FILTER (WHERE vs.status = 'scanned')::int AS scanned,
             count(DISTINCT tg.digest) FILTER (WHERE vs.status IS NULL OR vs.status IN ('pending', 'indexing'))::int AS unscanned,
             count(DISTINCT tg.digest) FILTER (WHERE vs.status = 'failed')::int AS failed
      FROM tagged tg
      JOIN repositories r ON r.id = tg.repository_id
      JOIN manifests m ON m.repository_id = tg.repository_id AND m.digest = tg.digest
      LEFT JOIN vulnerability_scans vs ON vs.digest = tg.digest
      WHERE ${where} AND m.media_type NOT LIKE '%index%' AND m.media_type NOT LIKE '%list%'`),
    db.execute(sql`
      SELECT count(*)::int AS n FROM manifest_blocks mb JOIN repositories r ON r.id = mb.repository_id WHERE ${where}`),
  ]);
  const im = images.rows[0] ?? {};
  return {
    summary: summaryFromRows(bySeverity.rows as Record<string, unknown>[]),
    accepted: Number(accepted.rows[0]?.n ?? 0),
    images: { scanned: Number(im.scanned ?? 0), unscanned: Number(im.unscanned ?? 0), failed: Number(im.failed ?? 0) },
    blocked: Number(blocked.rows[0]?.n ?? 0),
  };
}

export async function worstRepositories(organizationId: string | null, limit = 10): Promise<WorstRepository[]> {
  const { rows } = await db.execute(sql`
    WITH ${TAGGED_CTE},
    x AS (
      SELECT DISTINCT tg.repository_id, sf.digest, sf.vulnerability_id, sf.package, sf.version, sf.severity
      FROM tagged tg
      JOIN repositories r ON r.id = tg.repository_id
      JOIN scan_findings sf ON sf.digest = tg.digest
      WHERE ${orgFilter(organizationId)} AND NOT ${EXCEPTED})
    SELECT r.id, r.name, r.visibility, o.slug AS org_slug, o.name AS org_name,
           count(DISTINCT x.digest)::int AS images,
           count(*) FILTER (WHERE x.severity = 'Critical')::int AS critical,
           count(*) FILTER (WHERE x.severity = 'High')::int AS high,
           count(*) FILTER (WHERE x.severity = 'Medium')::int AS medium,
           count(*) FILTER (WHERE x.severity = 'Low')::int AS low,
           count(*) FILTER (WHERE x.severity = 'Negligible')::int AS negligible,
           count(*) FILTER (WHERE x.severity = 'Unknown')::int AS unknown
    FROM x
    JOIN repositories r ON r.id = x.repository_id
    JOIN organization o ON o.id = r.organization_id
    GROUP BY r.id, r.name, r.visibility, o.slug, o.name
    ORDER BY critical DESC, high DESC, medium DESC, low DESC, unknown DESC, r.name
    LIMIT ${limit}`);
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    orgSlug: r.org_slug as string,
    orgName: r.org_name as string,
    visibility: r.visibility as string,
    images: Number(r.images),
    summary: {
      Critical: Number(r.critical),
      High: Number(r.high),
      Medium: Number(r.medium),
      Low: Number(r.low),
      Negligible: Number(r.negligible),
      Unknown: Number(r.unknown),
    },
  }));
}

/** One page of blocked images, newest first, plus how many there are. */
export async function blockedImages(
  organizationId: string | null,
  page = 1,
  pageSize = PAGE_SIZES.blockedImages,
): Promise<{ rows: BlockedImage[]; state: PageState }> {
  const where = orgFilter(organizationId);
  return paginatedQuery<BlockedImage>({
    page,
    pageSize,
    count: async () => {
      const { rows } = await db.execute(sql`
        SELECT count(*)::int AS n FROM manifest_blocks mb
        JOIN repositories r ON r.id = mb.repository_id
        WHERE ${where}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
        SELECT mb.repository_id, mb.digest, mb.reason, mb.created_at, r.name AS repo_name, o.slug AS org_slug,
               (SELECT string_agg(t.name, ',' ORDER BY t.name) FROM tags t WHERE t.repository_id = mb.repository_id AND t.manifest_digest = mb.digest) AS tags
        FROM manifest_blocks mb
        JOIN repositories r ON r.id = mb.repository_id
        JOIN organization o ON o.id = r.organization_id
        WHERE ${where}
        ORDER BY mb.created_at DESC LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((r) => ({
        repositoryId: r.repository_id as string,
        digest: r.digest as string,
        reason: r.reason as string,
        createdAt: new Date(r.created_at as string),
        repoName: r.repo_name as string,
        orgSlug: r.org_slug as string,
        tags: r.tags ? String(r.tags).split(",") : [],
      }));
    },
  });
}

/** One page of accepted risks, newest first, plus how many there are. */
export async function listExceptions(
  organizationId: string | null,
  opts: { repositoryId?: string | null; page?: number; pageSize?: number } = {},
): Promise<{ rows: ExceptionView[]; state: PageState }> {
  const scope = opts.repositoryId
    ? sql`(ve.repository_id IS NULL OR ve.repository_id = ${opts.repositoryId})`
    : sql`TRUE`;
  const where = sql`${organizationId ? sql`ve.organization_id = ${organizationId}` : sql`TRUE`} AND ${scope}`;
  return paginatedQuery<ExceptionView>({
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? PAGE_SIZES.exceptions,
    count: async () => {
      const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM vulnerability_exceptions ve WHERE ${where}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
    WITH ${TAGGED_CTE}
    SELECT ve.*, o.slug AS org_slug, o.name AS org_name, r.name AS repo_name, u.email AS created_by_email, u.name AS created_by_name,
           (SELECT count(*) FROM (
              SELECT DISTINCT sf.digest, sf.vulnerability_id, sf.package, sf.version
              FROM scan_findings sf
              JOIN tagged tg ON tg.digest = sf.digest
              JOIN repositories rr ON rr.id = tg.repository_id
              WHERE rr.organization_id = ve.organization_id
                AND (ve.repository_id IS NULL OR rr.id = ve.repository_id)
                AND lower(sf.vulnerability_id) = lower(ve.vulnerability_id)
                AND (ve.package IS NULL OR sf.package = ve.package)) c)::int AS covers
    FROM vulnerability_exceptions ve
    JOIN organization o ON o.id = ve.organization_id
    LEFT JOIN repositories r ON r.id = ve.repository_id
    LEFT JOIN "user" u ON u.id = ve.created_by
    WHERE ${where}
    ORDER BY ve.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((r) => {
    const expiresAt = r.expires_at ? new Date(r.expires_at as string) : null;
    return {
      id: r.id as string,
      organizationId: r.organization_id as string,
      orgSlug: r.org_slug as string,
      orgName: r.org_name as string,
      repositoryId: (r.repository_id as string | null) ?? null,
      repoName: (r.repo_name as string | null) ?? null,
      vulnerabilityId: r.vulnerability_id as string,
      package: (r.package as string | null) ?? null,
      justification: r.justification as string,
      expiresAt,
      expired: !!expiresAt && expiresAt.getTime() <= Date.now(),
      createdAt: new Date(r.created_at as string),
      createdBy: (r.created_by as string | null) ?? null,
      createdByLabel: (r.created_by_name as string | null) ?? (r.created_by_email as string | null) ?? null,
      covers: Number(r.covers ?? 0),
        };
      });
    },
  });
}

export interface FindingHit {
  orgSlug: string;
  repoName: string;
  repositoryId: string;
  tag: string;
  /** The tag's own digest (index or image). */
  tagDigest: string;
  /** The scanned image digest (an index child when the tag is multi-arch). */
  digest: string;
  vulnerabilityId: string;
  package: string;
  version: string;
  fixedIn: string | null;
  severity: Severity;
  scanner: string | null;
  accepted: boolean;
  blocked: string | null;
}

/**
 * One page of the tagged images that contain a vulnerability id or a package
 * (substring, case-insensitive), most severe first, plus the match count.
 */
export async function searchFindings(
  query: string,
  organizationId: string | null,
  page = 1,
  pageSize = PAGE_SIZES.cveSearch,
): Promise<{ rows: FindingHit[]; state: PageState }> {
  const q = query.trim();
  if (!q) return { rows: [], state: paginate(0, 1, pageSize) };
  const like = `%${q}%`;
  const match = sql`(sf.vulnerability_id ILIKE ${like} OR sf.package ILIKE ${like}) AND ${orgFilter(organizationId)}`;
  return paginatedQuery<FindingHit>({
    page,
    pageSize,
    count: async () => {
      const { rows } = await db.execute(sql`
        WITH ${TAGGED_CTE}
        SELECT count(*)::int AS n
        FROM scan_findings sf
        JOIN tagged tg ON tg.digest = sf.digest
        JOIN repositories r ON r.id = tg.repository_id
        WHERE ${match}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
    WITH ${TAGGED_CTE}
    SELECT o.slug AS org_slug, r.name AS repo_name, r.id AS repository_id, tg.tag, tg.tag_digest, sf.digest,
           sf.vulnerability_id, sf.package, sf.version, sf.fixed_in, sf.severity, vs.scanner,
           ${EXCEPTED} AS accepted, mb.reason AS blocked
    FROM scan_findings sf
    JOIN tagged tg ON tg.digest = sf.digest
    JOIN repositories r ON r.id = tg.repository_id
    JOIN organization o ON o.id = r.organization_id
    LEFT JOIN vulnerability_scans vs ON vs.digest = sf.digest
    LEFT JOIN manifest_blocks mb ON mb.repository_id = tg.repository_id AND mb.digest = tg.tag_digest
    WHERE ${match}
    ORDER BY ${SEVERITY_RANK_SQL}, o.slug, r.name, tg.tag, sf.package
    LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((r) => ({
        orgSlug: r.org_slug as string,
        repoName: r.repo_name as string,
        repositoryId: r.repository_id as string,
        tag: r.tag as string,
        tagDigest: r.tag_digest as string,
        digest: r.digest as string,
        vulnerabilityId: r.vulnerability_id as string,
        package: r.package as string,
        version: (r.version as string) ?? "",
        fixedIn: (r.fixed_in as string | null) ?? null,
        severity: r.severity as Severity,
        scanner: (r.scanner as string | null) ?? null,
        accepted: r.accepted === true,
        blocked: (r.blocked as string | null) ?? null,
      }));
    },
  });
}

// --- Exceptions ---------------------------------------------------------------------

export interface NewException {
  organizationId: string;
  repositoryId: string | null;
  vulnerabilityId: string;
  package: string | null;
  justification: string;
  expiresAt: Date | null;
  createdBy: string | null;
}

/** Store an accepted risk and recompute the pull blocks it affects. */
export async function createException(input: NewException) {
  const [row] = await db.insert(vulnerabilityExceptions).values(input).returning();
  if (input.repositoryId) await refreshRepositoryBlocks(input.repositoryId);
  else await refreshOrganizationBlocks(input.organizationId);
  return row;
}

/** Revoke an exception; returns the deleted row (blocks are recomputed). */
export async function deleteException(id: string) {
  const [row] = await db.delete(vulnerabilityExceptions).where(eq(vulnerabilityExceptions.id, id)).returning();
  if (!row) return null;
  if (row.repositoryId) await refreshRepositoryBlocks(row.repositoryId);
  else await refreshOrganizationBlocks(row.organizationId);
  return row;
}

/**
 * Exceptions that expired take effect only when blocks are recomputed:
 * recompute every organization holding an expired exception, then drop
 * exceptions that expired more than 30 days ago.
 */
export async function expireExceptions(): Promise<{ organizations: number; deleted: number }> {
  const { rows } = await db.execute(sql`
    SELECT DISTINCT organization_id FROM vulnerability_exceptions WHERE expires_at IS NOT NULL AND expires_at <= now()`);
  for (const r of rows) await refreshOrganizationBlocks(r.organization_id as string);
  const deleted = await db.execute(sql`
    DELETE FROM vulnerability_exceptions WHERE expires_at IS NOT NULL AND expires_at < now() - interval '30 days' RETURNING id`);
  return { organizations: rows.length, deleted: deleted.rows.length };
}

export async function orgSlugOf(organizationId: string): Promise<string | null> {
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  return org?.slug ?? null;
}

export async function repositoryOf(repositoryId: string) {
  return db.query.repositories.findFirst({ where: and(eq(repositories.id, repositoryId)) });
}
