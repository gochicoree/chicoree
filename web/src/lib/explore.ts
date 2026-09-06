// The explore overview: what is pulled this week, which organizations
// publish images, what changed recently. Everything goes through the viewer
// filter (public for visitors, plus memberships for users); results for
// visitors are memoised for a minute per replica, since every visitor sees
// the same public picture and the page is reachable without an account.
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { mapRepoRow, repoListSelect, type RepoListItem } from "./data";
import { logoVersionSql } from "./logo";
import { visibleRepositoriesFilter, type Viewer } from "./viewer";

export const TRENDING_DAYS = 7;

export interface TrendingRepo extends RepoListItem {
  /** Pulls in the last TRENDING_DAYS days. */
  recentPulls: number;
}

export interface ExploreOrg {
  id: string;
  slug: string;
  name: string;
  logoVersion: string | null;
  /** Repositories the viewer may see. */
  repoCount: number;
  pullCount: number;
  recentPulls: number;
  lastPushedAt: Date | null;
  proxy: boolean;
}

const MEMO_MS = 60_000;
const memo = new Map<string, { at: number; value: Promise<unknown> }>();

/** Cache a query result for visitors only; users see live data. */
function memoised<T>(viewer: Viewer, key: string, load: () => Promise<T>): Promise<T> {
  if (viewer.kind !== "anonymous") return load();
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}

/** Most pulled repositories of the last week, visible to the viewer. */
export function trendingRepositories(viewer: Viewer, limit = 8): Promise<TrendingRepo[]> {
  return memoised(viewer, `trending:${limit}`, async () => {
    const { rows } = await db.execute(sql`
      SELECT ${repoListSelect}, p.recent_pulls
      FROM (
        SELECT e.repository_id, count(*)::int AS recent_pulls
        FROM events e
        WHERE e.type = 'pull' AND e.created_at > now() - make_interval(days => ${TRENDING_DAYS})
        GROUP BY e.repository_id
      ) p
      JOIN repositories r ON r.id = p.repository_id
      JOIN organization o ON o.id = r.organization_id
      WHERE ${visibleRepositoriesFilter(viewer)}
      ORDER BY p.recent_pulls DESC, r.pull_count DESC, r.updated_at DESC
      LIMIT ${limit}`);
    return rows.map((r) => ({ ...mapRepoRow(r), recentPulls: Number(r.recent_pulls ?? 0) }));
  });
}

/** Organizations with at least one repository the viewer may see, busiest first. */
export function exploreOrganizations(viewer: Viewer): Promise<ExploreOrg[]> {
  return memoised(viewer, "orgs", async () => {
    const { rows } = await db.execute(sql`
      SELECT o.id, o.slug, o.name, ${logoVersionSql("o.logo")} AS logo_version,
        count(*)::int AS repo_count,
        coalesce(sum(r.pull_count), 0)::bigint AS pull_count,
        coalesce((
          SELECT count(*) FROM events e JOIN repositories r ON r.id = e.repository_id
          WHERE r.organization_id = o.id AND e.type = 'pull'
            AND e.created_at > now() - make_interval(days => ${TRENDING_DAYS})
            AND ${visibleRepositoriesFilter(viewer)}
        ), 0)::int AS recent_pulls,
        max(r.updated_at) AS last_pushed_at,
        EXISTS (SELECT 1 FROM organization_proxies px WHERE px.organization_id = o.id) AS proxy
      FROM organization o
      JOIN repositories r ON r.organization_id = o.id
      WHERE ${visibleRepositoriesFilter(viewer)}
      GROUP BY o.id, o.slug, o.name, o.logo
      ORDER BY recent_pulls DESC, pull_count DESC, o.name ASC`);
    return rows.map((r) => ({
      id: r.id as string,
      slug: r.slug as string,
      name: r.name as string,
      logoVersion: (r.logo_version as string | null) ?? null,
      repoCount: Number(r.repo_count ?? 0),
      pullCount: Number(r.pull_count ?? 0),
      recentPulls: Number(r.recent_pulls ?? 0),
      lastPushedAt: r.last_pushed_at ? new Date(r.last_pushed_at as string) : null,
      proxy: !!r.proxy,
    }));
  });
}
