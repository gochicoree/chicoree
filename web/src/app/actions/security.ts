"use server";

// Accepted risks (vulnerability exceptions): organization owners and admins
// take a finding out of the pull policy for one repository or the whole
// organization, with a justification and an optional expiry.
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, repositories, vulnerabilityExceptions } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { recordAudit } from "@/lib/audit";
import { createException, deleteException } from "@/lib/security";
import { normalizeVulnerabilityId } from "@/lib/scanner-shared";
import { repoHref } from "@/lib/proxy-shared";

export interface ExceptionResult {
  error?: string;
  saved?: boolean;
  id?: string;
}

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

function parseExpiry(fd: FormData): { expiresAt: Date | null } | { error: string } {
  const days = str(fd, "expiresInDays");
  const date = str(fd, "expiresAt");
  if (date) {
    const t = Date.parse(date);
    if (!Number.isFinite(t)) return { error: "The expiry date is not a valid date." };
    if (t <= Date.now()) return { error: "The expiry date must be in the future." };
    return { expiresAt: new Date(t) };
  }
  if (!days || days === "0" || days === "never") return { expiresAt: null };
  const n = Number(days);
  if (!Number.isInteger(n) || n <= 0 || n > 3650) return { error: "Expiry must be a number of days between 1 and 3650." };
  return { expiresAt: new Date(Date.now() + n * 86_400_000) };
}

/** Accept the risk of one vulnerability (optionally in one package) for a repository or its organization. */
export async function acceptRiskAction(_prev: ExceptionResult | null, fd: FormData): Promise<ExceptionResult> {
  const session = await requireSession();
  const organizationId = str(fd, "organizationId");
  const repositoryIdRaw = str(fd, "repositoryId");
  const scope = str(fd, "scope") === "organization" ? "organization" : "repository";
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can accept risks." };

  const vulnerabilityId = normalizeVulnerabilityId(str(fd, "vulnerabilityId"));
  if (!vulnerabilityId || vulnerabilityId.length > 120) return { error: "A vulnerability id (CVE-…, GHSA-…) is required." };
  const pkg = str(fd, "package") || null;
  const justification = str(fd, "justification");
  if (justification.length < 3) return { error: "Please give a justification (at least a few words)." };
  if (justification.length > 2000) return { error: "The justification is too long (2000 characters max)." };
  const expiry = parseExpiry(fd);
  if ("error" in expiry) return { error: expiry.error };

  let repositoryId: string | null = null;
  let repoName: string | null = null;
  if (scope === "repository") {
    if (!repositoryIdRaw) return { error: "Repository is required for a repository-scoped exception." };
    const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryIdRaw) });
    if (!repo || repo.organizationId !== organizationId) return { error: "Repository not found." };
    repositoryId = repo.id;
    repoName = repo.name;
  }

  const row = await createException({
    organizationId,
    repositoryId,
    vulnerabilityId,
    package: pkg,
    justification,
    expiresAt: expiry.expiresAt,
    createdBy: session.user.id,
  });
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  await recordAudit({
    action: "security.exception.create",
    organizationId,
    targetType: "vulnerability",
    targetId: vulnerabilityId,
    targetLabel: repoName ? `${org?.slug}/${repoName}: ${vulnerabilityId}` : `${org?.slug}: ${vulnerabilityId}`,
    details: { scope, repositoryId, package: pkg, expiresAt: expiry.expiresAt?.toISOString() ?? null, exceptionId: row.id },
  });
  if (org) {
    revalidatePath(`/${org.slug}`, "layout");
    if (repoName) revalidatePath(repoHref(org.slug, repoName), "layout");
    revalidatePath("/admin/security");
  }
  return { saved: true, id: row.id };
}

/** Revoke an accepted risk; the pull policy sees the finding again right away. */
export async function revokeExceptionAction(_prev: ExceptionResult | null, fd: FormData): Promise<ExceptionResult> {
  await requireSession();
  const id = str(fd, "id");
  const existing = await db.query.vulnerabilityExceptions.findFirst({ where: eq(vulnerabilityExceptions.id, id) });
  if (!existing) return { error: "Exception not found." };
  const role = await getOrgRole(existing.organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can revoke exceptions." };
  await deleteException(id);
  const org = await db.query.organization.findFirst({ where: eq(organization.id, existing.organizationId) });
  const repo = existing.repositoryId ? await db.query.repositories.findFirst({ where: eq(repositories.id, existing.repositoryId) }) : null;
  await recordAudit({
    action: "security.exception.revoke",
    organizationId: existing.organizationId,
    targetType: "vulnerability",
    targetId: existing.vulnerabilityId,
    targetLabel: repo ? `${org?.slug}/${repo.name}: ${existing.vulnerabilityId}` : `${org?.slug}: ${existing.vulnerabilityId}`,
    details: { scope: existing.repositoryId ? "repository" : "organization", repositoryId: existing.repositoryId, package: existing.package, exceptionId: id },
  });
  if (org) {
    revalidatePath(`/${org.slug}`, "layout");
    if (repo) revalidatePath(repoHref(org.slug, repo.name), "layout");
    revalidatePath("/admin/security");
  }
  return { saved: true };
}
