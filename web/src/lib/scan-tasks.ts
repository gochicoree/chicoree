// Scans handed to external workers. Administration → Scanning → "Offload
// scans to workers" turns a push's scan into a scan_tasks row; workers claim
// rows over /api/internal/worker/* with SCAN_WORKER_TOKEN, run trivy against
// the registry with a short-lived pull token and post the result back. When
// no worker has reported in for two minutes, the scheduler tick runs queued
// tasks in the web container — switching the option on never stalls scans.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { scanTasks, scanWorkers } from "@/db/schema";
import { env } from "./env";
import { getInstanceSettings } from "./instance-settings";
import { systemPullToken } from "./registry-jwt";
import { finishScan, runScan, scanTarget, setScanState } from "./scan";
import { summarizeFindings, type Finding } from "./scanner-shared";
import { getScanner } from "./scanners";
import { normalizeTrivyReport, type TrivyReport } from "./scanners/trivy";

/** A worker that has not reported in for this long no longer counts as online. */
export const WORKER_ONLINE_SECONDS = 120;
/** A claimed task is handed out again when the worker does not report back within this time. */
const LEASE_MINUTES = 20;
const MAX_ATTEMPTS = 3;
/** Tasks an offline tick runs inline at most, so one tick stays short. */
const INLINE_PER_TICK = 3;
const KEEP_DONE = "7 days";

export interface WorkerIdentity {
  name: string;
  hostname?: string | null;
  version?: string | null;
  scannerVersion?: string | null;
}

export interface ScanTaskPayload {
  id: string;
  digest: string;
  repositoryPath: string;
  manifest: { mediaType?: string; config?: { digest: string }; layers?: { digest: string }[] };
  layers: { digest: string; size?: number; mediaType?: string }[];
  /** The registry as the worker reaches it (REGISTRY_URL, else https:// + REGISTRY_HOST). */
  registryUrl: string;
  /** Pull token for that repository, valid for two hours. */
  token: string;
  /** Seconds until the lease expires. */
  leaseSeconds: number;
  attempt: number;
}

export interface WorkerScanResult {
  /** Already normalised findings; omitted by thin workers, which send Trivy's report as `raw` and let the instance normalise it. */
  findings?: Finding[];
  raw: unknown;
  scannerVersion: string | null;
}

/** True when scans should be queued for workers rather than run here. */
export async function workersActive(): Promise<boolean> {
  const { scanner } = await getInstanceSettings();
  return scanner.backend === "trivy" && scanner.workers && !!env.scanWorkerToken;
}

/** Start a scan the way the instance is configured: queue it for workers, or run it here. */
export async function startScan(repositoryPath: string, digest: string): Promise<void> {
  if (!(await workersActive())) return runScan(repositoryPath, digest);
  const target = await scanTarget(repositoryPath, digest);
  if (!target) {
    // Indexes and artifacts are never scanned; clear a failure an older build may have left.
    return runScan(repositoryPath, digest);
  }
  await enqueueScan(repositoryPath, digest, target.repositoryId);
}

export async function enqueueScan(repositoryPath: string, digest: string, repositoryId: string): Promise<void> {
  await setScanState(digest, repositoryId, { status: "pending", error: null, scanner: "trivy" });
  await db
    .insert(scanTasks)
    .values({ id: randomUUID(), digest, repositoryId, repositoryPath, status: "queued", attempts: 0, availableAt: new Date(), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: scanTasks.digest,
      set: { repositoryId, repositoryPath, status: "queued", attempts: 0, availableAt: new Date(), leasedBy: null, leaseUntil: null, lastError: null, updatedAt: new Date() },
    });
}

/** Record that a worker is alive (and what it runs). */
export async function heartbeat(worker: WorkerIdentity, running = 0): Promise<void> {
  await db
    .insert(scanWorkers)
    .values({ name: worker.name, hostname: worker.hostname ?? null, version: worker.version ?? null, scannerVersion: worker.scannerVersion ?? null, running, lastSeenAt: new Date(), startedAt: new Date() })
    .onConflictDoUpdate({
      target: scanWorkers.name,
      set: { hostname: worker.hostname ?? null, version: worker.version ?? null, scannerVersion: worker.scannerVersion ?? null, running, lastSeenAt: new Date() },
    });
}

