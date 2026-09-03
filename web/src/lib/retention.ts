// Retention policies: load the effective policy for a repository, plan what
// it would remove (lib/retention-shared.ts), and apply the plan through the
// existing tag / manifest delete paths. Used by the settings pages (preview,
// run now) and the `retention` job.
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { retentionPolicies } from "@/db/schema";
import { deleteManifestByDigest, listUntaggedManifests } from "./manifests";
import { planRetention, type RetentionPlan, type RetentionSettings } from "./retention-shared";
import { deleteTag } from "./tag-admin";
import { effectiveTagRules } from "./tag-rules";

export * from "./retention-shared";

export type RetentionPolicyRow = typeof retentionPolicies.$inferSelect;

export function toSettings(row: RetentionPolicyRow | null | undefined): RetentionSettings | null {
  if (!row) return null;
  return {
    enabled: row.enabled,
    keepLast: row.keepLast,
    keepMatching: row.keepMatching,
    deleteOlderThanDays: row.deleteOlderThanDays,
    deleteUntaggedAfterDays: row.deleteUntaggedAfterDays,
  };
}

/** The organization default and, when given, the repository's own row. */
export async function getRetentionPolicies(organizationId: string, repositoryId?: string) {
  const [org, repo] = await Promise.all([
    db.query.retentionPolicies.findFirst({
      where: and(eq(retentionPolicies.organizationId, organizationId), isNull(retentionPolicies.repositoryId)),
    }),
    repositoryId
      ? db.query.retentionPolicies.findFirst({ where: eq(retentionPolicies.repositoryId, repositoryId) })
      : Promise.resolve(undefined),
  ]);
  return { org: org ?? null, repo: repo ?? null };
}

export interface EffectiveRetention {
  policy: RetentionSettings;
  scope: "repository" | "organization";
}

/**
 * The policy that governs a repository: its own row when it has one (even a
 * disabled one — it replaces the organization's entirely), else the
 * organization default, else null.
 */
export function pickEffective(rows: { org: RetentionPolicyRow | null; repo: RetentionPolicyRow | null }): EffectiveRetention | null {
  if (rows.repo) return { policy: toSettings(rows.repo)!, scope: "repository" };
  if (rows.org) return { policy: toSettings(rows.org)!, scope: "organization" };
  return null;
}

/** Plan one repository under a given policy (tags, untagged manifests, rules loaded here). */
export async function planRepository(
  repo: { id: string; organizationId: string },
  policy: RetentionSettings,
  now?: Date,
): Promise<RetentionPlan> {
  const [tagRows, untagged, rules] = await Promise.all([
    db.execute(sql`SELECT name, manifest_digest, updated_at FROM tags WHERE repository_id = ${repo.id}`),
    listUntaggedManifests(repo.id),
    effectiveTagRules(repo.organizationId, repo.id),
  ]);
  return planRetention({
    tags: tagRows.rows.map((r) => ({
      name: r.name as string,
      digest: r.manifest_digest as string,
      pushedAt: new Date(r.updated_at as string),
    })),
    untagged: untagged.map((m) => ({
      digest: m.digest,
      pushedAt: m.pushedAt,
      isChild: m.isChild,
      isReferrer: m.isReferrer,
      hasReferrers: m.referrerCount > 0,
    })),
    policy,
    rules,
    now,
  });
}

export interface RepositoryPlan {
  repositoryId: string;
  /** "org/name" */
  path: string;
  scope: "repository" | "organization";
  policy: RetentionSettings;
  plan: RetentionPlan;
}

interface RepoRow {
  id: string;
  organizationId: string;
  orgSlug: string;
  name: string;
}

async function listRepositories(filter: { organizationId?: string; organizationSlug?: string; repositoryId?: string; repositoryPath?: string }): Promise<RepoRow[]> {
  const where: ReturnType<typeof sql>[] = [];
  if (filter.organizationId) where.push(sql`r.organization_id = ${filter.organizationId}`);
  if (filter.organizationSlug) where.push(sql`o.slug = ${filter.organizationSlug}`);
  if (filter.repositoryId) where.push(sql`r.id = ${filter.repositoryId}`);
  if (filter.repositoryPath) {
    const [slug, name] = filter.repositoryPath.includes("/") ? filter.repositoryPath.split("/", 2) : ["library", filter.repositoryPath];
    where.push(sql`o.slug = ${slug} AND r.name = ${name}`);
  }
  const { rows } = await db.execute(sql`
    SELECT r.id, r.organization_id, o.slug AS org_slug, r.name
    FROM repositories r JOIN organization o ON o.id = r.organization_id
    ${where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``}
    ORDER BY o.slug, r.name`);
  return rows.map((r) => ({
    id: r.id as string,
    organizationId: r.organization_id as string,
    orgSlug: r.org_slug as string,
    name: r.name as string,
  }));
}

/**
 * Plan a scope for the settings pages. `override` stands in for the scope's
 * own (possibly unsaved) policy: for a repository it is used as-is; for an
 * organization it replaces the organization default, while repositories
 * that carry their own policy keep it. Repositories without an enabled
 * policy are omitted.
 */
