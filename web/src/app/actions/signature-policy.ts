"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { organization, organizationSettings, repositories } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { refreshOrganizationBlocks, refreshRepositoryBlocks } from "@/lib/pull-policy";
import { reverifyOrganization } from "@/lib/signatures";
import { recordAudit } from "@/lib/audit";

export interface SignaturePolicyResult {
  error?: string;
  saved?: boolean;
  blocked?: number;
}

/** Organization-wide "require signatures" switch. */
export async function setOrgSignaturePolicy(_prev: SignaturePolicyResult | null, formData: FormData): Promise<SignaturePolicyResult> {
  await requireSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can change the signature policy." };
  const requireSignature = formData.get("requireSignature") === "on";
  await db
    .insert(organizationSettings)
    .values({ organizationId, requireSignature, updatedAt: new Date() })
    .onConflictDoUpdate({ target: organizationSettings.organizationId, set: { requireSignature, updatedAt: new Date() } });
  await refreshOrganizationBlocks(organizationId);
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  await recordAudit({
    action: "policy.update",
    organizationId,
    targetType: "organization",
    targetId: organizationId,
    targetLabel: org?.slug,
    details: { scope: "organization", requireSignature },
  });
  if (org) {
    revalidatePath(`/${org.slug}/settings`);
    revalidatePath(`/${org.slug}`, "layout");
  }
  return { saved: true };
}

/** Organization switch: do members' personal signing keys count as trusted? Every signature is re-verified. */
export async function setOrgMemberKeysPolicy(_prev: SignaturePolicyResult | null, formData: FormData): Promise<SignaturePolicyResult> {
  await requireSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can change the signature policy." };
  const trustMemberKeys = formData.get("trustMemberKeys") === "on";
  await db
    .insert(organizationSettings)
    .values({ organizationId, trustMemberKeys, updatedAt: new Date() })
    .onConflictDoUpdate({ target: organizationSettings.organizationId, set: { trustMemberKeys, updatedAt: new Date() } });
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  await recordAudit({
    action: "policy.update",
    organizationId,
    targetType: "organization",
    targetId: organizationId,
    targetLabel: org?.slug,
    details: { scope: "organization", trustMemberKeys },
  });
  await reverifyOrganization(organizationId);
  if (org) {
    revalidatePath(`/${org.slug}/settings`);
    revalidatePath(`/${org.slug}`, "layout");
  }
  return { saved: true };
}

/** Repository override: "" inherits, "on" requires, "off" never requires. */
export async function setRepoSignaturePolicy(_prev: SignaturePolicyResult | null, formData: FormData): Promise<SignaturePolicyResult> {
  await requireSession();
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." };
  const role = await getOrgRole(repo.organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can change the signature policy." };
  const mode = String(formData.get("mode") ?? "");
  const requireSignature = mode === "on" ? true : mode === "off" ? false : null;
  await db.update(repositories).set({ requireSignature, updatedAt: new Date() }).where(eq(repositories.id, repositoryId));
  const { blocked } = await refreshRepositoryBlocks(repositoryId);
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  await recordAudit({
    action: "policy.update",
    organizationId: repo.organizationId,
    targetType: "repository",
    targetId: repositoryId,
    targetLabel: `${org?.slug}/${repo.name}`,
    details: { scope: "repository", requireSignature, blocked },
  });
  if (org) {
    revalidatePath(`/${org.slug}/${repo.name}/settings`);
    revalidatePath(`/${org.slug}/${repo.name}`);
  }
  return { saved: true, blocked };
}
