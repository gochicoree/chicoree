"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, repositories, tags } from "@/db/schema";
import { getOrgRole, requireSession, getSession } from "@/lib/session";
import { runScan } from "@/lib/scan";
import { deleteTag as removeTag, type DeleteTagOutcome } from "@/lib/tag-admin";
import { checkRepoQuota } from "@/lib/quota";
import { MANAGER_ROLES, WRITER_ROLES } from "@/lib/org-roles";

const NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

// These would shadow org-level UI routes (/<org>/members etc.). Pushing such
// a repo still works at the registry level; the web UI just reserves the paths.
const RESERVED_REPO_NAMES = new Set([
  "members", "settings", "service-accounts", "new-repository", "import",
  // API path markers: a top-level image named like these is ambiguous
  "tags", "manifests", "blobs", "referrers",
]);

export interface ActionResult {
  error?: string;
}

async function requireOrgRole(organizationId: string, roles: string[]): Promise<ActionResult | null> {
  await requireSession();
  const role = await getOrgRole(organizationId);
  if (!role || !roles.includes(role)) {
    return { error: "You don't have permission to do that in this organization." };
  }
  return null;
}

export async function createRepository(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const orgId = String(formData.get("organizationId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const visibility = formData.get("visibility") === "public" ? "public" : "private";

  const denied = await requireOrgRole(orgId, WRITER_ROLES);
  if (denied) return denied;
  if (!NAME_RE.test(name) || name.length > 100) {
    return { error: "Repository names use lowercase letters, digits and single ._- separators." };
  }
  if (RESERVED_REPO_NAMES.has(name)) {
    return { error: `"${name}" is reserved; pick a different name.` };
  }
  const org = await db.query.organization.findFirst({ where: eq(organization.id, orgId) });
  if (!org) return { error: "Organization not found." };

  const existing = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, orgId), eq(repositories.name, name)),
  });
  if (existing) return { error: `A repository named ${name} already exists.` };
  const quota = await checkRepoQuota(orgId, visibility, org.name);
  if (quota) return { error: quota };

  await db.insert(repositories).values({ organizationId: orgId, name, description, visibility });
  revalidatePath(`/${org.slug}`);
  redirect(`/${org.slug}/${name}`);
}

export async function updateRepository(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const repoId = String(formData.get("repositoryId") ?? "");
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repoId) });
  if (!repo) return { error: "Repository not found." };
  const denied = await requireOrgRole(repo.organizationId, MANAGER_ROLES);
  if (denied) return denied;

  const description = String(formData.get("description") ?? "").trim();
  const visibility = formData.get("visibility") === "public" ? "public" : "private";
  if (visibility !== repo.visibility) {
    const quota = await checkRepoQuota(repo.organizationId, visibility);
    if (quota) return { error: quota };
  }
  await db
    .update(repositories)
    .set({ description, visibility, updatedAt: new Date() })
    .where(eq(repositories.id, repoId));

  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  revalidatePath(`/${org?.slug}/${repo.name}`);
  return {};
}

export async function deleteRepository(formData: FormData): Promise<void> {
  const repoId = String(formData.get("repositoryId") ?? "");
  const confirmName = String(formData.get("confirmName") ?? "");
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repoId) });
  if (!repo) return;
  const denied = await requireOrgRole(repo.organizationId, MANAGER_ROLES);
  if (denied || confirmName !== repo.name) return;

  // Cascades remove manifests, tags, links and events; orphaned blob content
  // is reclaimed by the next garbage-collection pass.
  await db.delete(repositories).where(eq(repositories.id, repoId));
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  revalidatePath(`/${org?.slug}`);
  redirect(`/${org?.slug}`);
}

export async function deleteTag(formData: FormData): Promise<void> {
  const repoId = String(formData.get("repositoryId") ?? "");
  const tagName = String(formData.get("tag") ?? "");
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repoId) });
  if (!repo) return;
  const denied = await requireOrgRole(repo.organizationId, MANAGER_ROLES);
  if (denied) return;

  await db.delete(tags).where(and(eq(tags.repositoryId, repoId), eq(tags.name, tagName)));
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  revalidatePath(`/${org?.slug}/${repo.name}`);
}

export async function requestRescan(formData: FormData): Promise<void> {
  const repoId = String(formData.get("repositoryId") ?? "");
  const digest = String(formData.get("digest") ?? "");
  // Re-scans cost Clair real work; only instance administrators may queue them.
  const session = await getSession();
  if (session?.user.role !== "admin") return;
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repoId) });
  if (!repo) return;
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) return;

  const path = `${org.slug}/${repo.name}`;
  after(async () => {
    await runScan(path, digest).catch((err) => console.error("rescan failed:", err));
  });
  revalidatePath(`/${org.slug}/${repo.name}`);
}

export interface DeleteTagResult {
  error?: string;
  outcome?: DeleteTagOutcome;
}

/** Remove a tag; owners and admins of the organization (and instance admins) only. */
export async function deleteTagAction(formData: FormData): Promise<DeleteTagResult> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const tag = String(formData.get("tag") ?? "").trim();
  if (!tag) return { error: "Missing tag." };
  const session = await requireSession();
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." };
  const denied = await requireOrgRole(repo.organizationId, MANAGER_ROLES);
  if (denied) return { error: denied.error };
  try {
    const outcome = await removeTag(repositoryId, tag, `user:${session.user.id}`);
    const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
    revalidatePath(`/${org?.slug}/${repo.name}`);
    return { outcome };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not delete the tag." };
  }
}
