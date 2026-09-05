// Writing limits rows (user_limits / organization_limits): the one place
// the admin screens, the REST API and the sign-up / creation defaults go
// through, so all three audit and notify the same way. Reading the
// effective limits and checking them lives in lib/quota.ts.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationLimits, userLimits } from "@/db/schema";
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from "./audit";
import { checkQuotaWarnings } from "./notify";
import { organizationDefaultsConfigured, userDefaultsConfigured, type QuotaDefaults } from "./quota-shared";

export interface OrgLimitsValues {
  maxPublicRepos: number | null;
  maxPrivateRepos: number | null;
  maxStorageBytes: number | null;
  maxMembers: number | null;
  /** Shown to the organization's owners and admins; empty = nothing. */
  label: string;
  /** Administrators only. */
  note: string;
}

export interface UserLimitsValues {
  maxOrganizations: number | null;
  maxPublicRepos: number | null;
  maxPrivateRepos: number | null;
  maxStorageBytes: number | null;
  label: string;
  note: string;
}

export type LimitsRow<T> = T & { updatedAt: Date; updatedBy: string | null };

export interface WriteOptions {
  /** The administrator making the change (null for the instance itself). */
  updatedBy: string | null;
  /** Audit actor; resolved from the request when omitted. */
  actor?: AuditActor;
  headers?: Headers | null;
  /** Marks writes that came through the REST API in the audit log. */
  via?: "api";
}

export async function getOrgLimitsRow(organizationId: string): Promise<LimitsRow<OrgLimitsValues> | null> {
  const row = await db.query.organizationLimits.findFirst({ where: eq(organizationLimits.organizationId, organizationId) });
  if (!row) return null;
  const { maxPublicRepos, maxPrivateRepos, maxStorageBytes, maxMembers, label, note, updatedAt, updatedBy } = row;
  return { maxPublicRepos, maxPrivateRepos, maxStorageBytes, maxMembers, label, note, updatedAt, updatedBy };
}

export async function getUserLimitsRow(userId: string): Promise<LimitsRow<UserLimitsValues> | null> {
  const row = await db.query.userLimits.findFirst({ where: eq(userLimits.userId, userId) });
  if (!row) return null;
  const { maxOrganizations, maxPublicRepos, maxPrivateRepos, maxStorageBytes, label, note, updatedAt, updatedBy } = row;
  return { maxOrganizations, maxPublicRepos, maxPrivateRepos, maxStorageBytes, label, note, updatedAt, updatedBy };
}

function auditFields(o: WriteOptions) {
  return {
    ...(o.actor ? { actor: o.actor } : {}),
    ...(o.headers !== undefined ? { headers: o.headers } : {}),
  };
}

/** Insert or replace an organization's limits row. */
export async function writeOrgLimits(organizationId: string, values: OrgLimitsValues, o: WriteOptions): Promise<void> {
  const row = { ...values, label: values.label.trim().slice(0, 80), note: values.note.trim(), updatedAt: new Date(), updatedBy: o.updatedBy };
  await db.insert(organizationLimits).values({ organizationId, ...row }).onConflictDoUpdate({ target: organizationLimits.organizationId, set: row });
  await recordAudit({
    action: "admin.org.limits",
    ...auditFields(o),
    organizationId,
    targetType: "organization",
    targetId: organizationId,
    details: { ...values, ...(o.via ? { via: o.via } : {}) },
  });
  // Owners hear about limits that are already (nearly) reached; never blocks the write.
  checkQuotaWarnings(organizationId).catch((err) => console.error("quota warning check failed:", err));
}

/** Insert or replace a user's limits row. */
export async function writeUserLimits(userId: string, values: UserLimitsValues, o: WriteOptions): Promise<void> {
  const row = { ...values, label: values.label.trim().slice(0, 80), note: values.note.trim(), updatedAt: new Date(), updatedBy: o.updatedBy };
  await db.insert(userLimits).values({ userId, ...row }).onConflictDoUpdate({ target: userLimits.userId, set: row });
  await recordAudit({
    action: "admin.user.limits",
    ...auditFields(o),
    targetType: "user",
    targetId: userId,
    details: { ...values, ...(o.via ? { via: o.via } : {}) },
  });
}

/** Drop the row: the organization is unlimited again (owner-level limits still apply). */
export async function deleteOrgLimits(organizationId: string, o: WriteOptions): Promise<boolean> {
  const deleted = await db.delete(organizationLimits).where(eq(organizationLimits.organizationId, organizationId)).returning({ id: organizationLimits.organizationId });
  if (deleted.length === 0) return false;
  await recordAudit({ action: "admin.org.limits", ...auditFields(o), organizationId, targetType: "organization", targetId: organizationId, details: { removed: true, ...(o.via ? { via: o.via } : {}) } });
  return true;
}

export async function deleteUserLimits(userId: string, o: WriteOptions): Promise<boolean> {
  const deleted = await db.delete(userLimits).where(eq(userLimits.userId, userId)).returning({ id: userLimits.userId });
  if (deleted.length === 0) return false;
  await recordAudit({ action: "admin.user.limits", ...auditFields(o), targetType: "user", targetId: userId, details: { removed: true, ...(o.via ? { via: o.via } : {}) } });
  return true;
}

/**
 * Give a new organization the instance's default limits (Administration →
 * Limits). Nothing happens when no default is set or a row already exists.
 */
export async function applyDefaultOrgLimits(organizationId: string, defaults: QuotaDefaults): Promise<void> {
  if (!organizationDefaultsConfigured(defaults)) return;
  const inserted = await db
    .insert(organizationLimits)
    .values({ organizationId, ...defaults.organization, label: "", note: "", updatedAt: new Date(), updatedBy: null })
    .onConflictDoNothing()
    .returning({ id: organizationLimits.organizationId });
  if (inserted.length === 0) return;
  await recordAudit({ action: "admin.org.limits", actor: SYSTEM_ACTOR, organizationId, targetType: "organization", targetId: organizationId, details: { ...defaults.organization, source: "defaults" } });
}

/** Give a new account the instance's default limits; same rules as for organizations. */
export async function applyDefaultUserLimits(userId: string, defaults: QuotaDefaults): Promise<void> {
  if (!userDefaultsConfigured(defaults)) return;
  const inserted = await db
    .insert(userLimits)
    .values({ userId, ...defaults.user, label: "", note: "", updatedAt: new Date(), updatedBy: null })
    .onConflictDoNothing()
    .returning({ id: userLimits.userId });
  if (inserted.length === 0) return;
  await recordAudit({ action: "admin.user.limits", actor: SYSTEM_ACTOR, targetType: "user", targetId: userId, details: { ...defaults.user, source: "defaults" } });
}
