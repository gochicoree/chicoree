// Teams and per-repository grants: what a person may do in one repository,
// and the management of teams and grants with audit entries. The docker
// token service (lib/access.ts) and the REST API (lib/api/access.ts) ask
// `grantedPermission`; pages ask `getRepoContext`.
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { member, organization, repositories, repositoryGrants, teamMembers, teams, user as userTable } from "@/db/schema";
import { recordAudit, type AuditActor } from "./audit";
import { getRepoByPath } from "./data";
import { logoVersionSql } from "./logo";
import type { OrgRole } from "./org-roles";
import { isRepoPermission, maxPermission, permissionFromRole, TEAM_DESCRIPTION_MAX, TEAM_NAME_MAX, TEAM_SLUG_RE, teamSlugFrom, type RepoPermission } from "./repo-access-shared";
import { getOrgContext, getSession } from "./session";

/** The highest permission the user's own grants and team grants give on the repository; null without any. */
export async function grantedPermission(userId: string, repositoryId: string): Promise<RepoPermission | null> {
  const { rows } = await db.execute(sql`
    SELECT g.permission FROM repository_grants g
    WHERE g.repository_id = ${repositoryId}
      AND ((g.subject_type = 'user' AND g.subject_id = ${userId})
        OR (g.subject_type = 'team' AND g.subject_id IN (SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ${userId})))`);
  let best: RepoPermission | null = null;
  for (const r of rows) if (isRepoPermission(String(r.permission))) best = maxPermission(best, String(r.permission) as RepoPermission);
  return best;
}

/** Role baseline plus grants; grants count only for members of the organization. */
export async function effectivePermission(input: { userId: string; isAdmin: boolean; role: OrgRole | string | null; repositoryId: string | null }): Promise<RepoPermission | null> {
  if (input.isAdmin) return "admin";
  const base = permissionFromRole(input.role);
  if (!input.role || !input.repositoryId) return base;
  return maxPermission(base, await grantedPermission(input.userId, input.repositoryId));
}

export interface RepoContext {
  org: typeof organization.$inferSelect;
  repo: typeof repositories.$inferSelect;
  /** Organization role of the signed-in user; null for visitors and non-members. */
  role: OrgRole | null;
  permission: RepoPermission | null;
  can: {
    /** Settings, access, deleting the repository: admin permission. */
    manage: boolean;
    /** Push, retag, copy in, re-verify: push or better (never in a proxy cache). */
    write: boolean;
    /** Delete tags and images: admin permission. */
    delete: boolean;
  };
}

/** A repository page's view of the signed-in user (null when the repository does not exist). */
export async function getRepoContext(orgSlug: string, repoName: string): Promise<RepoContext | null> {
  const found = await getRepoByPath(orgSlug, repoName);
  if (!found) return null;
  const ctx = await getOrgContext(orgSlug);
  const session = await getSession();
  const role = ctx?.role ?? null;
  const permission = session
    ? await effectivePermission({ userId: session.user.id, isAdmin: session.user.role === "admin", role, repositoryId: found.repo.id })
    : null;
  const manage = permission === "admin";
  return {
    org: found.org,
    repo: found.repo,
    role,
    permission,
    can: { manage, write: permission === "push" || permission === "admin", delete: manage },
  };
}

// ---------------------------------------------------------------- teams

type TeamSelect = typeof teams.$inferSelect;
type GrantSelect = typeof repositoryGrants.$inferSelect;
/** Library results are either an error message or the row — never both, so `"error" in res` narrows cleanly. */
export type TeamResult = { error: string; team?: never } | { error?: never; team: TeamSelect };
export type GrantResult = { error: string; grant?: never } | { error?: never; grant: GrantRow | null };
export type GrantRemoveResult = { error: string; grant?: never } | { error?: never; grant: GrantSelect };

export interface TeamRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  memberCount: number;
  createdAt: Date;
}

export async function listTeams(organizationId: string): Promise<TeamRow[]> {
  const { rows } = await db.execute(sql`
    SELECT t.id, t.slug, t.name, t.description, t.created_at,
      (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count
    FROM teams t WHERE t.organization_id = ${organizationId} ORDER BY t.name`);
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    description: String(r.description ?? ""),
    memberCount: Number(r.member_count ?? 0),
    createdAt: new Date(r.created_at as string),
  }));
}