/**
 * Hand the oldest due task to a worker. Atomic: concurrent workers never get
 * the same row. Null when nothing is due.
 */
export async function claimScanTask(worker: WorkerIdentity): Promise<ScanTaskPayload | null> {
  const { rows } = await db.execute(sql`
    UPDATE scan_tasks SET status = 'leased', leased_by = ${worker.name}, lease_until = now() + make_interval(mins => ${LEASE_MINUTES}),
      attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM scan_tasks
      WHERE available_at <= now() AND (status = 'queued' OR (status = 'leased' AND lease_until < now()))
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
    RETURNING id, digest, repository_id, repository_path, attempts`);
  const row = rows[0] as { id: string; digest: string; repository_id: string | null; repository_path: string; attempts: number } | undefined;
  if (!row) return null;
  const target = await scanTarget(row.repository_path, row.digest);
  if (!target) {
    // The image went away (or turned out to be an artifact): nothing to scan.
    await db.update(scanTasks).set({ status: "done", updatedAt: new Date(), lastError: "nothing to scan" }).where(eq(scanTasks.id, row.id));
    return claimScanTask(worker);
  }
  await setScanState(row.digest, target.repositoryId, { status: "indexing", error: null, scanner: "trivy" });
  const token = await systemPullToken(row.repository_path, 2 * 3600);
  return {
    id: row.id,
    digest: row.digest,
    repositoryPath: row.repository_path,
    manifest: target.payload as ScanTaskPayload["manifest"],
    layers: target.layers,
    registryUrl: env.registryPublicUrl,
    token,
    leaseSeconds: LEASE_MINUTES * 60,
    attempt: Number(row.attempts),
  };
}

async function leasedTask(id: string, worker: WorkerIdentity) {
  const task = await db.query.scanTasks.findFirst({ where: and(eq(scanTasks.id, id), eq(scanTasks.status, "leased"), eq(scanTasks.leasedBy, worker.name)) });
  return task ?? null;
}

/** A worker delivers a result. False when the task is not (or no longer) leased to it. */
export async function completeScanTask(id: string, worker: WorkerIdentity, result: WorkerScanResult): Promise<boolean> {
  const task = await leasedTask(id, worker);
  if (!task) return false;
  const scanner = await getScanner();
  const findings = result.findings ?? normalizeTrivyReport((result.raw ?? {}) as TrivyReport);
  await finishScan(task.repositoryId ?? "", task.digest, { findings, raw: result.raw, scannerVersion: result.scannerVersion, summary: summarizeFindings(findings) }, { name: "trivy", label: scanner?.label ?? "Trivy" });
  await db.update(scanTasks).set({ status: "done", lastError: null, updatedAt: new Date() }).where(eq(scanTasks.id, id));
  await db.update(scanWorkers).set({ completed: sql`${scanWorkers.completed} + 1`, lastSeenAt: new Date() }).where(eq(scanWorkers.name, worker.name));
  return true;
}

/** A worker gives up on a task: retried later, failed for good after MAX_ATTEMPTS. */
export async function failScanTask(id: string, worker: WorkerIdentity, error: string): Promise<boolean> {
  const task = await leasedTask(id, worker);
  if (!task) return false;
  const message = error.slice(0, 1000);
  const exhausted = task.attempts >= MAX_ATTEMPTS;
  if (exhausted) {
    await setScanState(task.digest, task.repositoryId, { status: "failed", error: message });
    await db.update(scanTasks).set({ status: "failed", lastError: message, updatedAt: new Date() }).where(eq(scanTasks.id, id));
  } else {
    await db
      .update(scanTasks)
      .set({ status: "queued", leasedBy: null, leaseUntil: null, lastError: message, availableAt: new Date(Date.now() + 60_000 * task.attempts), updatedAt: new Date() })
      .where(eq(scanTasks.id, id));
  }
  await db.update(scanWorkers).set({ failed: sql`${scanWorkers.failed} + 1`, lastError: message, lastSeenAt: new Date() }).where(eq(scanWorkers.name, worker.name));
  return true;
}

