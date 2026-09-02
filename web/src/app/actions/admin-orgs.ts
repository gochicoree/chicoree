"use server";

// Instance-admin management of organizations. These bypass better-auth's
// membership checks (admins are usually not members), so they write the
// member/organization tables directly.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { member, organization, repositories } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { ORG_ROLE_NAMES, type OrgRole } from "@/lib/org-roles";
import { LIBRARY_SLUG } from "@/lib/library";

export async function adminSetMemberRole(formData: FormData): Promise<void> {
  await requireAdmin();
  const memberId = String(formData.get("memberId") ?? "");
  const role = String(formData.get("role") ?? "") as OrgRole;
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!ORG_ROLE_NAMES.includes(role)) return;
  await db.update(member).set({ role }).where(eq(member.id, memberId));
  revalidatePath(`/admin/organizations/${organizationId}`);
}

export async function adminRemoveMember(formData: FormData): Promise<void> {
  await requireAdmin();
  const memberId = String(formData.get("memberId") ?? "");
  const organizationId = String(formData.get("organizationId") ?? "");
  await db.delete(member).where(and(eq(member.id, memberId), eq(member.organizationId, organizationId)));
  revalidatePath(`/admin/organizations/${organizationId}`);
}

export async function adminDeleteRepository(formData: FormData): Promise<void> {
  await requireAdmin();
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const organizationId = String(formData.get("organizationId") ?? "");
  await db.delete(repositories).where(eq(repositories.id, repositoryId));
  revalidatePath(`/admin/organizations/${organizationId}`);
}

export async function adminDeleteOrganization(formData: FormData): Promise<void> {
  await requireAdmin();
  const organizationId = String(formData.get("organizationId") ?? "");
  const confirmSlug = String(formData.get("confirmSlug") ?? "");
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (!org || org.slug !== confirmSlug || org.slug === LIBRARY_SLUG) return;
  // Cascades: members, invitations, repositories → manifests, tags, links,
  // events, service accounts. Blob content is reclaimed by the next GC.
  await db.delete(organization).where(eq(organization.id, organizationId));
  revalidatePath("/admin/organizations");
  redirect("/admin/organizations");
}
