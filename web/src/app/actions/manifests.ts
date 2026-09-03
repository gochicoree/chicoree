"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { organization, repositories } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { deleteManifestByDigest, type DeleteManifestOutcome } from "@/lib/manifests";

export interface DeleteManifestResult {
  error?: string;
  outcome?: DeleteManifestOutcome;
}

/** Delete an image by digest (every tag pointing at it goes too); owners, admins and instance admins only. */
export async function deleteManifestAction(formData: FormData): Promise<DeleteManifestResult> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const digest = String(formData.get("digest") ?? "").trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return { error: "Invalid digest." };
  const session = await requireSession();
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." };
  const role = await getOrgRole(repo.organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can delete images." };
  try {
    const outcome = await deleteManifestByDigest(repositoryId, digest, `user:${session.user.id}`);
    const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
    revalidatePath(`/${org?.slug}/${repo.name}`, "layout");
    return { outcome };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not delete the image." };
  }
}