export async function onlineWorkerCount(): Promise<number> {
  const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM scan_workers WHERE last_seen_at > now() - make_interval(secs => ${WORKER_ONLINE_SECONDS})`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Scheduler tick: release expired leases, run queued work here while no
 * worker is online (or the option was switched off with tasks left), sweep
 * old rows.
 */
export async function dispatchScanTasks(): Promise<{ released: number; inline: number }> {
  const released = await db.execute(sql`
    UPDATE scan_tasks SET status = 'queued', leased_by = NULL, lease_until = NULL, updated_at = now(),
      last_error = coalesce(last_error, 'lease expired')
    WHERE status = 'leased' AND lease_until < now()
    RETURNING id`);
  let inline = 0;
  const active = await workersActive();
  const online = active ? await onlineWorkerCount() : 0;
  if (!active || online === 0) {
    const { rows } = await db.execute(sql`
      SELECT id, digest, repository_path FROM scan_tasks
      WHERE status = 'queued' AND available_at <= now()
      ORDER BY created_at LIMIT ${INLINE_PER_TICK}`);
    if (rows.length > 0 && active) console.log(`[scan-tasks] no scan worker online for ${WORKER_ONLINE_SECONDS} s; running ${rows.length} queued scan${rows.length === 1 ? "" : "s"} here`);
    for (const r of rows as unknown as { id: string; digest: string; repository_path: string }[]) {
      await db.update(scanTasks).set({ status: "leased", leasedBy: "web (inline)", leaseUntil: new Date(Date.now() + LEASE_MINUTES * 60_000), attempts: sql`${scanTasks.attempts} + 1`, updatedAt: new Date() }).where(eq(scanTasks.id, r.id));
      await runScan(r.repository_path, r.digest).catch((err) => console.error("inline scan failed:", err));
      await db.update(scanTasks).set({ status: "done", updatedAt: new Date() }).where(eq(scanTasks.id, r.id));
      inline++;
    }
  }
  await db
    .execute(sql`DELETE FROM scan_tasks WHERE status IN ('done', 'failed') AND updated_at < now() - interval '${sql.raw(KEEP_DONE)}'`)
    .catch((err) => console.error("scan task sweep failed:", err));
  await db.execute(sql`DELETE FROM scan_workers WHERE last_seen_at < now() - interval '30 days'`).catch(() => {});
  return { released: released.rows.length, inline };
}

export interface ScanWorkerStats {
  queued: number;
  leased: number;
  failed: number;
  workers: { name: string; hostname: string | null; version: string | null; scannerVersion: string | null; lastSeenAt: Date; online: boolean; running: number; completed: number; failed: number; lastError: string | null }[];
}

/** For Administration → Scanning. */
export async function scanWorkerStats(): Promise<ScanWorkerStats> {
  const [{ rows: counts }, workers] = await Promise.all([
    db.execute(sql`
      SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
             count(*) FILTER (WHERE status = 'leased')::int AS leased,
             count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM scan_tasks`),
    db.select().from(scanWorkers).orderBy(sql`last_seen_at DESC`),
  ]);
  const c = counts[0] as { queued: number; leased: number; failed: number } | undefined;
  const cutoff = Date.now() - WORKER_ONLINE_SECONDS * 1000;
  return {
    queued: Number(c?.queued ?? 0),
    leased: Number(c?.leased ?? 0),
    failed: Number(c?.failed ?? 0),
    workers: workers.map((w) => ({
      name: w.name,
      hostname: w.hostname,
      version: w.version,
      scannerVersion: w.scannerVersion,
      lastSeenAt: w.lastSeenAt,
      online: w.lastSeenAt.getTime() > cutoff,
      running: w.running,
      completed: w.completed,
      failed: w.failed,
      lastError: w.lastError,
    })),
  };
}
