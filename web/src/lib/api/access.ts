// What an API caller may see and do. Mirrors the rules of the web UI
// (lib/viewer.ts for visibility, lib/org-roles.ts for roles) and of the
// docker token service (lib/access.ts for token scope and restrictions):
//
// - anonymous callers see public repositories;
// - users see public repositories plus those of organizations they belong
//   to (instance administrators: everything); a token limited to an
//   organization or a repository list sees nothing outside it;
// - service accounts see public repositories plus their organization's
//   (or their repository list);
// - writes need a write-scope token; managing a repository needs the owner
//   or admin role; deleting images is also open to `admin` service accounts.
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { member, organization, organizationProxies, repositories } from "@/db/schema";
import { MANAGER_ROLES, WRITER_ROLES, type OrgRole } from "@/lib/org-roles";
import { restrictionAllows } from "@/lib/token-policy-shared";
import { memberOfOrganizationFilter, visibleRepositoriesFilter } from "@/lib/viewer";
import type { ApiCaller } from "./auth";
import { forbidden, notFound } from "./respond";

export type OrgRow = typeof organization.$inferSelect;
export type RepoRow = typeof repositories.$inferSelect;

function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/** Condition over `repositories r` (joined with `organization o`): rows the caller may see. */
export function repoFilter(c: ApiCaller): SQL {
  switch (c.kind) {
    case "anonymous":
      return sql`r.visibility = 'public'`;
    case "sa": {
      const ids = c.caller.repositoryIds;
      const own =
        ids && ids.length > 0
          ? sql`(r.organization_id = ${c.caller.organizationId} AND r.id IN (${idList(ids)}))`
          : sql`r.organization_id = ${c.caller.organizationId}`;
      return sql`(r.visibility = 'public' OR ${own})`;
    }
    case "user": {
      const base = visibleRepositoriesFilter(c.viewer);
      const rs = c.caller.restriction;
      if (!rs) return base;
      const within =
        rs.repositoryIds && rs.repositoryIds.length > 0
          ? sql`(r.organization_id = ${rs.organizationId} AND r.id IN (${idList(rs.repositoryIds)}))`
          : sql`r.organization_id = ${rs.organizationId}`;
      return sql`(${base} AND ${within})`;
    }
  }
}

/** Condition over `organization o`: organizations the caller belongs to or can see a repository of. */
export function orgFilter(c: ApiCaller): SQL {
  const hasVisibleRepo = sql`EXISTS (SELECT 1 FROM repositories r WHERE r.organization_id = o.id AND ${repoFilter(c)})`;
  switch (c.kind) {
    case "anonymous":
      return hasVisibleRepo;
    case "sa":
      return sql`(o.id = ${c.caller.organizationId} OR ${hasVisibleRepo})`;
    case "user": {
      const rs = c.caller.restriction;
      if (rs) return sql`o.id = ${rs.organizationId}`;
      return sql`(${memberOfOrganizationFilter(c.viewer)} OR ${hasVisibleRepo})`;
    }
  }
}

/** The caller's role in an organization: admins act as owners; service accounts and anonymous callers have none. */
export async function orgRole(c: ApiCaller, organizationId: string): Promise<OrgRole | null> {
  if (c.kind !== "user") return null;
  if (c.caller.isAdmin) return "owner";
  const m = await db.query.member.findFirst({ where: and(eq(member.organizationId, organizationId), eq(member.userId, c.user.id)) });
  return (m?.role as OrgRole) ?? null;
}

export interface OrgAccess {
  org: OrgRow;
  role: OrgRole | null;
  /** The organization is a proxy cache. */
  proxy: boolean;
}

/** An organization the caller may see (404 otherwise). */
export async function loadOrg(c: ApiCaller, slug: string): Promise<OrgAccess> {
  const { rows } = await db.execute(sql`
    SELECT o.id FROM organization o WHERE o.slug = ${slug} AND ${orgFilter(c)} LIMIT 1`);
  const id = rows[0]?.id as string | undefined;
  if (!id) throw notFound("No such organization.");
  const [org, role, proxy] = await Promise.all([
    db.query.organization.findFirst({ where: eq(organization.id, id) }),
    orgRole(c, id),
    db.query.organizationProxies.findFirst({ where: eq(organizationProxies.organizationId, id), columns: { organizationId: true } }),
  ]);
  if (!org) throw notFound("No such organization.");
  return { org, role, proxy: !!proxy };
}

export interface RepoAccess extends OrgAccess {
  repo: RepoRow;
  can: {
    /** Change settings, delete the repository, read the audit log: owner / admin (users only). */
    manage: boolean;
    /** Delete tags and images: managers, plus `admin` service accounts. */
    delete: boolean;
    /** Push: retag, copy images in — owners, admins and members, plus `push` / `admin` service accounts. */
    write: boolean;
  };
}

