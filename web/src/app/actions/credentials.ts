"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accessTokens, member, organization, repositories, serviceAccounts } from "@/db/schema";
import { generateSecret, PAT_PREFIX, SA_PREFIX } from "@/lib/secrets";
import { getOrgRole, requireAdmin, requireSession } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { getInstanceSettings } from "@/lib/instance-settings";
import { normalizeRestriction, resolveExpiry, type TokenExpiryPolicy } from "@/lib/token-policy-shared";

const NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export interface SecretResult {
  error?: string;
  /** The full credential — shown exactly once, never stored. */
  secret?: string;
  name?: string;
  /** Rotation: the id of the replacement row. */
  id?: string;
}

async function expiryPolicy(): Promise<TokenExpiryPolicy> {
  const { access } = await getInstanceSettings();
  return { maxTokenLifetimeDays: access.maxTokenLifetimeDays, requireTokenExpiry: access.requireTokenExpiry };
}

/** Expiry from the form under the instance policy: `expires` (days | custom | never) + `expiresOn` (date). */
async function expiryFromForm(formData: FormData) {
  // Older forms posted `expiresDays`; keep accepting it.
  const choice = String(formData.get("expires") ?? formData.get("expiresDays") ?? "");
  return resolveExpiry(choice, String(formData.get("expiresOn") ?? ""), await expiryPolicy());
}

// --- Service accounts (per organization, for CI) ---

export async function createServiceAccount(
  _prev: SecretResult | null,
  formData: FormData,
): Promise<SecretResult> {
  await requireSession();
  const orgId = String(formData.get("organizationId") ?? "");
  const role = await getOrgRole(orgId);
  if (role !== "owner" && role !== "admin") {
    return { error: "Only organization owners and admins can manage service accounts." };
  }

  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const permission = String(formData.get("permission") ?? "pull");
  const expiry = await expiryFromForm(formData);
  if ("error" in expiry) return { error: expiry.error };
  if (!NAME_RE.test(name) || name.length > 64) {
    return { error: "Service account names use lowercase letters, digits and single ._- separators." };
  }
  if (!["pull", "push", "admin"].includes(permission)) return { error: "Invalid permission." };

  const existing = await db.query.serviceAccounts.findFirst({
    where: and(eq(serviceAccounts.organizationId, orgId), eq(serviceAccounts.name, name)),
  });
  if (existing) return { error: `A service account named ${name} already exists.` };

  const session = await requireSession();
  const { secret, hash, display } = generateSecret(SA_PREFIX);
  const [created] = await db.insert(serviceAccounts).values({
    organizationId: orgId,
    name,
    description,
    permission: permission as "pull" | "push" | "admin",
    tokenHash: hash,
    tokenPrefix: display,
    createdBy: session.user.id,
    expiresAt: expiry.expiresAt,
  }).returning({ id: serviceAccounts.id });
  await recordAudit({ action: "sa.create", organizationId: orgId, targetType: "service_account", targetId: created.id, targetLabel: name, details: { permission, expiresAt: expiry.expiresAt?.toISOString() ?? null } });

  const org = await db.query.organization.findFirst({ where: eq(organization.id, orgId) });
  revalidatePath(`/${org?.slug}/service-accounts`);
  return { secret, name, id: created.id };
}

export async function deleteServiceAccount(formData: FormData): Promise<void> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  const sa = await db.query.serviceAccounts.findFirst({ where: eq(serviceAccounts.id, id) });
  if (!sa) return;
  const role = await getOrgRole(sa.organizationId);
  if (role !== "owner" && role !== "admin") return;
  await db.delete(serviceAccounts).where(eq(serviceAccounts.id, id));
  await recordAudit({ action: "sa.delete", organizationId: sa.organizationId, targetType: "service_account", targetId: sa.id, targetLabel: sa.name });
  const org = await db.query.organization.findFirst({ where: eq(organization.id, sa.organizationId) });
  revalidatePath(`/${org?.slug}/service-accounts`);
}

