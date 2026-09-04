// Rename / transfer redirects. When a repository is renamed or moved to
// another organization, or an organization slug changes, the former name is
// recorded here. registryd (internal/api/redirects.go) serves pulls of the
// old reference from the target; the token endpoint authorizes old names
// against the target (pull only); the web UI answers 308 to the new URL.
// Resolution order matches the Go side: organization redirect first, then
// repository redirects under the requested, current and former slugs.
import { and, eq, inArray, sql } from "drizzle-orm";
import { notFound, permanentRedirect } from "next/navigation";
import { db } from "@/db";
import { organization, organizationRedirects, repositories, repositoryRedirects } from "@/db/schema";
import { repoHref } from "./proxy-shared";

/** `db` or a transaction handle from `db.transaction`. */
type Executor = Pick<typeof db, "insert" | "delete" | "query">;

export interface RepositoryTarget {
  repositoryId: string;
  orgSlug: string;
  repoName: string;
  organizationId: string;
  visibility: "public" | "private";
}

async function targetById(id: string): Promise<RepositoryTarget | null> {
  const { rows } = await db.execute(sql`
    SELECT r.id, r.organization_id, r.visibility, r.name, o.slug
    FROM repositories r JOIN organization o ON o.id = r.organization_id
    WHERE r.id = ${id}`);
  const r = rows[0];
  if (!r) return null;
  return {
    repositoryId: r.id as string,
    organizationId: r.organization_id as string,
    visibility: r.visibility as "public" | "private",
    repoName: r.name as string,
    orgSlug: r.slug as string,
  };
}

/** The organization a former slug now belongs to, or null. */
export async function resolveOrganizationRedirect(oldSlug: string): Promise<{ id: string; slug: string } | null> {
  const { rows } = await db.execute(sql`
    SELECT o.id, o.slug FROM organization_redirects r
    JOIN organization o ON o.id = r.organization_id
    WHERE r.old_slug = ${oldSlug}`);
  const r = rows[0];
  return r ? { id: r.id as string, slug: r.slug as string } : null;
}

/**
 * Where `<orgSlug>/<repoName>` now lives when that exact repository does not
 * exist; null when it exists (no redirect needed) or nothing matches.
 */
export async function resolveRepositoryRedirect(orgSlug: string, repoName: string): Promise<RepositoryTarget | null> {
  const org = await db.query.organization.findFirst({ where: eq(organization.slug, orgSlug), columns: { id: true, slug: true } });
  if (org) {
    const exact = await db.query.repositories.findFirst({
      where: and(eq(repositories.organizationId, org.id), eq(repositories.name, repoName)),
      columns: { id: true },
    });
    if (exact) return null;
  }
  // Cheap short-circuit: most instances never renamed anything.
  const any = await db.execute(sql`SELECT 1 WHERE EXISTS (SELECT 1 FROM repository_redirects) OR EXISTS (SELECT 1 FROM organization_redirects)`);
  if (any.rows.length === 0) return null;

  const slugs = [orgSlug];
  let orgId = org?.id ?? null;
  if (!org) {
    const moved = await resolveOrganizationRedirect(orgSlug);
    if (moved) {
      const there = await db.query.repositories.findFirst({
        where: and(eq(repositories.organizationId, moved.id), eq(repositories.name, repoName)),
        columns: { id: true },
      });
      if (there) return targetById(there.id);
      orgId = moved.id;
      slugs.push(moved.slug);
    }
  }
  if (orgId) {
    const former = await db.query.organizationRedirects.findMany({
      where: eq(organizationRedirects.organizationId, orgId),
      columns: { oldSlug: true },
    });
    slugs.push(...former.map((f) => f.oldSlug));
  }
  const rows = await db.query.repositoryRedirects.findMany({
    where: and(inArray(repositoryRedirects.organizationSlug, slugs), eq(repositoryRedirects.repositoryName, repoName)),
  });
  for (const slug of slugs) {
    const row = rows.find((r) => r.organizationSlug === slug);
    if (!row) continue;
    const target = await targetById(row.repositoryId);
    if (target) return target;
  }
  return null;
}