export async function findTeam(organizationId: string, idOrSlug: string) {
  return (await db.query.teams.findFirst({ where: and(eq(teams.organizationId, organizationId), or(eq(teams.id, idOrSlug), eq(teams.slug, idOrSlug))) })) ?? null;
}

export interface TeamMemberRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  logoVersion: string | null;
  addedAt: Date;
}

export async function listTeamMembers(teamId: string): Promise<TeamMemberRow[]> {
  const { rows } = await db.execute(sql`
    SELECT u.id, u.name, u.email, m.role, ${logoVersionSql("u.image")} AS logo_version, tm.created_at
    FROM team_members tm
    JOIN "user" u ON u.id = tm.user_id
    JOIN teams t ON t.id = tm.team_id
    LEFT JOIN member m ON m.organization_id = t.organization_id AND m.user_id = u.id
    WHERE tm.team_id = ${teamId} ORDER BY u.name`);
  return rows.map((r) => ({
    userId: String(r.id),
    name: String(r.name),
    email: String(r.email),
    role: String(r.role ?? ""),
    logoVersion: (r.logo_version as string | null) ?? null,
    addedAt: new Date(r.created_at as string),
  }));
}

export function validateTeamInput(input: { name: string; slug?: string; description?: string }): { ok: true; name: string; slug: string; description: string } | { ok: false; error: string } {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "Enter a team name." };
  if (name.length > TEAM_NAME_MAX) return { ok: false, error: `Team names are limited to ${TEAM_NAME_MAX} characters.` };
  const slug = (input.slug?.trim() || teamSlugFrom(name)).toLowerCase();
  if (!TEAM_SLUG_RE.test(slug)) return { ok: false, error: "Team slugs use lowercase letters, digits and single . _ - separators." };
  const description = (input.description ?? "").trim();
  if (description.length > TEAM_DESCRIPTION_MAX) return { ok: false, error: `Descriptions are limited to ${TEAM_DESCRIPTION_MAX} characters.` };
  return { ok: true, name, slug, description };
}

export async function createTeam(input: { organizationId: string; name: string; slug?: string; description?: string; actor?: AuditActor; actorUserId?: string | null; via?: string }): Promise<TeamResult> {
  const v = validateTeamInput(input);
  if (!v.ok) return { error: v.error };
  const exists = await db.query.teams.findFirst({ where: and(eq(teams.organizationId, input.organizationId), eq(teams.slug, v.slug)), columns: { id: true } });
  if (exists) return { error: `A team with the slug ${v.slug} already exists.` };
  const [row] = await db.insert(teams).values({ organizationId: input.organizationId, name: v.name, slug: v.slug, description: v.description, createdBy: input.actorUserId ?? null }).returning();
  await recordAudit({ action: "team.create", actor: input.actor, organizationId: input.organizationId, targetType: "team", targetId: row.id, targetLabel: v.slug, details: input.via ? { via: input.via } : undefined });
  return { team: row };
}

export async function updateTeam(input: { organizationId: string; teamId: string; name?: string; slug?: string; description?: string; actor?: AuditActor; via?: string }): Promise<TeamResult> {
  const current = await db.query.teams.findFirst({ where: and(eq(teams.id, input.teamId), eq(teams.organizationId, input.organizationId)) });
  if (!current) return { error: "No such team." };
  const v = validateTeamInput({ name: input.name ?? current.name, slug: input.slug ?? current.slug, description: input.description ?? current.description });
  if (!v.ok) return { error: v.error };
  if (v.slug !== current.slug) {
    const clash = await db.query.teams.findFirst({ where: and(eq(teams.organizationId, input.organizationId), eq(teams.slug, v.slug)), columns: { id: true } });
    if (clash) return { error: `A team with the slug ${v.slug} already exists.` };
  }
  const [row] = await db.update(teams).set({ name: v.name, slug: v.slug, description: v.description }).where(eq(teams.id, current.id)).returning();
  await recordAudit({ action: "team.update", actor: input.actor, organizationId: input.organizationId, targetType: "team", targetId: row.id, targetLabel: row.slug, details: { name: row.name, slug: row.slug, ...(input.via ? { via: input.via } : {}) } });
  return { team: row };
}

