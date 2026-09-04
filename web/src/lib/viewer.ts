// Who is looking, and which repositories they may see. Search, the explore
// page and the dashboard lists all filter through `visibleRepositoriesFilter`
// so a private repository never shows up for someone outside its organization.
// The rule matches lib/access.ts (the docker token service): public
// repositories for everyone, private ones for members of the organization,
// everything for instance administrators.
import { sql, type SQL } from "drizzle-orm";

export type Viewer = { kind: "anonymous" } | { kind: "user"; userId: string; isAdmin: boolean };

export const ANONYMOUS: Viewer = { kind: "anonymous" };

/** A viewer from a better-auth session (null = anonymous). */
export function viewerFromSession(session: { user: { id: string; role?: string | null } } | null | undefined): Viewer {
  if (!session) return ANONYMOUS;
  return { kind: "user", userId: session.user.id, isAdmin: session.user.role === "admin" };
}

/**
 * SQL condition over a `repositories` row aliased as `r`. Compose it into a
 * WHERE clause: `WHERE ... AND ${visibleRepositoriesFilter(viewer)}`.
 */
export function visibleRepositoriesFilter(viewer: Viewer): SQL {
  if (viewer.kind === "anonymous") return sql`r.visibility = 'public'`;
  if (viewer.isAdmin) return sql`TRUE`;
  return sql`(r.visibility = 'public' OR r.organization_id IN (SELECT organization_id FROM member WHERE user_id = ${viewer.userId}))`;
}

/** Condition over an `organization` row aliased as `o`: the viewer is a member (admins: always). */
export function memberOfOrganizationFilter(viewer: Viewer): SQL {
  if (viewer.kind === "anonymous") return sql`FALSE`;
  if (viewer.isAdmin) return sql`TRUE`;
  return sql`EXISTS (SELECT 1 FROM member mv WHERE mv.organization_id = o.id AND mv.user_id = ${viewer.userId})`;
}
