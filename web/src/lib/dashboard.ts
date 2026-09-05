// Read side of the dashboard: the signed-in user's organizations and what
// they themselves have been doing. Every query is scoped by membership or by
// the user; nothing here sums over the instance (that is /admin's job).
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { logoVersionSql } from "./logo";

export interface OrgOverview {
  id: string;
  name: string;
  slug: string;
  /** The user's role in this organization. */
  role: string;
  logoVersion: string | null;
  /** A proxy cache: filled by pulls, so "last push" reads as "last cached". */
  proxy: boolean;
  repoCount: number;
  memberCount: number;
  storageBytes: number;
  /** Pull events across the organization's repositories in the last 30 days. */
  pulls30d: number;
  lastPushAt: Date | null;
}

/**
 * The organizations a user belongs to, with what a member or owner wants at a
 * glance, most recently pushed-to first. `total` counts every membership so
 * the page can point to /orgs for the rest.
 */
export async function listOrgOverview(userId: string, limit = 6): Promise<{ orgs: OrgOverview[]; total: number }> {
  const { rows } = await db.execute(sql`
    SELECT o.id, o.name, o.slug, m.role, ${logoVersionSql("o.logo")} AS logo_version,
      EXISTS (SELECT 1 FROM organization_proxies p WHERE p.organization_id = o.id) AS proxy,
      (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id) AS repo_count,
      (SELECT count(*)::int FROM member mm WHERE mm.organization_id = o.id) AS member_count,
      COALESCE((
        SELECT sum(size)::bigint FROM (
          SELECT DISTINCT b.digest, b.size
          FROM blobs b
          JOIN repository_blobs rb ON rb.blob_digest = b.digest
          JOIN repositories r ON r.id = rb.repository_id
          WHERE r.organization_id = o.id
        ) t
      ), 0) AS storage_bytes,
      (SELECT count(*)::int FROM events e
        WHERE e.type = 'pull' AND e.created_at > now() - interval '30 days'
          AND e.repository_id IN (SELECT id FROM repositories WHERE organization_id = o.id)) AS pulls_30d,
      (SELECT max(e.created_at) FROM events e
        WHERE e.type = 'push'
          AND e.repository_id IN (SELECT id FROM repositories WHERE organization_id = o.id)) AS last_push_at,
      count(*) OVER () AS total
    FROM organization o
    JOIN member m ON m.organization_id = o.id
    WHERE m.user_id = ${userId}
    ORDER BY last_push_at DESC NULLS LAST, o.name
    LIMIT ${limit}`);
  return {
    orgs: rows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      slug: r.slug as string,
      role: r.role as string,
      logoVersion: (r.logo_version as string | null) ?? null,
      proxy: Boolean(r.proxy),
      repoCount: Number(r.repo_count),
      memberCount: Number(r.member_count),
      storageBytes: Number(r.storage_bytes),
      pulls30d: Number(r.pulls_30d),
      lastPushAt: r.last_push_at ? new Date(r.last_push_at as string) : null,
    })),
    total: rows.length > 0 ? Number(rows[0].total) : 0,
  };
}

export interface UserPush {
  repoId: string;
  orgSlug: string;
  repoName: string;
  visibility: "public" | "private";
  logoVersion: string | null;
  /** The tag that was pushed, or null when the push addressed a digest. */
  tag: string | null;
  digest: string | null;
  pushedAt: Date;
}

/**
 * What the user pushed lately — with their account or one of its access
 * tokens (service accounts are the organization's, not theirs). One row per
 * repository and reference, newest first, limited to the last 90 days so the
 * events table is read through its time index.
 */
export async function listUserPushes(userId: string, limit = 8): Promise<UserPush[]> {
  const { rows } = await db.execute(sql`
    SELECT * FROM (
      SELECT DISTINCT ON (e.repository_id, COALESCE(e.tag, e.manifest_digest, ''))
        r.id AS repo_id, o.slug AS org_slug, r.name AS repo_name, r.visibility,
        ${logoVersionSql("r.logo")} AS logo_version,
        e.tag, e.manifest_digest, e.created_at
      FROM events e
      JOIN repositories r ON r.id = e.repository_id
      JOIN organization o ON o.id = r.organization_id
      WHERE e.type = 'push' AND e.actor_type = 'user' AND e.actor_id = ${userId}
        AND e.created_at > now() - interval '90 days'
      ORDER BY e.repository_id, COALESCE(e.tag, e.manifest_digest, ''), e.created_at DESC
    ) p
    ORDER BY p.created_at DESC
    LIMIT ${limit}`);
  return rows.map((r) => ({
    repoId: r.repo_id as string,
    orgSlug: r.org_slug as string,
    repoName: r.repo_name as string,
    visibility: r.visibility as "public" | "private",
    logoVersion: (r.logo_version as string | null) ?? null,
    tag: (r.tag as string | null) ?? null,
    digest: (r.manifest_digest as string | null) ?? null,
    pushedAt: new Date(r.created_at as string),
  }));
}

export interface TokenSummary {
  total: number;
  /** Still valid, but expire within the next 7 days. */
  expiringSoon: number;
  expired: number;
  lastUsedAt: Date | null;
}

/** The user's own access tokens, counted for the dashboard's account card. */
export async function userTokenSummary(userId: string): Promise<TokenSummary> {
  const { rows } = await db.execute(sql`
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE expires_at > now() AND expires_at <= now() + interval '7 days')::int AS expiring_soon,
      count(*) FILTER (WHERE expires_at <= now())::int AS expired,
      max(last_used_at) AS last_used_at
    FROM access_tokens
    WHERE user_id = ${userId}`);
  const r = rows[0];
  return {
    total: Number(r?.total ?? 0),
    expiringSoon: Number(r?.expiring_soon ?? 0),
    expired: Number(r?.expired ?? 0),
    lastUsedAt: r?.last_used_at ? new Date(r.last_used_at as string) : null,
  };
}

export interface DashboardInvitation {
  id: string;
  organizationName: string;
  organizationSlug: string;
  role: string | null;
  inviterName: string | null;
  expiresAt: Date;
}

/** Organization invitations addressed to this email that can still be accepted. */
export async function listPendingInvitations(email: string): Promise<DashboardInvitation[]> {
  const { rows } = await db.execute(sql`
    SELECT i.id, i.role, i.expires_at, o.name AS organization_name, o.slug AS organization_slug,
      u.name AS inviter_name
    FROM invitation i
    JOIN organization o ON o.id = i.organization_id
    LEFT JOIN "user" u ON u.id = i.inviter_id
    WHERE lower(i.email) = lower(${email}) AND i.status = 'pending' AND i.expires_at > now()
    ORDER BY i.created_at DESC
    LIMIT 10`);
  return rows.map((r) => ({
    id: r.id as string,
    organizationName: r.organization_name as string,
    organizationSlug: r.organization_slug as string,
    role: (r.role as string | null) ?? null,
    inviterName: (r.inviter_name as string | null) ?? null,
    expiresAt: new Date(r.expires_at as string),
  }));
}
