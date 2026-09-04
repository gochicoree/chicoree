// Instance health: one check per subsystem for /admin/health, and the cheap
// probe behind GET /api/health. Every check is bounded by a timeout and turns
// failures into a red card instead of an exception.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { env } from "./env";
import { formatBytes, relativeTime } from "./format";
import { registryStatus, type RegistryStatus } from "./registry-client";
import { getScanner, scanningEnabled } from "./scanners";

export type HealthStatus = "ok" | "warn" | "error" | "none";

export interface HealthCheck {
  key: string;
  title: string;
  status: HealthStatus;
  /** One line under the title. */
  summary: string;
  details: { label: string; value: string }[];
  latencyMs?: number;
}

const TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Wrap a check so it can never throw: failures become a red card. */
async function guarded(key: string, title: string, fn: () => Promise<HealthCheck>): Promise<HealthCheck> {
  try {
    return await withTimeout(fn(), TIMEOUT_MS + 500);
  } catch (e) {
    return { key, title, status: "error", summary: message(e), details: [] };
  }
}

function duration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// --- registryd ---------------------------------------------------------------

export interface RegistryProbe {
  ok: boolean;
  latencyMs: number;
  storage?: string;
  error?: string;
}

export async function probeRegistry(timeoutMs = TIMEOUT_MS): Promise<RegistryProbe> {
  const started = Date.now();
  try {
    const res = await fetch(`${env.registryInternalUrl}/internal/v1/healthz`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) return { ok: false, latencyMs, error: `healthz answered ${res.status}` };
    const body = (await res.json()) as { storage?: string };
    return { ok: true, latencyMs, storage: body.storage };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: message(e) };
  }
}

async function checkRegistry(probe: RegistryProbe, status: RegistryStatus | null, statusError?: string): Promise<HealthCheck> {
  const details: { label: string; value: string }[] = [
    { label: "Internal URL", value: env.registryInternalUrl },
    { label: "Latency", value: `${probe.latencyMs} ms` },
  ];
  if (!probe.ok) {
    return { key: "registry", title: "Registry (registryd)", status: "error", summary: probe.error ?? "unreachable", details, latencyMs: probe.latencyMs };
  }
  if (!status) {
    details.push({ label: "Status endpoint", value: statusError ?? "unavailable" });
    return {
      key: "registry",
      title: "Registry (registryd)",
      status: "warn",
      summary: `Answering, but /internal/v1/status failed — is WEBHOOK_SECRET the same on both services?`,
      details,
      latencyMs: probe.latencyMs,
    };
  }
  details.push(
    { label: "Version", value: `${status.version} (${status.goVersion})` },
    { label: "Storage driver", value: status.storage },
    { label: "Uptime", value: `${duration(status.uptimeSeconds)} (since ${status.startedAt})` },
    { label: "Blobs", value: status.blobCount < 0 ? "unknown" : `${status.blobCount.toLocaleString("en-US")} · ${formatBytes(status.blobBytes)} physical` },
    {
      label: "Upload staging",
      value:
        status.staging === "shared"
          ? `shared (sessions in Postgres, chunks in ${status.storage} storage)${status.uploadSessions != null && status.uploadSessions >= 0 ? ` · ${status.uploadSessions} in flight` : ""}`
          : `local (${status.stagingDir})`,
    },
  );
  let state: HealthStatus = "ok";
  let summary = `Up, ${status.storage} storage, version ${status.version}`;
  if (status.authDisabled) {
    state = "warn";
    summary = "AUTH_DISABLED is set: every request is treated as an administrator";
  }
  if (status.databaseError) {
    state = "error";
    summary = `Registry cannot read the database: ${status.databaseError}`;
  }
  return { key: "registry", title: "Registry (registryd)", status: state, summary, details, latencyMs: probe.latencyMs };
}

// --- Postgres ----------------------------------------------------------------

export async function probeDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await withTimeout(db.execute(sql`SELECT 1`));
    return { ok: true, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: message(e) };
  }
}

