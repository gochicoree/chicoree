"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, organizationSettings, userSettings } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { recordAudit } from "@/lib/audit";

export interface SettingsResult {
  error?: string;
  saved?: boolean;
}

function parseVisibility(v: FormDataEntryValue | null): "public" | "private" | null {
  const s = String(v ?? "");
  return s === "public" || s === "private" ? s : null;
}

/** Org-level default for repositories auto-created by pushes (null = inherit). */
export async function setOrgDefaultVisibility(
  _prev: SettingsResult | null,
  formData: FormData,
): Promise<SettingsResult> {
  await requireSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization admins can change this." };
  const defaultVisibility = parseVisibility(formData.get("defaultVisibility"));
  await db
    .insert(organizationSettings)
    .values({ organizationId, defaultVisibility, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { defaultVisibility, updatedAt: new Date() },
    });
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  await recordAudit({ action: "org.settings.default_visibility", organizationId, targetType: "organization", targetId: organizationId, targetLabel: org?.slug, details: { defaultVisibility } });
  revalidatePath(`/${org?.slug}/settings`);
  return { saved: true };
}

/** The user's own default, used in organizations without an explicit setting. */
export async function setUserDefaultVisibility(
  _prev: SettingsResult | null,
  formData: FormData,
): Promise<SettingsResult> {
  const session = await requireSession();
  const defaultVisibility = parseVisibility(formData.get("defaultVisibility"));
  await db
    .insert(userSettings)
    .values({ userId: session.user.id, defaultVisibility, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userSettings.userId, set: { defaultVisibility, updatedAt: new Date() } });
  await recordAudit({ action: "user.settings.default_visibility", targetType: "user", targetId: session.user.id, details: { defaultVisibility } });
  revalidatePath("/settings");
  return { saved: true };
}
