"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { manifests, organization, organizationProxies, repositories, tags, vulnerabilityScans } from "@/db/schema";
import { getOrgRole, requireSession, getSession } from "@/lib/session";
import { isArtifactManifest, runScan, type ManifestPayload } from "@/lib/scan";
import { getScanner } from "@/lib/scanners";
import { deleteTag as removeTag, type DeleteTagOutcome } from "@/lib/tag-admin";
import { checkRepoQuota } from "@/lib/quota";
import { checkQuotaWarnings } from "@/lib/notify";
import { MANAGER_ROLES, WRITER_ROLES } from "@/lib/org-roles";
import { isValidRepoName, repoHref } from "@/lib/proxy-shared";
import { recordAudit } from "@/lib/audit";
import { clearRepositoryRedirects } from "@/lib/redirects";
import { scanInProgress } from "@/lib/scanner-shared";

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
  // Proxy caches mirror upstream paths, which may be nested (bitnami/redis).
  const proxy = await db.query.organizationProxies.findFirst({ where: eq(organizationProxies.organizationId, orgId) });
  const validName = proxy ? isValidRepoName(name, true) : NAME_RE.test(name) && name.length <= 100;
  if (!validName) {
    return {
      error: proxy
        ? "Repository names use lowercase letters, digits and single ._- separators, with / between path components."
        : "Repository names use lowercase letters, digits and single ._- separators.",
    };
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

  const [created] = await db.insert(repositories).values({ organizationId: orgId, name, description, visibility }).returning({ id: repositories.id });
  // Old names of renamed / transferred repositories can be reused: the redirect ends here.
  await clearRepositoryRedirects(orgId, org.slug, name);
  await recordAudit({ action: "repo.create", organizationId: orgId, targetType: "repository", targetId: created.id, targetLabel: `${org.slug}/${name}`, details: { visibility } });
  after(() => checkQuotaWarnings(orgId).catch((err) => console.error("quota warning check failed:", err)));
  revalidatePath(`/${org.slug}`);
  redirect(repoHref(org.slug, name));
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
  if (visibility !== repo.visibility) {
    after(() => checkQuotaWarnings(repo.organizationId).catch((err) => console.error("quota warning check failed:", err)));
  }

  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  await recordAudit({ action: visibility !== repo.visibility ? "repo.visibility" : "repo.update", organizationId: repo.organizationId, targetType: "repository", targetId: repoId, targetLabel: `${org?.slug}/${repo.name}`, details: visibility !== repo.visibility ? { from: repo.visibility, to: visibility } : { description: description !== repo.description } });
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
  await recordAudit({ action: "repo.delete", organizationId: repo.organizationId, targetType: "repository", targetId: repoId, targetLabel: `${org?.slug}/${repo.name}`, details: { visibility: repo.visibility } });
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
  await recordAudit({ action: "tag.delete", organizationId: repo.organizationId, targetType: "tag", targetId: `${repoId}:${tagName}`, targetLabel: `${org?.slug}/${repo.name}:${tagName}` });
  revalidatePath(`/${org?.slug}/${repo.name}`);
}

export interface RescanResult {
  /** True when a scan was queued; false with the reason otherwise. */
  queued: boolean;
  message: string;
}

/**
 * Queue a vulnerability scan for one image. Says why when nothing happens
 * (index, attestation, scan already running, scanning off) so the button
 * can report it instead of silently doing nothing.
 */
export async function requestRescan(formData: FormData): Promise<RescanResult> {
  const repoId = String(formData.get("repositoryId") ?? "");
  const digest = String(formData.get("digest") ?? "");
  // Re-scans cost the scanner real work; only instance administrators may queue them.
  const session = await getSession();
  if (session?.user.role !== "admin") return { queued: false, message: "Only instance administrators can queue scans." };
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repoId) });
  if (!repo) return { queued: false, message: "Repository not found." };
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) return { queued: false, message: "Organization not found." };
  if (!(await getScanner())) return { queued: false, message: "Scanning is off (Administration → Scanning)." };
  const manifest = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)),
    columns: { payload: true },
  });
  if (!manifest) return { queued: false, message: "This image does not exist (anymore)." };
  let payload: ManifestPayload = {};
  try {
    payload = JSON.parse(manifest.payload) as ManifestPayload;
  } catch {
    // treated as an image
  }
  if (Array.isArray(payload.manifests)) return { queued: false, message: "Multi-arch indexes are not scanned; their platform variants are." };
  if (isArtifactManifest(payload)) {
    return { queued: false, message: "Not scanned: this manifest carries no filesystem (an attestation, signature or SBOM)." };
  }

  // Someone can still submit while a scan runs (an old page, a double click);
  // queueing a second one would duplicate work.
  const current = await db.query.vulnerabilityScans.findFirst({ where: eq(vulnerabilityScans.digest, digest) });
  if (scanInProgress(current)) return { queued: false, message: "A scan of this image is already running." };

  const path = `${org.slug}/${repo.name}`;
  await recordAudit({ action: "scan.request", organizationId: repo.organizationId, targetType: "manifest", targetId: digest, targetLabel: `${path}@${digest.slice(0, 19)}` });
  // Mark it pending right away so the page shows "scanning" on refresh and a
  // second request is refused until the scanner reports back.
  await db
    .insert(vulnerabilityScans)
    .values({ digest, repositoryId: repo.id, status: "pending", error: null, updatedAt: new Date() })
    .onConflictDoUpdate({ target: vulnerabilityScans.digest, set: { repositoryId: repo.id, status: "pending", error: null, updatedAt: new Date() } });
  after(async () => {
    await runScan(path, digest).catch((err) => console.error("rescan failed:", err));
  });
  revalidatePath(`/${org.slug}/${repo.name}`);
  return { queued: true, message: "Scan queued; the result appears here when it finishes." };
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
    await recordAudit({ action: "tag.delete", organizationId: repo.organizationId, targetType: "tag", targetId: `${repositoryId}:${tag}`, targetLabel: `${org?.slug}/${repo.name}:${tag}`, details: { outcome } });
    revalidatePath(`/${org?.slug}/${repo.name}`);
    return { outcome };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not delete the tag." };
  }
}