export async function deleteTeam(input: { organizationId: string; teamId: string; actor?: AuditActor; via?: string }): Promise<TeamResult> {
  const current = await db.query.teams.findFirst({ where: and(eq(teams.id, input.teamId), eq(teams.organizationId, input.organizationId)) });
  if (!current) return { error: "No such team." };
  await db.delete(repositoryGrants).where(and(eq(repositoryGrants.subjectType, "team"), eq(repositoryGrants.subjectId, current.id)));
  await db.delete(teams).where(eq(teams.id, current.id));
  await recordAudit({ action: "team.delete", actor: input.actor, organizationId: input.organizationId, targetType: "team", targetId: current.id, targetLabel: current.slug, details: input.via ? { via: input.via } : undefined });
  return { team: current };
}

/** Only members of the organization can join its teams. */
export async function addTeamMember(input: { organizationId: string; teamId: string; userId: string; actor?: AuditActor; actorUserId?: string | null; via?: string }): Promise<TeamResult> {
  const team = await db.query.teams.findFirst({ where: and(eq(teams.id, input.teamId), eq(teams.organizationId, input.organizationId)) });
  if (!team) return { error: "No such team." };
  const membership = await db.query.member.findFirst({ where: and(eq(member.organizationId, input.organizationId), eq(member.userId, input.userId)), columns: { id: true } });
  if (!membership) return { error: "Only members of the organization can be added to its teams." };
  await db.insert(teamMembers).values({ teamId: team.id, userId: input.userId, addedBy: input.actorUserId ?? null }).onConflictDoNothing();
  const person = await db.query.user.findFirst({ where: eq(userTable.id, input.userId), columns: { email: true } });
  await recordAudit({ action: "team.member.add", actor: input.actor, organizationId: input.organizationId, targetType: "team", targetId: team.id, targetLabel: `${team.slug} · ${person?.email ?? input.userId}`, details: { userId: input.userId, ...(input.via ? { via: input.via } : {}) } });
  return { team };
}

export async function removeTeamMember(input: { organizationId: string; teamId: string; userId: string; actor?: AuditActor; via?: string }): Promise<TeamResult> {
  const team = await db.query.teams.findFirst({ where: and(eq(teams.id, input.teamId), eq(teams.organizationId, input.organizationId)) });
  if (!team) return { error: "No such team." };
  const removed = await db.delete(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, input.userId))).returning({ userId: teamMembers.userId });
  if (removed.length === 0) return { error: "Not a member of this team." };
  const person = await db.query.user.findFirst({ where: eq(userTable.id, input.userId), columns: { email: true } });
  await recordAudit({ action: "team.member.remove", actor: input.actor, organizationId: input.organizationId, targetType: "team", targetId: team.id, targetLabel: `${team.slug} · ${person?.email ?? input.userId}`, details: { userId: input.userId, ...(input.via ? { via: input.via } : {}) } });
  return { team };
}

/** Someone who left the organization leaves its teams and loses their grants (called from the membership hooks). */
export async function dropOrganizationAccess(organizationId: string, userId: string): Promise<void> {
  const teamIds = (await db.select({ id: teams.id }).from(teams).where(eq(teams.organizationId, organizationId))).map((t) => t.id);
  if (teamIds.length > 0) await db.delete(teamMembers).where(and(inArray(teamMembers.teamId, teamIds), eq(teamMembers.userId, userId)));
  const repoIds = (await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.organizationId, organizationId))).map((r) => r.id);
  if (repoIds.length > 0) {
    await db.delete(repositoryGrants).where(and(inArray(repositoryGrants.repositoryId, repoIds), eq(repositoryGrants.subjectType, "user"), eq(repositoryGrants.subjectId, userId)));
  }
}

// ---------------------------------------------------------------- grants

export interface GrantRow {
  id: string;
  subjectType: "user" | "team";
  subjectId: string;
  /** Person's name or team name. */
  label: string;
  /** Person's email or team slug. */
  detail: string;
  permission: RepoPermission;
  logoVersion: string | null;
  createdAt: Date;
}