/**
 * For repository pages: 308 to the new URL when the name is a former one,
 * 404 when nothing matches. `suffix` is the rest of the path (e.g.
 * `/tags/3.20`), appended to the new repository URL.
 */
export async function redirectMovedRepository(orgSlug: string, repoName: string, suffix = ""): Promise<never> {
  const target = await resolveRepositoryRedirect(orgSlug, repoName);
  if (target) permanentRedirect(`${repoHref(target.orgSlug, target.repoName)}${suffix}`);
  notFound();
}

/** For the organization layout: 308 to the current slug, else 404. */
export async function redirectMovedOrganization(slug: string, suffix = ""): Promise<never> {
  const target = await resolveOrganizationRedirect(slug);
  if (target) permanentRedirect(`/${target.slug}${suffix}`);
  notFound();
}

// --- Writes (server actions) ------------------------------------------------

/** Record that `<oldOrgSlug>/<oldName>` now points at the repository. */
export async function addRepositoryRedirect(oldOrgSlug: string, oldName: string, repositoryId: string, createdBy: string | null, executor: Executor = db): Promise<void> {
  await executor
    .insert(repositoryRedirects)
    .values({ organizationSlug: oldOrgSlug, repositoryName: oldName, repositoryId, createdBy })
    .onConflictDoUpdate({
      target: [repositoryRedirects.organizationSlug, repositoryRedirects.repositoryName],
      set: { repositoryId, createdBy, createdAt: new Date() },
    });
}

/**
 * A repository is taking `<name>` in the organization: drop redirects that
 * still point that name (under the current or a former slug) elsewhere.
 * Mirrors what registryd does when a push creates a repository.
 */
export async function clearRepositoryRedirects(organizationId: string, orgSlug: string, name: string, executor: Executor = db): Promise<void> {
  const former = await executor.query.organizationRedirects.findMany({
    where: eq(organizationRedirects.organizationId, organizationId),
    columns: { oldSlug: true },
  });
  const slugs = [orgSlug, ...former.map((f) => f.oldSlug)];
  await executor
    .delete(repositoryRedirects)
    .where(and(eq(repositoryRedirects.repositoryName, name), inArray(repositoryRedirects.organizationSlug, slugs)));
}

/** Record that `oldSlug` now belongs to the organization. */
export async function addOrganizationRedirect(oldSlug: string, organizationId: string, createdBy: string | null, executor: Executor = db): Promise<void> {
  await executor
    .insert(organizationRedirects)
    .values({ oldSlug, organizationId, createdBy })
    .onConflictDoUpdate({ target: organizationRedirects.oldSlug, set: { organizationId, createdBy, createdAt: new Date() } });
}

/** An organization is taking `slug`: a redirect for that slug no longer applies. */
export async function clearOrganizationRedirect(slug: string, executor: Executor = db): Promise<void> {
  await executor.delete(organizationRedirects).where(eq(organizationRedirects.oldSlug, slug));
}

/** Former names of a repository, for the settings page. */
export async function listRepositoryRedirects(repositoryId: string): Promise<{ orgSlug: string; name: string; createdAt: Date }[]> {
  const rows = await db.query.repositoryRedirects.findMany({
    where: eq(repositoryRedirects.repositoryId, repositoryId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  return rows.map((r) => ({ orgSlug: r.organizationSlug, name: r.repositoryName, createdAt: r.createdAt }));
}

/** Former slugs of an organization, for the settings page. */
export async function listOrganizationRedirects(organizationId: string): Promise<{ oldSlug: string; createdAt: Date }[]> {
  const rows = await db.query.organizationRedirects.findMany({
    where: eq(organizationRedirects.organizationId, organizationId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  return rows.map((r) => ({ oldSlug: r.oldSlug, createdAt: r.createdAt }));
}
