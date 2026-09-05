"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { organization, repositories, signingIdentitiesTrusted } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { recordAudit } from "@/lib/audit";
import { addTrustedIdentity, removeTrustedIdentity, reverifyOrganization, reverifyRepository } from "@/lib/signatures";

export interface TrustedIdentityResult {
  error?: string;
  saved?: boolean;
}

async function requireManager(organizationId: string) {
  const session = await requireSession();
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) {
    return { error: "Only organization owners and admins can manage trusted identities." } as const;
  }
  return { session } as const;
}

async function revalidateOrg(organizationId: string) {
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (org) revalidatePath(`/${org.slug}`, "layout");
  return org;
}

/** Trust a keyless identity for an organization (repositoryId empty) or one repository; every signature in scope is re-verified. */
export async function addTrustedIdentityAction(_prev: TrustedIdentityResult | null, formData: FormData): Promise<TrustedIdentityResult> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const repositoryId = String(formData.get("repositoryId") ?? "") || null;
  const ctx = await requireManager(organizationId);
  if ("error" in ctx) return { error: ctx.error };
  let repoLabel: string | null = null;
  if (repositoryId) {
    const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
    if (!repo || repo.organizationId !== organizationId) return { error: "Repository not found." };
    repoLabel = repo.name;
  }
  let row;
  try {
    row = await addTrustedIdentity({
      organizationId,
      repositoryId,
      name: String(formData.get("name") ?? ""),
      issuer: String(formData.get("issuer") ?? ""),
      subject: String(formData.get("subject") ?? ""),
      createdBy: ctx.session.user.id,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not add the identity." };
  }
  const org = await revalidateOrg(organizationId);
  await recordAudit({
    action: "signing_identity.add",
    organizationId,
    targetType: repositoryId ? "repository" : "organization",
    targetId: repositoryId ?? organizationId,
    targetLabel: repositoryId ? `${org?.slug}/${repoLabel}` : org?.slug,
    details: { name: row.name, issuer: row.issuer, subject: row.subject },
  });
  if (repositoryId) await reverifyRepository(repositoryId);
  else await reverifyOrganization(organizationId);
  return { saved: true };
}

export async function removeTrustedIdentityAction(formData: FormData): Promise<TrustedIdentityResult> {
  const id = String(formData.get("id") ?? "");
  const row = await db.query.signingIdentitiesTrusted.findFirst({ where: eq(signingIdentitiesTrusted.id, id) });
  if (!row) return { error: "Identity not found." };
  const ctx = await requireManager(row.organizationId);
  if ("error" in ctx) return { error: ctx.error };
  await removeTrustedIdentity(id);
  const org = await revalidateOrg(row.organizationId);
  await recordAudit({
    action: "signing_identity.remove",
    organizationId: row.organizationId,
    targetType: row.repositoryId ? "repository" : "organization",
    targetId: row.repositoryId ?? row.organizationId,
    targetLabel: org?.slug,
    details: { name: row.name, issuer: row.issuer, subject: row.subject },
  });
  if (row.repositoryId) await reverifyRepository(row.repositoryId);
  else await reverifyOrganization(row.organizationId);
  return { saved: true };
}