async function checkDatabase(): Promise<HealthCheck> {
  const started = Date.now();
  const { rows } = await db.execute(sql`
    SELECT pg_database_size(current_database())::bigint AS size,
           (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS active,
           current_setting('max_connections')::int AS max_conn,
           version() AS version,
           to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS tracked`);
  const latencyMs = Date.now() - started;
  const r = rows[0];
  const active = Number(r.active);
  const max = Number(r.max_conn);
  // A missing relation fails at plan time even inside an untaken CASE branch,
  // so the migrations table is only queried once we know it exists.
  let migrations: number | null = null;
  if (r.tracked === true) {
    const m = await db.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`);
    migrations = Number(m.rows[0]?.n ?? 0);
  }
  const ratio = max > 0 ? active / max : 0;
  const version = String(r.version).split(" on ")[0];
  return {
    key: "database",
    title: "Postgres",
    status: ratio > 0.9 ? "error" : ratio > 0.75 ? "warn" : "ok",
    summary: ratio > 0.75 ? `${active} of ${max} connections in use` : `Reachable in ${latencyMs} ms, ${formatBytes(Number(r.size))}`,
    details: [
      { label: "Server", value: version },
      { label: "Database size", value: formatBytes(Number(r.size)) },
      { label: "Connections", value: `${active} active of ${max} max` },
      { label: "Migrations applied", value: migrations === null ? "not tracked (schema pushed directly)" : String(migrations) },
    ],
    latencyMs,
  };
}

// --- Scanner backend ---------------------------------------------------------

/** Clair or Trivy, whichever Administration → Scanning selects; each backend probes itself. */
async function checkScanner(): Promise<HealthCheck> {
  const key = "scanner";
  const scanner = await getScanner();
  if (!scanner) {
    return {
      key,
      title: "Vulnerability scanner",
      status: "none",
      summary: "Scanning is off (Administration → Scanning, or SCANNER / CLAIR_URL in the environment).",
      details: [],
    };
  }
  const title = `Vulnerability scanner (${scanner.label})`;
  const h = await scanner.health();
  return { key, title, status: h.status, summary: h.summary, details: h.details, latencyMs: h.latencyMs };
}

// --- token keys --------------------------------------------------------------

/** SHA-256 over the SPKI DER of the public key derived from the private key file. */
export function privateKeyFingerprint(pem: string): string {
  const pub = createPublicKey(createPrivateKey(pem));
  return createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex");
}

async function checkTokenKeys(status: RegistryStatus | null): Promise<HealthCheck> {
  const key = "keys";
  const title = "Token signing keys";
  const file = path.resolve(process.cwd(), env.tokenPrivateKeyFile);
  const details: { label: string; value: string }[] = [{ label: "Private key", value: file }];
  let fingerprint: string;
  try {
    fingerprint = privateKeyFingerprint(readFileSync(file, "utf8"));
  } catch (e) {
    return { key, title, status: "error", summary: `Private key unreadable: ${message(e)}`, details };
  }
  details.push({ label: "Public key SHA-256", value: fingerprint });
  if (!status) {
    return { key, title, status: "warn", summary: "Private key readable; registry fingerprint unavailable for comparison", details };
  }
  if (status.authDisabled || !status.publicKeyFingerprint) {
    details.push({ label: "Registry", value: status.authDisabled ? "auth disabled" : "no key advertised" });
    return { key, title, status: "warn", summary: "Private key readable; the registry does not verify tokens (AUTH_DISABLED)", details };
  }
  details.push({ label: "Registry SHA-256", value: status.publicKeyFingerprint });
  const match = status.publicKeyFingerprint === fingerprint;
  return {
    key,
    title,
    status: match ? "ok" : "error",
    summary: match ? "The registry trusts the key this app signs with" : "Key mismatch: the registry will reject every token this app signs",
    details,
  };
}

// --- database-backed checks --------------------------------------------------

async function checkScans(): Promise<HealthCheck> {
  const key = "scans";
  const title = "Vulnerability scans";
  if (!(await scanningEnabled())) return { key, title, status: "none", summary: "Scanning is off (no scanner backend configured).", details: [] };
  const { rows } = await db.execute(sql`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'indexing')::int AS indexing,
           count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*) FILTER (WHERE status = 'scanned')::int AS scanned,
           min(created_at) FILTER (WHERE status IN ('pending', 'indexing')) AS oldest_pending
    FROM vulnerability_scans`);
  const r = rows[0];
  const pending = Number(r.pending) + Number(r.indexing);
  const failed = Number(r.failed);
  const oldest = r.oldest_pending ? new Date(r.oldest_pending as string) : null;
  const oldestAge = oldest ? Date.now() - oldest.getTime() : 0;
  const status: HealthStatus = oldestAge > 3600_000 ? "warn" : failed > 0 ? "warn" : "ok";
  return {
    key,
    title,
    status,
    summary:
      oldestAge > 3600_000
        ? `${pending} scan(s) waiting; the oldest since ${relativeTime(oldest)}`
        : failed > 0
          ? `${failed} failed scan(s); ${Number(r.scanned)} scanned`
          : `${Number(r.scanned)} scanned, ${pending} in progress`,
    details: [
      { label: "Pending / indexing", value: `${Number(r.pending)} / ${Number(r.indexing)}` },
      { label: "Failed", value: String(failed) },
      { label: "Scanned", value: String(Number(r.scanned)) },
      { label: "Oldest pending", value: oldest ? `${oldest.toISOString()} (${relativeTime(oldest)})` : "—" },
    ],
  };
}

async function checkWebhooks(): Promise<HealthCheck> {
  const { rows } = await db.execute(sql`
    SELECT (SELECT count(*) FROM webhook_deliveries WHERE created_at > now() - interval '24 hours' AND NOT ok)::int AS failed_24h,
           (SELECT count(*) FROM webhook_deliveries WHERE created_at > now() - interval '24 hours' AND ok)::int AS ok_24h,
           (SELECT count(*) FROM repository_webhooks WHERE enabled)::int AS enabled,
           (SELECT count(*) FROM repository_webhooks WHERE enabled AND last_error IS NOT NULL AND (last_status IS NULL OR last_status < 200 OR last_status >= 300))::int AS in_error`);
  const r = rows[0];
  const failed = Number(r.failed_24h);
  const inError = Number(r.in_error);
  return {
    key: "webhooks",
    title: "Webhooks",
    status: inError > 0 || failed > 0 ? "warn" : "ok",
    summary:
      inError > 0
        ? `${inError} hook(s) failing; ${failed} failed deliveries in 24 h`
        : failed > 0
          ? `${failed} failed deliveries in the last 24 h`
          : `${Number(r.enabled)} enabled, ${Number(r.ok_24h)} deliveries in 24 h`,
    details: [
      { label: "Enabled hooks", value: String(Number(r.enabled)) },
      { label: "Hooks in error", value: String(inError) },
      { label: "Deliveries, 24 h", value: `${Number(r.ok_24h)} ok · ${failed} failed` },
    ],
  };
}

async function checkJobs(): Promise<HealthCheck> {
  const { rows } = await db.execute(sql`
    SELECT DISTINCT ON (job) job, status, started_at, finished_at, error
    FROM job_runs ORDER BY job, started_at DESC`);
  const failed7d = await db.execute(sql`SELECT count(*)::int AS n FROM job_runs WHERE started_at > now() - interval '7 days' AND status = 'failed'`);
  const failures = Number(failed7d.rows[0]?.n ?? 0);
  const lastFailed = rows.filter((r) => r.status === "failed");
  return {
    key: "jobs",
    title: "Jobs",
    status: lastFailed.length > 0 ? "warn" : "ok",
    summary:
      rows.length === 0
        ? "No job has run yet"
        : lastFailed.length > 0
          ? `Last run failed for ${lastFailed.map((r) => r.job).join(", ")}`
          : `${rows.length} job(s) ran; ${failures} failure(s) in 7 days`,
    details: [
      ...rows.map((r) => ({
        label: String(r.job),
        value: `${r.status} · ${relativeTime(new Date(r.started_at as string))}${r.error ? ` · ${String(r.error).slice(0, 80)}` : ""}`,
      })),
      { label: "Failures, 7 days", value: String(failures) },
    ],
  };
}

async function checkMirrors(): Promise<HealthCheck> {
  const { rows } = await db.execute(sql`
    SELECT m.id, m.source, m.last_status, m.last_error, m.last_run_at, o.slug || '/' || r.name AS path
    FROM mirrors m JOIN repositories r ON r.id = m.repository_id JOIN organization o ON o.id = r.organization_id
    WHERE m.enabled AND m.last_status = 'failed' ORDER BY m.last_run_at DESC NULLS LAST LIMIT 10`);
  const total = await db.execute(sql`SELECT count(*) FILTER (WHERE enabled)::int AS enabled, count(*)::int AS total FROM mirrors`);
  const t = total.rows[0];
  return {
    key: "mirrors",
    title: "Mirrors",
    status: rows.length > 0 ? "warn" : "ok",
    summary: rows.length > 0 ? `${rows.length} mirror(s) failed their last sync` : `${Number(t.enabled)} enabled of ${Number(t.total)}`,
    details: rows.map((r) => ({
      label: String(r.path),
      value: `${String(r.source)} · ${r.last_run_at ? relativeTime(new Date(r.last_run_at as string)) : "never"}${r.last_error ? ` · ${String(r.last_error).slice(0, 80)}` : ""}`,
    })),
  };
}

function checkDisk(status: RegistryStatus | null): HealthCheck {
  const key = "disk";
  const title = "Upload staging disk";
  if (status?.staging === "shared") {
    return {
      key,
      title,
      status: "none",
      summary: "Not used: uploads are staged in the storage backend (STORAGE_STAGING=shared)",
      details: [],
    };
  }
  if (!status || status.stagingFreeBytes < 0) {
    return { key, title, status: "none", summary: "Unknown (registry status unavailable)", details: [] };
  }
  const free = status.stagingFreeBytes;
  const GiB = 1024 ** 3;
  return {
    key,
    title,
    status: free < 0.5 * GiB ? "error" : free < 5 * GiB ? "warn" : "ok",
    summary: `${formatBytes(free)} free for in-flight uploads`,
    details: [
      { label: "Staging dir", value: status.stagingDir },
      { label: "Free", value: formatBytes(free) },
    ],
  };
}

async function checkGC(): Promise<HealthCheck> {
  const { rows } = await db.execute(sql`SELECT status, started_at, result, error FROM job_runs WHERE job = 'gc' ORDER BY started_at DESC LIMIT 1`);
  const r = rows[0];
  if (!r) {
    return { key: "gc", title: "Garbage collection", status: "warn", summary: "Never run — unreferenced blobs are not reclaimed until it runs", details: [] };
  }
  const at = new Date(r.started_at as string);
  const age = Date.now() - at.getTime();
  const failed = r.status === "failed";
  return {
    key: "gc",
    title: "Garbage collection",
    status: failed ? "warn" : age > 14 * 86_400_000 ? "warn" : "ok",
    summary: failed ? `Last run failed ${relativeTime(at)}: ${String(r.error ?? "")}` : `Last run ${relativeTime(at)}`,
    details: [
      { label: "Last run", value: `${at.toISOString()} · ${String(r.status)}` },
      { label: "Result", value: r.result ? JSON.stringify(r.result) : r.error ? String(r.error) : "—" },
    ],
  };
}

// --- entry points --------------------------------------------------------------

export async function runHealthChecks(): Promise<HealthCheck[]> {
  const [probe, statusResult] = await Promise.all([probeRegistry(), registryStatus()]);
  const status = "status" in statusResult ? statusResult.status : null;
  const statusError = "error" in statusResult ? statusResult.error : undefined;
  const checks = await Promise.all([
    guarded("registry", "Registry (registryd)", () => checkRegistry(probe, status, statusError)),
    guarded("database", "Postgres", checkDatabase),
    guarded("scanner", "Vulnerability scanner", checkScanner),
    guarded("keys", "Token signing keys", () => checkTokenKeys(status)),
    guarded("scans", "Vulnerability scans", checkScans),
    guarded("webhooks", "Webhooks", checkWebhooks),
    guarded("jobs", "Jobs", checkJobs),
    guarded("mirrors", "Mirrors", checkMirrors),
    guarded("disk", "Upload staging disk", async () => checkDisk(status)),
    guarded("gc", "Garbage collection", checkGC),
  ]);
  return checks;
}

/** Cheap probe for uptime monitors: database + registry. */
export async function quickHealth(): Promise<{
  status: "ok" | "degraded";
  database: { ok: boolean; latencyMs: number; error?: string };
  registry: { ok: boolean; latencyMs: number; error?: string };
}> {
  const [database, registry] = await Promise.all([probeDatabase(), probeRegistry()]);
  return {
    status: database.ok && registry.ok ? "ok" : "degraded",
    database,
    registry: { ok: registry.ok, latencyMs: registry.latencyMs, error: registry.error },
  };
}