/**
 * Rotate a service account: a fresh secret replaces the old one in place
 * (same id, name, permission, repositories and remaining lifetime), so CI
 * references keep working once the new secret is stored. The old secret
 * stops working immediately. An expired credential gets the same lifetime
 * it originally had, counted from now.
 */
export async function rotateServiceAccount(
  _prev: SecretResult | null,
  formData: FormData,
): Promise<SecretResult> {
  await requireSession();
  const id = String(formData.get("id") ?? "");
  const sa = await db.query.serviceAccounts.findFirst({ where: eq(serviceAccounts.id, id) });
  if (!sa) return { error: "Unknown service account." };
  const role = await getOrgRole(sa.organizationId);
  if (role !== "owner" && role !== "admin") return { error: "Only organization owners and admins can rotate service accounts." };

  const policy = await expiryPolicy();
  const expiresAt = replacementExpiry(sa.createdAt, sa.expiresAt, policy);
  if ("error" in expiresAt) return { error: expiresAt.error };
  const { secret, hash, display } = generateSecret(SA_PREFIX);
  await db
    .update(serviceAccounts)
    .set({ tokenHash: hash, tokenPrefix: display, expiresAt: expiresAt.expiresAt, lastUsedAt: null, lastUsedIp: null })
    .where(eq(serviceAccounts.id, id));
  await recordAudit({ action: "sa.rotate", organizationId: sa.organizationId, targetType: "service_account", targetId: sa.id, targetLabel: sa.name, details: { expiresAt: expiresAt.expiresAt?.toISOString() ?? null } });
  const org = await db.query.organization.findFirst({ where: eq(organization.id, sa.organizationId) });
  revalidatePath(`/${org?.slug}/service-accounts`);
  return { secret, name: sa.name, id: sa.id };
}

/**
 * Expiry for a rotated credential: keep the original lifetime (expires − created)
 * counted from now, capped by the current policy; "never" stays "never" unless
 * the policy now requires an expiry, in which case the cap (or one year) applies.
 */
function replacementExpiry(
  createdAt: Date,
  expiresAt: Date | null,
  policy: TokenExpiryPolicy,
  now: Date = new Date(),
): { expiresAt: Date | null } | { error: string } {
  const capDays = policy.maxTokenLifetimeDays > 0 ? policy.maxTokenLifetimeDays : null;
  if (!expiresAt) {
    if (!policy.requireTokenExpiry) return { expiresAt: null };
    return resolveExpiry(String(capDays ?? 365), "", policy, now);
  }
  const lifetimeDays = Math.max(1, Math.round((expiresAt.getTime() - createdAt.getTime()) / 86_400_000));
  const days = capDays ? Math.min(lifetimeDays, capDays) : lifetimeDays;
  return resolveExpiry(String(days), "", policy, now);
}

// --- Personal access tokens (per user, for docker login) ---

async function restrictionFromForm(userId: string, formData: FormData) {
  const organizationId = String(formData.get("organizationId") ?? "").trim() || null;
  if (!organizationId) return { restriction: null, orgSlug: null as string | null };
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (!org) return { error: "Unknown organization." };
  const membership = await db.query.member.findFirst({ where: and(eq(member.organizationId, org.id), eq(member.userId, userId)) });
  const u = await db.query.user.findFirst({ where: (t, { eq }) => eq(t.id, userId) });
  if (!membership && u?.role !== "admin") return { error: "You are not a member of that organization." };
  const wanted = formData.getAll("repositoryIds").map(String).filter(Boolean);
  let repositoryIds: string[] | null = null;
  if (wanted.length > 0) {
    const rows = await db.query.repositories.findMany({
      where: and(eq(repositories.organizationId, org.id), inArray(repositories.id, wanted)),
      columns: { id: true },
    });
    if (rows.length !== new Set(wanted).size) return { error: "One of the repositories does not belong to that organization." };
    repositoryIds = rows.map((r) => r.id);
  }
  return { restriction: normalizeRestriction(org.id, repositoryIds), orgSlug: org.slug };
}

