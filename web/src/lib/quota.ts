// Admin-enforced limits: how many repositories (public / private) and how
// much storage an organization — or a user, across every organization they
// own — may consume. null means unlimited. registryd enforces the same rules
// at push time (see registryd/internal/store/quota.go); this module is the
// web-side twin used by server actions and the admin screens.
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organizationLimits, userLimits } from "@/db/schema";
import { formatBytes } from "./format";

export interface Usage {
  organizations: number;
  publicRepos: number;
  privateRepos: number;
  storageBytes: number;
}

export interface Limits {
  maxOrganizations: number | null;
  maxPublicRepos: number | null;
  maxPrivateRepos: number | null;
  maxStorageBytes: number | null;
}

export const UNLIMITED: Limits = {
  maxOrganizations: null,
  maxPublicRepos: null,
  maxPrivateRepos: null,
  maxStorageBytes: null,
};

export async function getOrgUsage(orgId: string): Promise<Usage> {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM repositories WHERE organization_id = ${orgId} AND visibility = 'public') AS public_repos,
      (SELECT count(*)::int FROM repositories WHERE organization_id = ${orgId} AND visibility = 'private') AS private_repos,
      COALESCE((SELECT sum(size)::bigint FROM (
        SELECT DISTINCT b.digest, b.size FROM blobs b
        JOIN repository_blobs rb ON rb.blob_digest = b.digest
        JOIN repositories r ON r.id = rb.repository_id
        WHERE r.organization_id = ${orgId}) t), 0) AS storage_bytes`);
  const r = rows[0];
  return {
    organizations: 1,
    publicRepos: Number(r.public_repos),
    privateRepos: Number(r.private_repos),
    storageBytes: Number(r.storage_bytes),
  };
}

/** Everything in organizations where the user is an owner. */
export async function getUserUsage(userId: string): Promise<Usage> {
  const { rows } = await db.execute(sql`
    WITH owned AS (
      SELECT organization_id FROM member WHERE user_id = ${userId} AND role = 'owner'
    )
    SELECT
      (SELECT count(*)::int FROM owned) AS organizations,
      (SELECT count(*)::int FROM repositories WHERE organization_id IN (SELECT organization_id FROM owned) AND visibility = 'public') AS public_repos,
      (SELECT count(*)::int FROM repositories WHERE organization_id IN (SELECT organization_id FROM owned) AND visibility = 'private') AS private_repos,
      COALESCE((SELECT sum(size)::bigint FROM (
        SELECT DISTINCT r.organization_id, b.digest, b.size FROM blobs b
        JOIN repository_blobs rb ON rb.blob_digest = b.digest
        JOIN repositories r ON r.id = rb.repository_id
        WHERE r.organization_id IN (SELECT organization_id FROM owned)) t), 0) AS storage_bytes`);
  const r = rows[0];
  return {
    organizations: Number(r.organizations),
    publicRepos: Number(r.public_repos),
    privateRepos: Number(r.private_repos),
    storageBytes: Number(r.storage_bytes),
  };
}

export async function getOrgLimits(orgId: string): Promise<Limits> {
  const row = await db.query.organizationLimits.findFirst({
    where: eq(organizationLimits.organizationId, orgId),
  });
  return row ? { maxOrganizations: null, ...pick(row) } : UNLIMITED;
}

export async function getUserLimits(userId: string): Promise<Limits> {
  const row = await db.query.userLimits.findFirst({ where: eq(userLimits.userId, userId) });
  return row ? { maxOrganizations: row.maxOrganizations, ...pick(row) } : UNLIMITED;
}

function pick(row: {
  maxPublicRepos: number | null;
  maxPrivateRepos: number | null;
  maxStorageBytes: number | null;
}) {
  return {
    maxPublicRepos: row.maxPublicRepos,
    maxPrivateRepos: row.maxPrivateRepos,
    maxStorageBytes: row.maxStorageBytes,
  };
}

async function orgOwnerIds(orgId: string): Promise<string[]> {
  const { rows } = await db.execute(sql`
    SELECT user_id FROM member WHERE organization_id = ${orgId} AND role = 'owner'`);
  return rows.map((r) => r.user_id as string);
}

/**
 * Can one more repository of this visibility be created in the org?
 * Returns a human-readable reason when not.
 */
export async function checkRepoQuota(
  orgId: string,
  visibility: "public" | "private",
  orgLabel = "this organization",
  /** Repositories of this visibility already promised to the org but not stored yet (bulk preview). */
  pending = 0,
): Promise<string | null> {
  const key = visibility === "public" ? "maxPublicRepos" : "maxPrivateRepos";
  const usageKey = visibility === "public" ? "publicRepos" : "privateRepos";

  const [orgLimit, orgUsage] = await Promise.all([getOrgLimits(orgId), getOrgUsage(orgId)]);
  if (orgLimit[key] !== null && orgUsage[usageKey] + pending >= orgLimit[key]) {
    return `${orgLabel} has reached its limit of ${orgLimit[key]} ${visibility} repositories.`;
  }
  for (const ownerId of await orgOwnerIds(orgId)) {
    const [limit, usage] = await Promise.all([getUserLimits(ownerId), getUserUsage(ownerId)]);
    if (limit[key] !== null && usage[usageKey] + pending >= limit[key]) {
      return `The organization owner's account has reached its limit of ${limit[key]} ${visibility} repositories.`;
    }
  }
  return null;
}

/** Would adding `additionalBytes` to the org exceed any storage limit? */
export async function checkStorageQuota(orgId: string, additionalBytes: number): Promise<string | null> {
  const [orgLimit, orgUsage] = await Promise.all([getOrgLimits(orgId), getOrgUsage(orgId)]);
  if (orgLimit.maxStorageBytes !== null && orgUsage.storageBytes + additionalBytes > orgLimit.maxStorageBytes) {
    return `Storage limit reached: ${formatBytes(orgUsage.storageBytes)} of ${formatBytes(orgLimit.maxStorageBytes)} used.`;
  }
  for (const ownerId of await orgOwnerIds(orgId)) {
    const [limit, usage] = await Promise.all([getUserLimits(ownerId), getUserUsage(ownerId)]);
    if (limit.maxStorageBytes !== null && usage.storageBytes + additionalBytes > limit.maxStorageBytes) {
      return `The owner's account storage limit is reached: ${formatBytes(usage.storageBytes)} of ${formatBytes(limit.maxStorageBytes)}.`;
    }
  }
  return null;
}

/** May the user create another organization? */
export async function checkOrgCreationQuota(userId: string): Promise<string | null> {
  const [limit, usage] = await Promise.all([getUserLimits(userId), getUserUsage(userId)]);
  if (limit.maxOrganizations !== null && usage.organizations >= limit.maxOrganizations) {
    return `You have reached your limit of ${limit.maxOrganizations} organizations.`;
  }
  return null;
}

/** Parse a limits form: empty string → unlimited (null). */
export function parseLimitField(value: FormDataEntryValue | null): number | null {
  const s = String(value ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/** Storage entered in GiB on the admin forms. */
export function parseStorageGiB(value: FormDataEntryValue | null): number | null {
  const s = String(value ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1024 * 1024 * 1024);
}
