// User lookups for instance administrators (the Administration group of
// the REST API): who an account is, which organizations it belongs to.
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { paginatedQuery, type PageState } from "@/lib/paginate-shared";
import { getOrgLimitsRow } from "@/lib/limits";
import { iso, notFound } from "./respond";

export interface UserJson {
  id: string;
  name: string;
  email: string;
  role: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  banned: boolean;
  createdAt: string | null;
}

const userSelect = sql`u.id, u.name, u.email, u.role, u.email_verified, u.two_factor_enabled, u.banned, u.created_at`;

function mapUser(r: Record<string, unknown>): UserJson {
  return {
    id: r.id as string,
    name: r.name as string,
    email: r.email as string,
    role: (r.role as string | null) ?? "user",
    emailVerified: Boolean(r.email_verified),
    twoFactorEnabled: Boolean(r.two_factor_enabled),
    banned: Boolean(r.banned),
    createdAt: iso(r.created_at as string),
  };
}

/** Exact email (case-insensitive) or a substring of name / email, paginated. */
export async function listUsers(opts: { email?: string; q?: string; page: number; pageSize: number }): Promise<{ rows: UserJson[]; state: PageState }> {
  const email = (opts.email ?? "").trim().toLowerCase();
  const term = (opts.q ?? "").trim();
  const like = `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
  const where = email ? sql`lower(u.email) = ${email}` : term ? sql`(u.name ILIKE ${like} OR u.email ILIKE ${like})` : sql`true`;
  return paginatedQuery<UserJson>({
    page: opts.page,
    pageSize: opts.pageSize,
    count: async () => {
      const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM "user" u WHERE ${where}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`SELECT ${userSelect} FROM "user" u WHERE ${where} ORDER BY u.created_at, u.id LIMIT ${limit} OFFSET ${offset}`);
      return rows.map(mapUser);
    },
  });
}

/** One user with membership counts and the label of their limits row; 404 when unknown. */
export async function userDetail(userId: string) {
  const { rows } = await db.execute(sql`
    SELECT ${userSelect},
      (SELECT count(*)::int FROM member m WHERE m.user_id = u.id) AS memberships,
      (SELECT count(*)::int FROM member m WHERE m.user_id = u.id AND m.role = 'owner') AS owned,
      (SELECT count(*)::int FROM access_tokens t WHERE t.user_id = u.id) AS tokens,
      COALESCE((SELECT l.label FROM user_limits l WHERE l.user_id = u.id), '') AS label
    FROM "user" u WHERE u.id = ${userId}`);
  const r = rows[0];
  if (!r) throw notFound("No such user.");
  return {
    ...mapUser(r),
    organizations: { owned: Number(r.owned), memberships: Number(r.memberships) },
    accessTokens: Number(r.tokens),
    label: String(r.label ?? ""),
  };
}

export interface UserOrgJson {
  id: string;
  slug: string;
  name: string;
  role: string;
  memberCount: number;
  repositoryCount: number;
  storageBytes: number;
  /** The organization's limits label (a plan name, say); empty when none. */
  label: string;
}

/** Every organization the user belongs to, with their role there. */
export async function userOrganizations(userId: string): Promise<UserOrgJson[]> {
  const { rows } = await db.execute(sql`
    SELECT o.id, o.slug, o.name, m.role,
      (SELECT count(*)::int FROM member x WHERE x.organization_id = o.id) AS member_count,
      (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id) AS repo_count,
      COALESCE((SELECT sum(size)::bigint FROM (
        SELECT DISTINCT b.digest, b.size FROM blobs b
        JOIN repository_blobs rb ON rb.blob_digest = b.digest
        JOIN repositories r ON r.id = rb.repository_id
        WHERE r.organization_id = o.id) t), 0) AS storage_bytes
    FROM member m JOIN organization o ON o.id = m.organization_id
    WHERE m.user_id = ${userId}
    ORDER BY o.slug`);
  const out: UserOrgJson[] = [];
  for (const r of rows) {
    const limits = await getOrgLimitsRow(r.id as string);
    out.push({
      id: r.id as string,
      slug: r.slug as string,
      name: r.name as string,
      role: r.role as string,
      memberCount: Number(r.member_count),
      repositoryCount: Number(r.repo_count),
      storageBytes: Number(r.storage_bytes),
      label: limits?.label ?? "",
    });
  }
  return out;
}