export async function planScope(opts: {
  organizationId: string;
  repositoryId?: string;
  override?: RetentionSettings;
}): Promise<RepositoryPlan[]> {
  const repos = await listRepositories(
    opts.repositoryId ? { repositoryId: opts.repositoryId } : { organizationId: opts.organizationId },
  );
  const out: RepositoryPlan[] = [];
  const now = new Date();
  for (const repo of repos) {
    const rows = await getRetentionPolicies(repo.organizationId, repo.id);
    let effective: EffectiveRetention | null;
    if (opts.repositoryId) {
      effective = opts.override ? { policy: opts.override, scope: "repository" } : pickEffective(rows);
    } else if (rows.repo) {
      effective = { policy: toSettings(rows.repo)!, scope: "repository" };
    } else if (opts.override) {
      effective = { policy: opts.override, scope: "organization" };
    } else {
      effective = pickEffective(rows);
    }
    if (!effective) continue;
    // A preview of the scope's own policy ignores its enabled flag; inherited
    // or overriding policies only count when they are switched on.
    const previewed = opts.override && effective.scope === (opts.repositoryId ? "repository" : "organization");
    if (!previewed && !effective.policy.enabled) continue;
    out.push({
      repositoryId: repo.id,
      path: `${repo.orgSlug}/${repo.name}`,
      scope: effective.scope,
      policy: effective.policy,
      plan: await planRepository(repo, effective.policy, now),
    });
  }
  return out;
}

export interface RetentionDetailLine {
  repository: string;
  kind: "tag" | "manifest";
  /** Tag name or digest. */
  ref: string;
  reason: string;
  status: "planned" | "deleted" | "failed";
  error?: string;
}

export interface RetentionRunResult extends Record<string, unknown> {
  dryRun: boolean;
  organization?: string;
  repository?: string;
  /** Repositories with an enabled policy. */
  repositories: number;
  tags: { planned: number; deleted: number; failed: number };
  manifests: { planned: number; deleted: number; failed: number };
  perRepository: { repository: string; scope: "repository" | "organization"; tags: number; manifests: number; failed: number }[];
  /** What was (or would be) deleted, capped; `truncated` counts the rest. */
  detail: RetentionDetailLine[];
  truncated: number;
}

const MAX_DETAIL_LINES = 300;

/**
 * Walk every repository with an enabled policy (optionally one organization
 * or one repository) and delete what the policy selects — or only report it
 * when dryRun. Deletions go through the registry as `subject`.
 */
export async function runRetention(opts: {
  dryRun: boolean;
  organizationSlug?: string;
  repositoryPath?: string;
  subject: string;
}): Promise<RetentionRunResult> {
  const result: RetentionRunResult = {
    dryRun: opts.dryRun,
    ...(opts.organizationSlug ? { organization: opts.organizationSlug } : {}),
    ...(opts.repositoryPath ? { repository: opts.repositoryPath } : {}),
    repositories: 0,
    tags: { planned: 0, deleted: 0, failed: 0 },
    manifests: { planned: 0, deleted: 0, failed: 0 },
    perRepository: [],
    detail: [],
    truncated: 0,
  };
  const push = (line: RetentionDetailLine) => {
    if (result.detail.length < MAX_DETAIL_LINES) result.detail.push(line);
    else result.truncated++;
  };

  const repos = await listRepositories({ organizationSlug: opts.organizationSlug, repositoryPath: opts.repositoryPath });
  const now = new Date();
  for (const repo of repos) {
    const effective = pickEffective(await getRetentionPolicies(repo.organizationId, repo.id));
    if (!effective?.policy.enabled) continue;
    result.repositories++;
    const path = `${repo.orgSlug}/${repo.name}`;
    const plan = await planRepository(repo, effective.policy, now);
    const per = { repository: path, scope: effective.scope, tags: 0, manifests: 0, failed: 0 };

    for (const t of plan.tags) {
      result.tags.planned++;
      if (opts.dryRun) {
        per.tags++;
        push({ repository: path, kind: "tag", ref: t.name, reason: t.reason, status: "planned" });
        continue;
      }
      try {
        // Retention only removes; it never re-points "latest" the way a
        // manual deletion does.
        await deleteTag(repo.id, t.name, opts.subject, { moveLatest: false });
        result.tags.deleted++;
        per.tags++;
        push({ repository: path, kind: "tag", ref: t.name, reason: t.reason, status: "deleted" });
      } catch (err) {
        result.tags.failed++;
        per.failed++;
        push({ repository: path, kind: "tag", ref: t.name, reason: t.reason, status: "failed", error: errorMessage(err) });
      }
    }
    for (const m of plan.manifests) {
      result.manifests.planned++;
      if (opts.dryRun) {
        per.manifests++;
        push({ repository: path, kind: "manifest", ref: m.digest, reason: m.reason, status: "planned" });
        continue;
      }
      try {
        await deleteManifestByDigest(repo.id, m.digest, opts.subject);
        result.manifests.deleted++;
        per.manifests++;
        push({ repository: path, kind: "manifest", ref: m.digest, reason: m.reason, status: "deleted" });
      } catch (err) {
        result.manifests.failed++;
        per.failed++;
        push({ repository: path, kind: "manifest", ref: m.digest, reason: m.reason, status: "failed", error: errorMessage(err) });
      }
    }
    if (per.tags || per.manifests || per.failed) result.perRepository.push(per);
  }
  return result;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
