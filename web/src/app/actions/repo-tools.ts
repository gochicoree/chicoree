"use server";

// Repository tools: rename, transfer to another organization, and rename an
// organization slug. Every move leaves a redirect (lib/redirects.ts) so the
// old `docker pull` reference and the old web URL keep working, is audited,
// and — for repositories — announced to the repository's webhooks.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { isAPIError } from "better-auth/api";
import { db } from "@/db";
import { organization, organizationProxies, repositories, retentionPolicies, tagRules } from "@/db/schema";
import { getAuth, RESERVED_SLUGS } from "@/lib/auth";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { checkRepoQuota, checkStorageQuota } from "@/lib/quota";
import { checkQuotaWarnings } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { emitRepositoryEvent } from "@/lib/webhooks";
import { refreshRepositoryBlocks } from "@/lib/pull-policy";
import { imageReference, LIBRARY_SLUG } from "@/lib/library";
import { env } from "@/lib/env";
import { repoHref } from "@/lib/proxy-shared";
import { ORG_SLUG_RE, repoNameProblem } from "@/lib/repo-names-shared";
import {
  addOrganizationRedirect,
  addRepositoryRedirect,
  clearOrganizationRedirect,
  clearRepositoryRedirects,
} from "@/lib/redirects";

export interface RepoToolResult {
  error?: string;
  /** Where the client should navigate afterwards. */
  href?: string;
  /** The new `docker pull` reference, for the success toast. */
  pullReference?: string;
}

function denied(): RepoToolResult {
  return { error: "You don't have permission to do that in this organization." };
}

async function isProxyOrg(organizationId: string): Promise<boolean> {
  return !!(await db.query.organizationProxies.findFirst({ where: eq(organizationProxies.organizationId, organizationId), columns: { organizationId: true } }));
}

/** Rename a repository within its organization; owners and admins only. */
export async function renameRepository(formData: FormData): Promise<RepoToolResult> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const newName = String(formData.get("name") ?? "").trim();
  const session = await requireSession();
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." };
  const role = await getOrgRole(repo.organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return denied();
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) return { error: "Organization not found." };
  if (await isProxyOrg(org.id)) {
    return { error: "Repositories in a proxy cache mirror upstream names and cannot be renamed." };
  }
  const problem = repoNameProblem(newName, false);
  if (problem) return { error: problem };
  if (newName === repo.name) return { error: "That is already the repository's name." };
  const taken = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, org.id), eq(repositories.name, newName)),
    columns: { id: true },
  });
  if (taken) return { error: `A repository named ${newName} already exists in ${org.slug}.` };

  const oldName = repo.name;
  await db.transaction(async (tx) => {
    await tx.update(repositories).set({ name: newName, updatedAt: new Date() }).where(eq(repositories.id, repo.id));
    // The new name may have been a former name of some repository (even this one): it is taken over.
    await clearRepositoryRedirects(org.id, org.slug, newName, tx);
    await addRepositoryRedirect(org.slug, oldName, repo.id, session.user.id, tx);
  });

  await recordAudit({
    action: "repo.rename",
    organizationId: org.id,
    targetType: "repository",
    targetId: repo.id,
    targetLabel: `${org.slug}/${newName}`,
    details: { from: `${org.slug}/${oldName}`, to: `${org.slug}/${newName}` },
  });
  after(() =>
    emitRepositoryEvent(repo.id, "repository.renamed", {
      previous: { organization: org.slug, name: oldName, path: `${org.slug}/${oldName}` },
      actor: { type: "user", id: session.user.id, name: session.user.name },
    }).catch((err) => console.error("repository.renamed webhook failed:", err)),
  );
  revalidatePath(`/${org.slug}`);
  revalidatePath(repoHref(org.slug, oldName));
  revalidatePath(repoHref(org.slug, newName));
  return { href: repoHref(org.slug, newName), pullReference: imageReference(env.registryHost, org.slug, newName) };
}

