"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accessTokens, organization, serviceAccounts } from "@/db/schema";
import { generateSecret, PAT_PREFIX, SA_PREFIX } from "@/lib/secrets";
import { getOrgRole, requireSession } from "@/lib/session";
import { recordAudit } from "@/lib/audit";

const NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export interface SecretResult {
  error?: string;
  /** The full credential — shown exactly once, never stored. */
  secret?: string;
  name?: string;
}

function expiryDate(days: string): Date | null {
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(Date.now() + n * 24 * 3600 * 1000);
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
  const expiresAt = expiryDate(String(formData.get("expiresDays") ?? ""));
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
    expiresAt,
  }).returning({ id: serviceAccounts.id });
  await recordAudit({ action: "sa.create", organizationId: orgId, targetType: "service_account", targetId: created.id, targetLabel: name, details: { permission, expiresAt: expiresAt?.toISOString() } });

  const org = await db.query.organization.findFirst({ where: eq(organization.id, orgId) });
  revalidatePath(`/${org?.slug}/service-accounts`);
  return { secret, name };
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

// --- Personal access tokens (per user, for docker login) ---

export async function createAccessToken(
  _prev: SecretResult | null,
  formData: FormData,
): Promise<SecretResult> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const scope = formData.get("scope") === "read" ? "read" : "write";
  const expiresAt = expiryDate(String(formData.get("expiresDays") ?? ""));
  if (name.length < 1 || name.length > 64) return { error: "Give the token a name (up to 64 characters)." };

  const { secret, hash, display } = generateSecret(PAT_PREFIX);
  const [created] = await db.insert(accessTokens).values({
    userId: session.user.id,
    name,
    scope,
    tokenHash: hash,
    tokenPrefix: display,
    expiresAt,
  }).returning({ id: accessTokens.id });
  await recordAudit({ action: "token.create", targetType: "access_token", targetId: created.id, targetLabel: name, details: { scope, expiresAt: expiresAt?.toISOString() } });
  revalidatePath("/settings/tokens");
  return { secret, name };
}

export async function deleteAccessToken(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get("id") ?? "");
  await db
    .delete(accessTokens)
    .where(and(eq(accessTokens.id, id), eq(accessTokens.userId, session.user.id)));
  await recordAudit({ action: "token.delete", targetType: "access_token", targetId: id });
  revalidatePath("/settings/tokens");
}
