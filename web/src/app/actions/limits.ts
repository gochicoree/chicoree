"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { organizationLimits, userLimits } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { parseLimitField, parseStorageGiB } from "@/lib/quota";
import { recordAudit } from "@/lib/audit";

export interface LimitsActionResult {
  error?: string;
  saved?: boolean;
}

export async function setUserLimits(
  _prev: LimitsActionResult | null,
  formData: FormData,
): Promise<LimitsActionResult> {
  const session = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return { error: "Missing user." };
  const values = {
    maxOrganizations: parseLimitField(formData.get("maxOrganizations")),
    maxPublicRepos: parseLimitField(formData.get("maxPublicRepos")),
    maxPrivateRepos: parseLimitField(formData.get("maxPrivateRepos")),
    maxStorageBytes: parseStorageGiB(formData.get("maxStorageGiB")),
    note: String(formData.get("note") ?? "").trim(),
    updatedAt: new Date(),
    updatedBy: session.user.id,
  };
  await db
    .insert(userLimits)
    .values({ userId, ...values })
    .onConflictDoUpdate({ target: userLimits.userId, set: values });
  await recordAudit({ action: "admin.user.limits", targetType: "user", targetId: userId, details: { ...values, updatedAt: undefined, updatedBy: undefined } });
  revalidatePath(`/admin/users/${userId}`);
  return { saved: true };
}

export async function setOrgLimits(
  _prev: LimitsActionResult | null,
  formData: FormData,
): Promise<LimitsActionResult> {
  const session = await requireAdmin();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) return { error: "Missing organization." };
  const values = {
    maxPublicRepos: parseLimitField(formData.get("maxPublicRepos")),
    maxPrivateRepos: parseLimitField(formData.get("maxPrivateRepos")),
    maxStorageBytes: parseStorageGiB(formData.get("maxStorageGiB")),
    note: String(formData.get("note") ?? "").trim(),
    updatedAt: new Date(),
    updatedBy: session.user.id,
  };
  await db
    .insert(organizationLimits)
    .values({ organizationId, ...values })
    .onConflictDoUpdate({ target: organizationLimits.organizationId, set: values });
  await recordAudit({ action: "admin.org.limits", organizationId, targetType: "organization", targetId: organizationId, details: { ...values, updatedAt: undefined, updatedBy: undefined } });
  revalidatePath(`/admin/organizations/${organizationId}`);
  return { saved: true };
}
