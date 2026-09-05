"use server";

// Setting and clearing the pictures of organizations, repositories and users.
// Every one of these validates the upload server-side (lib/branding-shared's
// validateLogoDataUrl, the same check the forms run for live feedback), stores
// the normalised data URL in the entity's own column, and writes an audit row.
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, repositories, user as userTable } from "@/db/schema";
import { getOrgRole, requireAdmin, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { recordAudit } from "@/lib/audit";
import { parseLogoDataUrl, validateLogoDataUrl } from "@/lib/logo-shared";

export interface LogoResult {
  error?: string;
  saved?: boolean;
  message?: string;
}

/**
 * Read the submitted picture: "" means remove. Never trusts the client — the
 * form runs the same validation, but this is the check that counts. The value
 * is stored whitespace-free so its MD5 (the cache version) is stable.
 */
function readLogo(formData: FormData): { value: string | null } | { error: string } {
  const raw = String(formData.get("logoDataUrl") ?? "").trim();
  if (!raw) return { value: null };
  const check = validateLogoDataUrl(raw);
  if (!check.ok) return { error: check.error };
  const parsed = parseLogoDataUrl(raw);
  if (!parsed) return { error: "That picture could not be read." };
  return { value: `data:${parsed.mediaType};base64,${parsed.base64}` };
}

function describe(value: string | null): Record<string, unknown> {
  if (!value) return { removed: true };
  const parsed = parseLogoDataUrl(value);
  return { mediaType: parsed?.mediaType, bytes: parsed?.bytes.length };
}

/** Organization → Settings → General. Owners and admins. */
export async function saveOrganizationLogo(_prev: LogoResult | null, formData: FormData): Promise<LogoResult> {
  await requireSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (!org) return { error: "Organization not found." };
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization admins can change the picture." };

  const read = readLogo(formData);
  if ("error" in read) return { error: read.error };
  await db.update(organization).set({ logo: read.value }).where(eq(organization.id, organizationId));
  await recordAudit({
    action: "org.logo",
    organizationId,
    targetType: "organization",
    targetId: organizationId,
    targetLabel: org.slug,
    details: describe(read.value),
  });
  revalidatePath(`/${org.slug}`, "layout");
  revalidatePath("/orgs");
  revalidatePath("/dashboard");
  return { saved: true, message: read.value ? "Picture saved" : "Picture removed" };
}

/** Repository → Settings → General. Owners and admins of the organization. */
export async function saveRepositoryLogo(_prev: LogoResult | null, formData: FormData): Promise<LogoResult> {
  await requireSession();
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." };
  const role = await getOrgRole(repo.organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization admins can change the picture." };

  const read = readLogo(formData);
  if ("error" in read) return { error: read.error };
  await db.update(repositories).set({ logo: read.value, updatedAt: new Date() }).where(eq(repositories.id, repositoryId));
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  await recordAudit({
    action: "repo.logo",
    organizationId: repo.organizationId,
    targetType: "repository",
    targetId: repositoryId,
    targetLabel: `${org?.slug}/${repo.name}`,
    details: describe(read.value),
  });
  if (org) revalidatePath(`/${org.slug}`, "layout");
  revalidatePath("/explore");
  revalidatePath("/dashboard");
  return { saved: true, message: read.value ? "Picture saved" : "Picture removed" };
}

/** Settings → Profile: the signed-in user's own avatar. */
export async function saveUserAvatar(_prev: LogoResult | null, formData: FormData): Promise<LogoResult> {
  const session = await requireSession();
  const read = readLogo(formData);
  if ("error" in read) return { error: read.error };
  await db.update(userTable).set({ image: read.value, updatedAt: new Date() }).where(eq(userTable.id, session.user.id));
  await recordAudit({
    action: "user.avatar",
    targetType: "user",
    targetId: session.user.id,
    targetLabel: session.user.email,
    details: describe(read.value),
  });
  revalidatePath("/settings");
  revalidatePath("/", "layout");
  return { saved: true, message: read.value ? "Avatar saved" : "Avatar removed" };
}

/** /admin/organizations/[id]: an instance admin sets or clears the picture. */
export async function adminSaveOrganizationLogo(_prev: LogoResult | null, formData: FormData): Promise<LogoResult> {
  await requireAdmin();
  const organizationId = String(formData.get("organizationId") ?? "");
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (!org) return { error: "Organization not found." };

  const read = readLogo(formData);
  if ("error" in read) return { error: read.error };
  await db.update(organization).set({ logo: read.value }).where(eq(organization.id, organizationId));
  await recordAudit({
    action: "admin.org.logo",
    organizationId,
    targetType: "organization",
    targetId: organizationId,
    targetLabel: org.slug,
    details: { ...describe(read.value), by: "admin" },
  });
  revalidatePath(`/admin/organizations/${organizationId}`, "layout");
  revalidatePath("/admin/organizations");
  revalidatePath(`/${org.slug}`, "layout");
  return { saved: true, message: read.value ? "Picture saved" : "Picture removed" };
}

/** /admin/users/[id]: an instance admin sets or clears a user's avatar. */
export async function adminSaveUserAvatar(_prev: LogoResult | null, formData: FormData): Promise<LogoResult> {
  await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const u = await db.query.user.findFirst({ where: eq(userTable.id, userId) });
  if (!u) return { error: "User not found." };

  const read = readLogo(formData);
  if ("error" in read) return { error: read.error };
  await db.update(userTable).set({ image: read.value, updatedAt: new Date() }).where(eq(userTable.id, userId));
  await recordAudit({
    action: "admin.user.avatar",
    targetType: "user",
    targetId: userId,
    targetLabel: u.email,
    details: { ...describe(read.value), by: "admin" },
  });
  revalidatePath(`/admin/users/${userId}`, "layout");
  revalidatePath("/admin/users");
  return { saved: true, message: read.value ? "Avatar saved" : "Avatar removed" };
}
