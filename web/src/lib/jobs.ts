// Background jobs: maintenance tasks an admin can run from the Jobs page or
// trigger from automation through POST /api/jobs/<name>. Every run is
// recorded in job_runs.
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns, manifests, organization, repositories, tags, vulnerabilityScans } from "@/db/schema";
import { triggerGarbageCollection } from "./registry-client";
import { runScan } from "./scan";
import { env } from "./env";
import { runAllMirrors } from "./mirror";

export interface JobDefinition {
  name: string;
  title: string;
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
    title: "Re-scan stale images",
    description:
      "Re-submits tagged images to Clair whose last scan is older than the given age (or that were never scanned).",
    params: [
      { name: "olderThan", description: "Age threshold, e.g. 7d, 12h", default: "7d" },
      { name: "limit", description: "Maximum images to scan in one run", default: "50" },
    ],
    run: async (params) => {
      if (!env.clairEnabled) throw new Error("Clair is not configured (CLAIR_URL)");
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
  title: "Sync mirrors",
  description: "Runs every enabled repository mirror: fetches matching tags from the source registry and imports anything new or changed.",
  params: [],
  run: async () => runAllMirrors(),
};

export function listJobs(): JobDefinition[] {
  return Object.values(JOBS);
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
    return { id: run.id, status: "failed", error: message };
  }
}

export async function recentJobRuns(limit = 30) {
  return db.query.jobRuns.findMany({
    orderBy: (t, { desc }) => [desc(t.startedAt)],
    limit,
  });
}

// keep imports referenced for drizzle typing of tables used in raw SQL above
void [and, isNull, lt, manifests, organization, repositories, tags, vulnerabilityScans];