export async function createAccessToken(
  _prev: SecretResult | null,
  formData: FormData,
): Promise<SecretResult> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim().slice(0, 200);
  const scope = formData.get("scope") === "read" ? "read" : "write";
  if (name.length < 1 || name.length > 64) return { error: "Give the token a name (up to 64 characters)." };
  const expiry = await expiryFromForm(formData);
  if ("error" in expiry) return { error: expiry.error };
  const restricted = await restrictionFromForm(session.user.id, formData);
  if ("error" in restricted) return { error: restricted.error };

  const { secret, hash, display } = generateSecret(PAT_PREFIX);
  const [created] = await db.insert(accessTokens).values({
    userId: session.user.id,
    name,
    description,
    scope,
    tokenHash: hash,
    tokenPrefix: display,
    expiresAt: expiry.expiresAt,
    organizationId: restricted.restriction?.organizationId ?? null,
    repositoryIds: restricted.restriction?.repositoryIds ?? null,
  }).returning({ id: accessTokens.id });
  await recordAudit({
    action: "token.create",
    targetType: "access_token",
    targetId: created.id,
    targetLabel: name,
    organizationId: restricted.restriction?.organizationId ?? null,
    details: {
      scope,
      expiresAt: expiry.expiresAt?.toISOString() ?? null,
      organization: restricted.orgSlug,
      repositories: restricted.restriction?.repositoryIds?.length ?? null,
    },
  });
  revalidatePath("/settings/tokens");
  return { secret, name, id: created.id };
}

export async function deleteAccessToken(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const [deleted] = await db
    .delete(accessTokens)
    .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, session.user.id)))
    .returning({ id: accessTokens.id, name: accessTokens.name });
  if (deleted) await recordAudit({ action: "token.delete", targetType: "access_token", targetId: id, targetLabel: deleted.name });
  revalidatePath("/settings/tokens");
}

/**
 * Rotate a personal access token: create a replacement with the same name,
 * scope, restriction and lifetime, and revoke the old one. The new secret is
 * shown once.
 */
export async function rotateAccessToken(
  _prev: SecretResult | null,
  formData: FormData,
): Promise<SecretResult> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  const old = await db.query.accessTokens.findFirst({ where: and(eq(accessTokens.id, id), eq(accessTokens.userId, session.user.id)) });
  if (!old) return { error: "Unknown token." };
  const expiry = replacementExpiry(old.createdAt, old.expiresAt, await expiryPolicy());
  if ("error" in expiry) return { error: expiry.error };

  const { secret, hash, display } = generateSecret(PAT_PREFIX);
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(accessTokens)
      .values({
        userId: old.userId,
        name: old.name,
        description: old.description,
        scope: old.scope,
        tokenHash: hash,
        tokenPrefix: display,
        expiresAt: expiry.expiresAt,
        organizationId: old.organizationId,
        repositoryIds: old.repositoryIds,
      })
      .returning({ id: accessTokens.id });
    await tx.delete(accessTokens).where(eq(accessTokens.id, old.id));
    return row;
  });
  await recordAudit({
    action: "token.rotate",
    targetType: "access_token",
    targetId: created.id,
    targetLabel: old.name,
    organizationId: old.organizationId,
    details: { replaced: old.id, scope: old.scope, expiresAt: expiry.expiresAt?.toISOString() ?? null },
  });
  revalidatePath("/settings/tokens");
  return { secret, name: old.name, id: created.id };
}

/** Administrators revoke any user's token from /admin/users/[id]. */
export async function adminRevokeAccessToken(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const [deleted] = await db.delete(accessTokens).where(eq(accessTokens.id, id)).returning({ userId: accessTokens.userId, name: accessTokens.name });
  if (!deleted) return;
  await recordAudit({ action: "admin.token.revoke", targetType: "access_token", targetId: id, targetLabel: deleted.name, details: { userId: deleted.userId } });
  revalidatePath(`/admin/users/${deleted.userId}`);
  revalidatePath("/settings/tokens");
}