/** A repository the caller may see (404 otherwise), with what they may do to it. */
export async function loadRepo(c: ApiCaller, orgSlug: string, repoName: string): Promise<RepoAccess> {
  const { rows } = await db.execute(sql`
    SELECT r.id FROM repositories r JOIN organization o ON o.id = r.organization_id
    WHERE o.slug = ${orgSlug} AND r.name = ${repoName} AND ${repoFilter(c)} LIMIT 1`);
  const id = rows[0]?.id as string | undefined;
  if (!id) throw notFound("No such repository.");
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, id) });
  if (!repo) throw notFound("No such repository.");
  const [org, proxy] = await Promise.all([
    db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) }),
    db.query.organizationProxies.findFirst({ where: eq(organizationProxies.organizationId, repo.organizationId), columns: { organizationId: true } }),
  ]);
  if (!org) throw notFound("No such repository.");
  const role = await orgRole(c, org.id);

  let manage = false;
  let del = false;
  let write = false;
  if (c.kind === "user") {
    const inScope = c.caller.patScope !== "read" && restrictionAllows(c.caller.restriction, { organizationId: org.id, repositoryId: repo.id });
    manage = inScope && !!role && MANAGER_ROLES.includes(role);
    del = manage;
    write = inScope && !!role && WRITER_ROLES.includes(role);
  } else if (c.kind === "sa") {
    const listed = !c.caller.repositoryIds || c.caller.repositoryIds.includes(repo.id);
    const own = c.caller.organizationId === org.id && listed;
    del = own && c.caller.permission === "admin";
    write = own && c.caller.permission !== "pull";
  }
  // Proxy caches are filled by their upstream only.
  if (proxy) write = false;
  return { org, role, proxy: !!proxy, repo, can: { manage, delete: del, write } };
}

/** Why a write is refused, worded for the credential in use. */
function denial(c: ApiCaller, what: string): never {
  if (c.kind === "anonymous") throw forbidden(`Sign in or send a token to ${what}.`);
  if (c.kind === "user" && c.caller.patScope === "read") throw forbidden(`This access token is read-only; ${what} needs a read & write token.`);
  if (c.kind === "user" && c.caller.restriction) throw forbidden(`This access token is limited to another organization or repository; it cannot ${what}.`);
  throw forbidden(`You don't have permission to ${what}.`);
}

export function requireManage(c: ApiCaller, a: RepoAccess, what = "change this repository"): void {
  if (c.kind === "sa") throw forbidden(`Service accounts cannot ${what}; only organization owners and admins can.`);
  if (!a.can.manage) denial(c, what);
}

export function requireDelete(c: ApiCaller, a: RepoAccess, what = "delete images here"): void {
  if (!a.can.delete) {
    if (c.kind === "sa") throw forbidden(`This service account cannot ${what}; it needs the admin permission in this organization.`);
    denial(c, what);
  }
}

export function requireWrite(c: ApiCaller, a: RepoAccess, what = "push here"): void {
  if (a.proxy) throw forbidden(`${a.org.name} is a proxy cache; only its upstream fills it.`);
  if (!a.can.write) {
    if (c.kind === "sa") throw forbidden(`This service account cannot ${what}; it needs the push or admin permission in this organization.`);
    denial(c, what);
  }
}

/** Owner / admin of the organization, users only (audit log). */
export function requireOrgManager(c: ApiCaller, a: OrgAccess, what = "do that in this organization"): void {
  if (c.kind === "sa") throw forbidden(`Service accounts cannot ${what}.`);
  if (c.kind === "user" && c.caller.restriction && c.caller.restriction.organizationId !== a.org.id) denial(c, what);
  if (!a.role || !MANAGER_ROLES.includes(a.role)) denial(c, what);
}

/** Any member of the organization, users only (member list). */
export function requireOrgMember(c: ApiCaller, a: OrgAccess, what = "see that"): void {
  if (c.kind === "sa") throw forbidden(`Service accounts cannot ${what}.`);
  if (!a.role) denial(c, what);
}

/** Owner / admin / member with a write token that is not limited to a repository list (create repositories). */
export function requireOrgWriter(c: ApiCaller, a: OrgAccess, what = "create repositories here"): void {
  if (c.kind === "sa") throw forbidden(`Service accounts cannot ${what}; push to a new name instead.`);
  if (c.kind === "user") {
    if (c.caller.patScope === "read") denial(c, what);
    const rs = c.caller.restriction;
    if (rs && (rs.organizationId !== a.org.id || rs.repositoryIds)) {
      throw forbidden(`This access token is limited to ${rs.repositoryIds ? "a few repositories" : "another organization"}; it cannot ${what}.`);
    }
  }
  if (!a.role || !WRITER_ROLES.includes(a.role)) denial(c, what);
}

/** Instance administrators only; a read-only token passes when `read` is set (GETs). */
export function requireInstanceAdmin(c: ApiCaller, what = "do that", opts: { read?: boolean } = {}): void {
  if (c.kind !== "user") throw forbidden(`Only instance administrators can ${what}.`);
  if (!opts.read && c.caller.patScope === "read") denial(c, what);
  if (!c.caller.isAdmin) throw forbidden(`Only instance administrators can ${what}.`);
}
