// Background jobs: maintenance tasks an admin can run from the Jobs page or
// trigger from automation through POST /api/jobs/<name>. Every run is
// recorded in job_runs.
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns, manifests, organization, repositories, tags, vulnerabilityScans } from "@/db/schema";
import { triggerGarbageCollection } from "./registry-client";
import { normalizeLegacyScans, runScan } from "./scan";
import { scanningEnabled } from "./scanners";
import { expireExceptions } from "./security";
import { env } from "./env";
import { runAllMirrors } from "./mirror";
import { evictProxyTags } from "./proxy";
import { notify } from "./notify";
import { PAGE_SIZES, paginatedQuery } from "./paginate-shared";
import { runQuotaEnforcement } from "./quota-enforce";
import { runRetention } from "./retention";
import { reverifyOrganization } from "./signatures";
import { runTokenExpiryReminders } from "./token-expiry";

export interface JobDefinition {
  name: string;
  title: string;
  /** Short label for the job's tab on the admin Jobs page. */
  tab: string;
  description: string;
  /** Documented query/body parameters for the API and the admin form. */
  params: { name: string; description: string; default: string }[];
  run: (params: Record<string, string>) => Promise<Record<string, unknown>>;
}

function durationToMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const m = /^(\d+)([smhd])$/.exec(value.trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

export const JOBS: Record<string, JobDefinition> = {
  gc: {
    name: "gc",
    tab: "GC",
    title: "Garbage collection",
    description:
      "Reclaims blob content no manifest references anymore and sweeps stale upload sessions on the registry.",
    params: [{ name: "grace", description: "Protect blobs newer than this (Go duration)", default: "1h" }],
    run: async (params) => {
      const res = await triggerGarbageCollection(params.grace);
      if (!res.ok) throw new Error(res.error);
      return res.result;
    },
  },

  "scan-stale": {
    name: "scan-stale",
    tab: "Re-scan",
    title: "Re-scan stale images",
    description:
      "Re-scans tagged images with the configured scanner (Administration → Scanning) whose last scan is older than the given age, that were never scanned, or whose last scan failed. olderThan=0s re-scans everything.",
    params: [
      { name: "olderThan", description: "Age threshold, e.g. 7d, 12h", default: "7d" },
      { name: "limit", description: "Maximum images to scan in one run", default: "50" },
    ],
    run: async (params) => {
      if (!(await scanningEnabled())) throw new Error("Scanning is off (Administration → Scanning)");
      const cutoff = new Date(Date.now() - durationToMs(params.olderThan, 7 * 86_400_000));
      const limit = Math.max(1, Math.min(500, Number(params.limit) || 50));
      const { rows } = await db.execute(sql`
        SELECT DISTINCT ON (t.manifest_digest) o.slug || '/' || r.name AS path, t.manifest_digest AS digest
        FROM tags t
        JOIN repositories r ON r.id = t.repository_id
        JOIN organization o ON o.id = r.organization_id
        JOIN manifests m ON m.repository_id = t.repository_id AND m.digest = t.manifest_digest
        LEFT JOIN vulnerability_scans vs ON vs.digest = t.manifest_digest
        WHERE m.media_type NOT LIKE '%index%' AND m.media_type NOT LIKE '%list%'
          AND (vs.digest IS NULL OR vs.updated_at < ${cutoff} OR vs.status = 'failed')
        ORDER BY t.manifest_digest, t.updated_at DESC
        LIMIT ${limit}`);
      let scanned = 0;
      let failed = 0;
      for (const row of rows) {
        try {
          await runScan(row.path as string, row.digest as string);
          scanned++;
        } catch {
          failed++;
        }
      }
      return { candidates: rows.length, scanned, failed };
    },
  },

  "prune-untagged": {
    name: "prune-untagged",
    tab: "Prune untagged",
    title: "Prune untagged manifests",
    description:
      "Deletes manifests that have no tag and are not part of a multi-arch index, older than the given age. Run garbage collection afterwards to reclaim space.",
    params: [{ name: "olderThan", description: "Only prune manifests older than this", default: "14d" }],
    run: async (params) => {
      const cutoff = new Date(Date.now() - durationToMs(params.olderThan, 14 * 86_400_000));
      const { rows } = await db.execute(sql`
        DELETE FROM manifests m
        WHERE m.created_at < ${cutoff}
          AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.repository_id = m.repository_id AND t.manifest_digest = m.digest)
          AND NOT EXISTS (SELECT 1 FROM manifest_refs mr WHERE mr.repository_id = m.repository_id AND mr.ref_digest = m.digest)
        RETURNING m.digest`);
      return { pruned: rows.length };
    },
  },
};

JOBS["mirror-sync"] = {
  name: "mirror-sync",
  tab: "Mirrors",
  title: "Sync mirrors",
  description: "Runs every enabled repository mirror: fetches matching tags from the source registry and imports anything new or changed.",
  params: [],
  run: async () => runAllMirrors(),
};

JOBS["proxy-evict"] = {
  name: "proxy-evict",
  tab: "Proxy eviction",
  title: "Evict unused proxy-cache tags",
  description:
    "Removes tags in proxy-cache organizations that nobody pulled within the window; they are fetched from the upstream again on the next pull. Run prune-untagged and gc afterwards to reclaim the space.",
  params: [
    { name: "unusedFor", description: "Remove tags not pulled for this long, e.g. 30d, 12h", default: "30d" },
    { name: "dryRun", description: "true = only count what would be removed", default: "false" },
  ],
  run: async (params) => evictProxyTags(durationToMs(params.unusedFor, 30 * 86_400_000), params.dryRun === "true"),
};
JOBS.retention = {
  name: "retention",
  tab: "Retention",
  title: "Apply retention policies",
  description:
    "Walks every repository with an enabled retention policy (Settings → Policies) and removes the tags and untagged manifests it selects. Dry run by default: reports what would go without deleting anything. Run garbage collection afterwards to reclaim space.",
  params: [
    { name: "dryRun", description: "true only reports; false deletes", default: "true" },
    { name: "organization", description: "Only this organization (slug)", default: "" },
    { name: "repository", description: "Only this repository (org/name)", default: "" },
  ],
  run: async (params) =>
    runRetention({
      dryRun: params.dryRun !== "false",
      organizationSlug: params.organization || undefined,
      repositoryPath: params.repository || undefined,
      subject: "user:system",
    }),
};

JOBS["quota-enforce"] = {
  name: "quota-enforce",
  tab: "Over the limit",
  title: "Enforce storage limits",
  description:
    "Finds organizations and accounts above their storage limit, tells their owners and, once they have been over for the grace period, removes the oldest images — untagged leftovers first, then tags by last push, protected tags never — until the limit is met, and runs garbage collection. Dry run by default: reports who is over and what would go.",
  params: [
    { name: "graceDays", description: "Days a target may stay over its limit before pruning starts", default: "14" },
    { name: "dryRun", description: "true only reports; false notifies and prunes", default: "true" },
    { name: "organization", description: "Only this organization (slug)", default: "" },
  ],
  run: async (params) =>
    runQuotaEnforcement({
      graceDays: Math.max(0, Math.min(365, Number(params.graceDays) || 14)),
      dryRun: params.dryRun !== "false",
      organizationSlug: params.organization || undefined,
      subject: "user:system",
    }),
};

JOBS["scan-normalize"] = {
  name: "scan-normalize",
  tab: "Scan backfill",
  title: "Normalise legacy scan reports",
  description:
    "One-off backfill after upgrading: turns scan rows that only hold Clair's raw report into normalised findings and fills the scan_findings table behind the CVE search and the security pages. Safe to run repeatedly; does nothing once every row is converted.",
  params: [{ name: "limit", description: "Rows to convert per run", default: "200" }],
  run: async (params) => normalizeLegacyScans(Math.max(1, Math.min(5000, Number(params.limit) || 200))),
};

JOBS["exceptions-expire"] = {
  name: "exceptions-expire",
  tab: "Exceptions",
  title: "Apply expired vulnerability exceptions",
  description:
    "Recomputes pull blocks for organizations whose accepted risks (Security → exceptions) have expired, so the findings count against the pull policy again, and drops exceptions expired for more than 30 days. Schedule it hourly or daily.",
  params: [],
  run: async () => expireExceptions(),
};

JOBS["token-expiry"] = {
  name: "token-expiry",
  tab: "Token expiry",
  title: "Credential expiry reminders",
  description:
    "Emails the owner of every personal access token, and the managers of every organization whose service account, expires within the window — once per credential. Schedule it daily.",
  params: [{ name: "withinDays", description: "Warn about credentials expiring within this many days", default: "7" }],
  run: async (params) => runTokenExpiryReminders(Math.max(1, Math.min(365, Number(params.withinDays) || 7))),
};

JOBS["reverify-signatures"] = {
  name: "reverify-signatures",
  title: "Re-verify signatures",
  tab: "Signatures",
  description:
    "Re-check every cosign signature and attestation against the trusted keys and members' personal keys, then refresh the signature pull blocks. Useful after keys or memberships changed outside the UI.",
  params: [{ name: "organization", description: "Only this organization (slug); empty = every organization", default: "" }],
  run: async (params) => {
    const slug = (params.organization ?? "").trim();
    const orgs = slug
      ? await db.query.organization.findMany({ where: eq(organization.slug, slug), columns: { id: true, slug: true } })
      : await db.query.organization.findMany({ columns: { id: true, slug: true } });
    if (slug && orgs.length === 0) throw new Error(`unknown organization "${slug}"`);
    let repositoriesChecked = 0;
    let subjects = 0;
    let signed = 0;
    for (const o of orgs) {
      const out = await reverifyOrganization(o.id);
      repositoriesChecked += out.repositories;
      subjects += out.subjects;
      signed += out.signed;
    }
    return { organizations: orgs.length, repositories: repositoriesChecked, images: subjects, signedArtifacts: signed };
  },
};

/** Jobs that make sense in this deployment (re-scanning needs a scanner backend). */
export async function listJobs(): Promise<JobDefinition[]> {
  const scanning = await scanningEnabled();
  return Object.values(JOBS).filter((j) => j.name !== "scan-stale" || scanning);
}

/** Execute a job and record the run. Resolves with the job_runs row id. */
export async function runJob(
  name: string,
  params: Record<string, string>,
  triggeredBy: string,
): Promise<{ id: string; status: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string }> {
  const job = JOBS[name];
  if (!job) throw new Error(`unknown job "${name}"`);
  const merged: Record<string, string> = {};
  for (const p of job.params) merged[p.name] = params[p.name] ?? p.default;

  const [run] = await db
    .insert(jobRuns)
    .values({ job: name, params: merged, triggeredBy, status: "running" })
    .returning({ id: jobRuns.id });

  try {
    const result = await job.run(merged);
    await db
      .update(jobRuns)
      .set({ status: "succeeded", result, finishedAt: new Date() })
      .where(eq(jobRuns.id, run.id));
    return { id: run.id, status: "succeeded", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(jobRuns)
      .set({ status: "failed", error: message, finishedAt: new Date() })
      .where(eq(jobRuns.id, run.id));
    await notify({ event: "job.failed", job: name, runId: run.id, error: message, triggeredBy }).catch((err) =>
      console.error("job.failed notification failed:", err),
    );
    return { id: run.id, status: "failed", error: message };
  }
}

export async function recentJobRuns(limit = 30, job?: string) {
  return db.query.jobRuns.findMany({
    where: job ? eq(jobRuns.job, job) : undefined,
    orderBy: (t, { desc }) => [desc(t.startedAt)],
    limit,
  });
}

/** One page of the run history, newest first, plus how many runs there are. */
export async function jobRunsPage(opts: { job?: string; page?: number; pageSize?: number } = {}) {
  const where = opts.job ? eq(jobRuns.job, opts.job) : undefined;
  return paginatedQuery<typeof jobRuns.$inferSelect>({
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? PAGE_SIZES.jobRuns,
    count: () => db.$count(jobRuns, where),
    rows: (limit, offset) =>
      db.query.jobRuns.findMany({
        where,
        orderBy: (t, { desc }) => [desc(t.startedAt)],
        limit,
        offset,
      }),
  });
}

/** The most recent run of every job that has ever run, keyed by job name. */
export async function latestRunsByJob(): Promise<Map<string, typeof jobRuns.$inferSelect>> {
  const rows = await db.selectDistinctOn([jobRuns.job]).from(jobRuns).orderBy(jobRuns.job, desc(jobRuns.startedAt));
  return new Map(rows.map((r) => [r.job, r]));
}

/** A job by name, or null for unknown names (the [job] route uses it). */
export function jobDefinition(name: string): JobDefinition | null {
  return Object.prototype.hasOwnProperty.call(JOBS, name) ? JOBS[name] : null;
}

// keep imports referenced for drizzle typing of tables used in raw SQL above
void [and, isNull, lt, manifests, organization, repositories, tags, vulnerabilityScans];