export async function listRepoGrants(repositoryId: string): Promise<GrantRow[]> {
  const { rows } = await db.execute(sql`
    SELECT g.id, g.subject_type, g.subject_id, g.permission, g.created_at,
      coalesce(u.name, t.name) AS label, coalesce(u.email, t.slug) AS detail,
      CASE WHEN g.subject_type = 'user' THEN ${logoVersionSql("u.image")} END AS logo_version
    FROM repository_grants g
    LEFT JOIN "user" u ON g.subject_type = 'user' AND u.id = g.subject_id
    LEFT JOIN teams t ON g.subject_type = 'team' AND t.id = g.subject_id
    WHERE g.repository_id = ${repositoryId}
    ORDER BY g.subject_type, label`);
  return rows.map((r) => ({
    id: String(r.id),
    subjectType: r.subject_type as "user" | "team",
    subjectId: String(r.subject_id),
    label: String(r.label ?? r.subject_id),
    detail: String(r.detail ?? ""),
    permission: String(r.permission) as RepoPermission,
    logoVersion: (r.logo_version as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
  }));
}

/** Create or change a grant; the subject must belong to the repository's organization. */
export async function setRepoGrant(input: { repositoryId: string; organizationId: string; subjectType: "user" | "team"; subjectId: string; permission: RepoPermission; actor?: AuditActor; actorUserId?: string | null; via?: string }): Promise<GrantResult> {
  if (input.subjectType === "user") {
    const membership = await db.query.member.findFirst({ where: and(eq(member.organizationId, input.organizationId), eq(member.userId, input.subjectId)), columns: { id: true } });
    if (!membership) return { error: "Only members of the organization can be granted access." };
  } else {
    const team = await db.query.teams.findFirst({ where: and(eq(teams.id, input.subjectId), eq(teams.organizationId, input.organizationId)), columns: { id: true } });
    if (!team) return { error: "No such team in this organization." };
  }
  const [row] = await db
    .insert(repositoryGrants)
    .values({ repositoryId: input.repositoryId, subjectType: input.subjectType, subjectId: input.subjectId, permission: input.permission, createdBy: input.actorUserId ?? null })
    .onConflictDoUpdate({ target: [repositoryGrants.repositoryId, repositoryGrants.subjectType, repositoryGrants.subjectId], set: { permission: input.permission, createdBy: input.actorUserId ?? null, createdAt: new Date() } })
    .returning();
  const grants = await listRepoGrants(input.repositoryId);
  const g = grants.find((x) => x.id === row.id);
  await recordAudit({ action: "repo.access.set", actor: input.actor, organizationId: input.organizationId, targetType: "repository", targetId: input.repositoryId, targetLabel: g ? `${g.subjectType} ${g.detail} → ${input.permission}` : input.permission, details: { subjectType: input.subjectType, subjectId: input.subjectId, permission: input.permission, ...(input.via ? { via: input.via } : {}) } });
  return { grant: g ?? null };
}

export async function removeRepoGrant(input: { repositoryId: string; organizationId: string; grantId?: string; subjectType?: "user" | "team"; subjectId?: string; actor?: AuditActor; via?: string }): Promise<GrantRemoveResult> {
  const where = input.grantId
    ? and(eq(repositoryGrants.id, input.grantId), eq(repositoryGrants.repositoryId, input.repositoryId))
    : and(eq(repositoryGrants.repositoryId, input.repositoryId), eq(repositoryGrants.subjectType, input.subjectType ?? "user"), eq(repositoryGrants.subjectId, input.subjectId ?? ""));
  const removed = await db.delete(repositoryGrants).where(where).returning();
  if (removed.length === 0) return { error: "No such grant." };
  const r = removed[0];
  await recordAudit({ action: "repo.access.remove", actor: input.actor, organizationId: input.organizationId, targetType: "repository", targetId: input.repositoryId, targetLabel: `${r.subjectType} ${r.subjectId}`, details: { subjectType: r.subjectType, subjectId: r.subjectId, permission: r.permission, ...(input.via ? { via: input.via } : {}) } });
  return { grant: r };
}
