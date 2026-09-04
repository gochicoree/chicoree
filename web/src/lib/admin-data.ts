// Queries for the administration screens.
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { accessTokens, passkey, session, user as userTable } from "@/db/schema";
import { PAGE_SIZES, paginatedQuery, type PageState } from "./paginate-shared";
import { getOrgLimits, getOrgUsage, getUserLimits, getUserUsage } from "./quota";

export interface AdminOrgRow {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  memberCount: number;
  publicRepos: number;
  privateRepos: number;
  storageBytes: number;
  maxStorageBytes: number | null;
  maxPublicRepos: number | null;
  maxPrivateRepos: number | null;
}

/** One page of the instance's organizations by name, plus how many there are. */
export async function listAdminOrganizations(
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ rows: AdminOrgRow[]; state: PageState }> {
  return paginatedQuery<AdminOrgRow>({
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? PAGE_SIZES.organizations,
    count: async () => {
      const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM organization`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
    SELECT o.id, o.name, o.slug, o.created_at,
      (SELECT count(*)::int FROM member m WHERE m.organization_id = o.id) AS member_count,
      (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id AND r.visibility = 'public') AS public_repos,
      (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id AND r.visibility = 'private') AS private_repos,
      COALESCE((SELECT sum(size)::bigint FROM (
        SELECT DISTINCT b.digest, b.size FROM blobs b
        JOIN repository_blobs rb ON rb.blob_digest = b.digest
        JOIN repositories r ON r.id = rb.repository_id
        WHERE r.organization_id = o.id) t), 0) AS storage_bytes,
      l.max_storage_bytes, l.max_public_repos, l.max_private_repos
    FROM organization o
    LEFT JOIN organization_limits l ON l.organization_id = o.id
    ORDER BY o.name
    LIMIT ${limit} OFFSET ${offset}`);
      return rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        slug: r.slug as string,
        createdAt: new Date(r.created_at as string),
        memberCount: Number(r.member_count),
        publicRepos: Number(r.public_repos),
        privateRepos: Number(r.private_repos),
        storageBytes: Number(r.storage_bytes),
        maxStorageBytes: r.max_storage_bytes == null ? null : Number(r.max_storage_bytes),
        maxPublicRepos: r.max_public_repos == null ? null : Number(r.max_public_repos),
        maxPrivateRepos: r.max_private_repos == null ? null : Number(r.max_private_repos),
      }));
    },
  });
}

export async function getAdminUserDetail(userId: string) {
  const u = await db.query.user.findFirst({ where: eq(userTable.id, userId) });
  if (!u) return null;
  const [usage, limits, tokens, passkeys, sessions, memberships] = await Promise.all([
    getUserUsage(userId),
    getUserLimits(userId),
    db.$count(accessTokens, eq(accessTokens.userId, userId)),
    db.$count(passkey, eq(passkey.userId, userId)),
    db.$count(session, eq(session.userId, userId)),
    db.execute(sql`
      SELECT o.id, o.name, o.slug, m.role,
        (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id) AS repo_count
      FROM member m JOIN organization o ON o.id = m.organization_id
      WHERE m.user_id = ${userId}
      ORDER BY o.name`),
  ]);
  return {
    user: u,
    usage,
    limits,
    counts: { tokens, passkeys, sessions },
    memberships: memberships.rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      slug: r.slug as string,
      role: r.role as string,
      repoCount: Number(r.repo_count),
    })),
  };
}

export async function getAdminOrgDetail(orgId: string) {
  const { rows } = await db.execute(sql`SELECT id, name, slug, created_at FROM organization WHERE id = ${orgId}`);
  if (rows.length === 0) return null;
  const org = {
    id: rows[0].id as string,
    name: rows[0].name as string,
    slug: rows[0].slug as string,
    createdAt: new Date(rows[0].created_at as string),
  };
  const [usage, limits] = await Promise.all([getOrgUsage(orgId), getOrgLimits(orgId)]);
  return { org, usage, limits };
}
