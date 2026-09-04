// Identifying personal access tokens and service-account credentials: shared
// by the docker token endpoint and the jobs API. Enforces expiry, resolves the
// token's organization / repository restriction, and records the last use
// (time and client address, at most once per five minutes per credential).
import { eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { accessTokens, serviceAccounts, user as userTable } from "@/db/schema";
import { findServiceAccountByHash, type Caller } from "./access";
import { hashSecret } from "./secrets";
import { isExpired, normalizeRestriction } from "./token-policy-shared";

const TOUCH_INTERVAL = "5 minutes";

/** Record a use of a personal access token; skipped when the last one is younger than five minutes. */
export function touchAccessToken(id: string, ip: string | null): void {
  db.update(accessTokens)
    .set({ lastUsedAt: new Date(), lastUsedIp: ip?.slice(0, 64) ?? null })
    .where(
      sql`${accessTokens.id} = ${id} AND (${accessTokens.lastUsedAt} IS NULL OR ${accessTokens.lastUsedAt} < now() - interval '${sql.raw(TOUCH_INTERVAL)}')`,
    )
    .catch((err) => console.error("access token touch failed:", err));
}

/** Same for a service account credential. */
export function touchServiceAccount(id: string, ip: string | null): void {
  db.update(serviceAccounts)
    .set({ lastUsedAt: new Date(), lastUsedIp: ip?.slice(0, 64) ?? null })
    .where(
      sql`${serviceAccounts.id} = ${id} AND (${serviceAccounts.lastUsedAt} IS NULL OR ${serviceAccounts.lastUsedAt} < now() - interval '${sql.raw(TOUCH_INTERVAL)}')`,
    )
    .catch((err) => console.error("service account touch failed:", err));
}

export type IdentifiedPat = {
  caller: Extract<Caller, { kind: "user" }>;
  token: typeof accessTokens.$inferSelect;
  user: typeof userTable.$inferSelect;
};

/**
 * Resolve a chc_pat_… secret to its owner. Refuses expired tokens and banned
 * or missing accounts; on success records the use.
 */
export async function identifyAccessToken(secret: string, ip: string | null): Promise<IdentifiedPat | { error: string }> {
  const pat = await db.query.accessTokens.findFirst({ where: eq(accessTokens.tokenHash, hashSecret(secret)) });
  if (!pat) return { error: "unknown access token" };
  if (isExpired(pat.expiresAt)) return { error: "access token expired" };
  const u = await db.query.user.findFirst({ where: eq(userTable.id, pat.userId) });
  if (!u || u.banned) return { error: "account unavailable" };
  touchAccessToken(pat.id, ip);
  return {
    token: pat,
    user: u,
    caller: {
      kind: "user",
      userId: u.id,
      isAdmin: u.role === "admin",
      patScope: pat.scope,
      restriction: normalizeRestriction(pat.organizationId, pat.repositoryIds),
    },
  };
}

/** Resolve a chc_sa_… secret; refuses expired credentials and records the use. */
export async function identifyServiceAccount(secret: string, ip: string | null): Promise<Extract<Caller, { kind: "sa" }> | { error: string }> {
  const sa = await findServiceAccountByHash(hashSecret(secret));
  if (!sa) return { error: "unknown service account credential" };
  if (isExpired(sa.expiresAt)) return { error: "service account credential expired" };
  touchServiceAccount(sa.id, ip);
  return {
    kind: "sa",
    saId: sa.id,
    organizationId: sa.organizationId,
    permission: sa.permission,
    repositoryIds: sa.repositoryIds ?? null,
  };
}

/** Rows a maintenance job or the admin overview needs: credentials expiring within `days`. */
export async function expiringCredentials(days: number, now: Date = new Date()) {
  const until = new Date(now.getTime() + days * 24 * 3600 * 1000);
  const [pats, sas] = await Promise.all([
    db.query.accessTokens.findMany({
      where: sql`${accessTokens.expiresAt} > ${now} AND ${accessTokens.expiresAt} <= ${until}`,
    }),
    db.query.serviceAccounts.findMany({
      where: sql`${serviceAccounts.expiresAt} > ${now} AND ${serviceAccounts.expiresAt} <= ${until}`,
    }),
  ]);
  return { pats, sas };
}

/** Counts for the admin overview card. */
export async function credentialStats(now: Date = new Date()) {
  const soon = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const expiringWhere = (col: typeof accessTokens.expiresAt | typeof serviceAccounts.expiresAt) =>
    sql`${col} > ${now} AND ${col} <= ${soon}`;
  const [patExpiring, saExpiring, patNever, saNever, patExpired, saExpired] = await Promise.all([
    db.$count(accessTokens, expiringWhere(accessTokens.expiresAt)),
    db.$count(serviceAccounts, expiringWhere(serviceAccounts.expiresAt)),
    db.$count(accessTokens, isNull(accessTokens.expiresAt)),
    db.$count(serviceAccounts, isNull(serviceAccounts.expiresAt)),
    db.$count(accessTokens, lt(accessTokens.expiresAt, now)),
    db.$count(serviceAccounts, lt(serviceAccounts.expiresAt, now)),
  ]);
  void or;
  return {
    expiringSoon: patExpiring + saExpiring,
    neverExpiring: patNever + saNever,
    expired: patExpired + saExpired,
    tokens: { expiringSoon: patExpiring, neverExpiring: patNever, expired: patExpired },
    serviceAccounts: { expiringSoon: saExpiring, neverExpiring: saNever, expired: saExpired },
  };
}