/** Bytes of the repository's blobs the target organization does not hold yet (what the transfer adds to its storage). */
async function bytesNewToOrg(repositoryId: string, organizationId: string): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT COALESCE(sum(b.size), 0)::bigint AS bytes
    FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest
    WHERE rb.repository_id = ${repositoryId}
      AND NOT EXISTS (
        SELECT 1 FROM repository_blobs o JOIN repositories r ON r.id = o.repository_id
        WHERE o.blob_digest = rb.blob_digest AND r.organization_id = ${organizationId})`);
  return Number(rows[0]?.bytes ?? 0);
}

/**
 * Move a repository to another organization. The caller must manage both
 * (instance admins manage everything); the target's repository and storage
 * quotas apply as for a new push there.
 */
export async function transferRepository(formData: FormData): Promise<RepoToolResult> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const targetId = String(formData.get("targetOrganizationId") ?? "");
  const session = await requireSession();
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." };
  const sourceRole = await getOrgRole(repo.organizationId);
  if (!sourceRole || !MANAGER_ROLES.includes(sourceRole)) return denied();
  const source = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  const target = await db.query.organization.findFirst({ where: eq(organization.id, targetId) });
  if (!source || !target) return { error: "Organization not found." };
  if (target.id === source.id) return { error: "The repository is already in that organization." };
  const targetRole = await getOrgRole(target.id);
  if (!targetRole || !MANAGER_ROLES.includes(targetRole)) {
    return { error: `You need to be an owner or admin of ${target.name} to move a repository there.` };
  }
  if (await isProxyOrg(source.id)) return { error: "Repositories in a proxy cache cannot be moved." };
  if (await isProxyOrg(target.id)) return { error: `${target.name} is a proxy cache; only its upstream fills it.` };
  const problem = repoNameProblem(repo.name, false);
  if (problem) return { error: `The name ${repo.name} is not valid in ${target.slug}: ${problem}` };
  const taken = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, target.id), eq(repositories.name, repo.name)),
    columns: { id: true },
  });
  if (taken) return { error: `${target.slug} already has a repository named ${repo.name}; rename one of them first.` };

  const quota = await checkRepoQuota(target.id, repo.visibility, target.name);
  if (quota) return { error: quota };
  const additional = await bytesNewToOrg(repo.id, target.id);
  const storage = await checkStorageQuota(target.id, additional);
  if (storage) return { error: `${target.name}: ${storage}` };

  await db.transaction(async (tx) => {
    await tx.update(repositories).set({ organizationId: target.id, updatedAt: new Date() }).where(eq(repositories.id, repo.id));
    // Repository-scoped rules and policies belong to the repository and move
    // with it (their organization column must follow the row).
    await tx.update(tagRules).set({ organizationId: target.id }).where(eq(tagRules.repositoryId, repo.id));
    await tx.update(retentionPolicies).set({ organizationId: target.id }).where(eq(retentionPolicies.repositoryId, repo.id));
    await clearRepositoryRedirects(target.id, target.slug, repo.name, tx);
    await addRepositoryRedirect(source.slug, repo.name, repo.id, session.user.id, tx);
  });

  const details = { from: `${source.slug}/${repo.name}`, to: `${target.slug}/${repo.name}`, fromOrganizationId: source.id, toOrganizationId: target.id, visibility: repo.visibility, bytesAdded: additional };
  await recordAudit({ action: "repo.transfer", organizationId: source.id, targetType: "repository", targetId: repo.id, targetLabel: `${target.slug}/${repo.name}`, details });
  await recordAudit({ action: "repo.transfer", organizationId: target.id, targetType: "repository", targetId: repo.id, targetLabel: `${target.slug}/${repo.name}`, details });
  after(async () => {
    // The pull policy is the target organization's now.
    await refreshRepositoryBlocks(repo.id).catch((err) => console.error("pull policy refresh after transfer failed:", err));
    await checkQuotaWarnings(target.id).catch((err) => console.error("quota warning check failed:", err));
    await emitRepositoryEvent(repo.id, "repository.transferred", {
      previous: { organization: source.slug, name: repo.name, path: `${source.slug}/${repo.name}` },
      actor: { type: "user", id: session.user.id, name: session.user.name },
    }).catch((err) => console.error("repository.transferred webhook failed:", err));
  });
  revalidatePath(`/${source.slug}`);
  revalidatePath(`/${target.slug}`);
  revalidatePath(repoHref(source.slug, repo.name));
  revalidatePath(repoHref(target.slug, repo.name));
  return { href: repoHref(target.slug, repo.name), pullReference: imageReference(env.registryHost, target.slug, repo.name) };
}

/** Change an organization's slug (its image namespace); owners only, never `library`. */
export async function renameOrganization(formData: FormData): Promise<RepoToolResult> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const newSlug = String(formData.get("slug") ?? "").trim().toLowerCase();
  const session = await requireSession();
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (!org) return { error: "Organization not found." };
  const role = await getOrgRole(org.id);
  if (role !== "owner") return { error: "Only organization owners can rename the organization." };
  if (org.slug === LIBRARY_SLUG || newSlug === LIBRARY_SLUG) return { error: "The library organization cannot be renamed." };
  if (!ORG_SLUG_RE.test(newSlug)) {
    return { error: "Organization slugs use lowercase letters, digits and single ._- separators (the slug is the image namespace)." };
  }
  if (RESERVED_SLUGS.has(newSlug)) return { error: `"${newSlug}" is reserved; pick a different slug.` };
  if (newSlug === org.slug) return { error: "That is already the organization's slug." };
  const taken = await db.query.organization.findFirst({ where: eq(organization.slug, newSlug), columns: { id: true } });
  if (taken) return { error: `The slug ${newSlug} is already in use.` };

  const oldSlug = org.slug;
  // Members go through better-auth (its hooks and audit apply); instance
  // administrators are usually not members, so they update the row directly.
  try {
    const auth = await getAuth();
    await auth.api.updateOrganization({ headers: await headers(), body: { organizationId: org.id, data: { slug: newSlug } } });
  } catch (err) {
    if (session.user.role === "admin") {
      await db.update(organization).set({ slug: newSlug }).where(eq(organization.id, org.id));
    } else {
      return { error: isAPIError(err) ? err.message : "Could not rename the organization." };
    }
  }
  await clearOrganizationRedirect(newSlug);
  await addOrganizationRedirect(oldSlug, org.id, session.user.id);

  await recordAudit({
    action: "org.rename",
    organizationId: org.id,
    targetType: "organization",
    targetId: org.id,
    targetLabel: newSlug,
    details: { from: oldSlug, to: newSlug, name: org.name },
  });
  revalidatePath(`/${oldSlug}`);
  revalidatePath(`/${newSlug}`);
  return { href: `/${newSlug}/settings/danger`, pullReference: `${env.registryHost}/${newSlug}/<repository>` };
}
