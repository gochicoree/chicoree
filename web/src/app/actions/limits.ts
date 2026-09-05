"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { parseLimitField, parseStorageGiB } from "@/lib/quota";
import { writeOrgLimits, writeUserLimits } from "@/lib/limits";

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
  await writeUserLimits(
    userId,
    {
      maxOrganizations: parseLimitField(formData.get("maxOrganizations")),
      maxPublicRepos: parseLimitField(formData.get("maxPublicRepos")),
      maxPrivateRepos: parseLimitField(formData.get("maxPrivateRepos")),
      maxStorageBytes: parseStorageGiB(formData.get("maxStorageGiB")),
      label: String(formData.get("label") ?? ""),
      note: String(formData.get("note") ?? ""),
    },
    { updatedBy: session.user.id },
  );
  revalidatePath(`/admin/users/${userId}`);
  revalidatePath("/settings");
  return { saved: true };
}

export async function setOrgLimits(
  _prev: LimitsActionResult | null,
  formData: FormData,
): Promise<LimitsActionResult> {
  const session = await requireAdmin();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) return { error: "Missing organization." };
  await writeOrgLimits(
    organizationId,
    {
      maxPublicRepos: parseLimitField(formData.get("maxPublicRepos")),
      maxPrivateRepos: parseLimitField(formData.get("maxPrivateRepos")),
      maxStorageBytes: parseStorageGiB(formData.get("maxStorageGiB")),
      maxMembers: parseLimitField(formData.get("maxMembers")),
      label: String(formData.get("label") ?? ""),
      note: String(formData.get("note") ?? ""),
    },
    { updatedBy: session.user.id },
  );
  revalidatePath(`/admin/organizations/${organizationId}`);
  return { saved: true };
}
