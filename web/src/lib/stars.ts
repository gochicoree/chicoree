// Stars and recently viewed repositories (web app only; registryd never
// reads these tables). Lists reuse the repository listing projection from
// lib/data.ts and the viewer filter, so a repository that went private after
// it was starred or visited disappears from the dashboard.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { repositoryStars } from "@/db/schema";
import { mapRepoRow, repoListSelect, type RepoListItem } from "./data";
import { visibleRepositoriesFilter, type Viewer } from "./viewer";

export interface StarState {
  count: number;
  starred: boolean;
}

export async function repoStarState(repositoryId: string, userId: string | null): Promise<StarState> {
  const { rows } = await db.execute(sql`
    SELECT count(*)::int AS count,
      bool_or(user_id = ${userId ?? ""}) AS starred
    FROM repository_stars WHERE repository_id = ${repositoryId}`);
  const r = rows[0];
  return { count: Number(r?.count ?? 0), starred: Boolean(r?.starred) };
}

/** Star or unstar; returns the new state. Idempotent. */
export async function setStar(userId: string, repositoryId: string, starred: boolean): Promise<StarState> {
  if (starred) {
    await db.insert(repositoryStars).values({ userId, repositoryId }).onConflictDoNothing();
  } else {
    await db.delete(repositoryStars).where(and(eq(repositoryStars.userId, userId), eq(repositoryStars.repositoryId, repositoryId)));
  }
  return repoStarState(repositoryId, userId);
}

export interface StarredRepo extends RepoListItem {
  starredAt: Date;
}

/** The viewer's starred repositories, newest star first. */
export async function listStarredRepos(viewer: Viewer, userId: string, limit = 50): Promise<StarredRepo[]> {
  const { rows } = await db.execute(sql`
    SELECT ${repoListSelect}, s.created_at AS starred_at
    FROM repository_stars s
    JOIN repositories r ON r.id = s.repository_id
    JOIN organization o ON o.id = r.organization_id
    WHERE s.user_id = ${userId} AND ${visibleRepositoriesFilter(viewer)}
    ORDER BY s.created_at DESC
    LIMIT ${limit}`);
  return rows.map((r) => ({ ...mapRepoRow(r), starredAt: new Date(r.starred_at as string) }));
}

export interface VisitedRepo extends RepoListItem {
  lastVisitedAt: Date;
  visits: number;
}

/** Repositories the user opened, most recent first. */
export async function listRecentlyViewed(viewer: Viewer, userId: string, limit = 50): Promise<VisitedRepo[]> {
  const { rows } = await db.execute(sql`
    SELECT ${repoListSelect}, v.last_visited_at, v.visits
    FROM repository_visits v
    JOIN repositories r ON r.id = v.repository_id
    JOIN organization o ON o.id = r.organization_id
    WHERE v.user_id = ${userId} AND ${visibleRepositoriesFilter(viewer)}
    ORDER BY v.last_visited_at DESC
    LIMIT ${limit}`);
  return rows.map((r) => ({ ...mapRepoRow(r), lastVisitedAt: new Date(r.last_visited_at as string), visits: Number(r.visits) }));
}

/**
 * Upsert a page view. A row is touched at most once a minute per user and
 * repository, so reloads and tab-switching do not turn into write storms.
 */
export async function recordRepositoryVisit(userId: string, repositoryId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO repository_visits (user_id, repository_id, last_visited_at, visits)
    VALUES (${userId}, ${repositoryId}, now(), 1)
    ON CONFLICT (user_id, repository_id) DO UPDATE
      SET visits = repository_visits.visits + 1, last_visited_at = now()
      WHERE repository_visits.last_visited_at < now() - interval '1 minute'`);
}
