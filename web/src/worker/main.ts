// Chicorée scan worker: a small process (bundled to worker.mjs, shipped in the
// web image) that claims scan tasks from a Chicorée instance over HTTPS, runs
// trivy against the registry with the pull token it was given and posts the
// result back. It needs no database and no registry credentials of its own.
//
//   CHICOREE_URL=https://registry.example.com SCAN_WORKER_TOKEN=… node worker.mjs
//
// Environment: WORKER_NAME (hostname), WORKER_CONCURRENCY (1), REGISTRY_URL
// (override the registry address the instance advertises), TRIVY_BIN,
// TRIVY_CACHE_DIR, TRIVY_SERVER_URL, TRIVY_TIMEOUT_SECONDS (600).
import { hostname } from "node:os";
import { createTrivyScanner } from "@/lib/scanners/trivy";
import type { ScanInput } from "@/lib/scanners/types";

const VERSION = process.env.CHICOREE_VERSION ?? "dev";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[worker] ${name} is required`);
    process.exit(2);
  }
  return v;
}

const baseUrl = need("CHICOREE_URL").replace(/\/$/, "");
const token = need("SCAN_WORKER_TOKEN");
const name = (process.env.WORKER_NAME?.trim() || hostname()).slice(0, 64);
const concurrency = Math.max(1, Math.min(16, Number(process.env.WORKER_CONCURRENCY ?? "1") || 1));
const registryOverride = process.env.REGISTRY_URL?.trim().replace(/\/$/, "") || null;

const trivy = createTrivyScanner({
  bin: process.env.TRIVY_BIN ?? "trivy",
  serverUrl: process.env.TRIVY_SERVER_URL?.trim().replace(/\/$/, "") ?? "",
  timeoutSeconds: Number(process.env.TRIVY_TIMEOUT_SECONDS ?? "600") || 600,
  cacheDir: process.env.TRIVY_CACHE_DIR ?? (process.platform === "linux" ? "/var/lib/chicoree/trivy" : ".trivy-cache"),
});

interface Task {
  id: string;
  digest: string;
  repositoryPath: string;
  manifest: ScanInput["manifest"];
  layers: ScanInput["layers"];
  registryUrl: string;
  token: string;
  leaseSeconds: number;
  attempt: number;
}

let scannerVersion: string | null = null;
let running = 0;
let stopping = false;
let backoffMs = 0;

const identity = () => ({ name, hostname: hostname(), version: VERSION, scannerVersion });

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": `chicoree-scan-worker/${VERSION}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
}

function log(msg: string, ...rest: unknown[]) {
  console.log(`[worker ${name}] ${msg}`, ...rest);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Slow down on connection problems and 5xx: 5 s, 10 s, … up to a minute. */
async function failedRequest(what: string, detail: string) {
  backoffMs = Math.min(60_000, backoffMs ? backoffMs * 2 : 5_000);
  log(`${what}: ${detail}; retrying in ${backoffMs / 1000} s`);
  await sleep(backoffMs);
}

async function claim(): Promise<Task | null> {
  let res: Response;
  try {
    res = await post("/api/internal/worker/claim", { worker: identity(), wait: 20, running });
  } catch (err) {
    await failedRequest("claim failed", err instanceof Error ? err.message : String(err));
    return null;
  }
  if (res.status === 204) {
    backoffMs = 0;
    return null;
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status === 401) {
      console.error(`[worker] the instance rejected SCAN_WORKER_TOKEN (${text}); exiting`);
      process.exit(2);
    }
    await failedRequest(`claim returned ${res.status}`, text || res.statusText);
    return null;
  }
  backoffMs = 0;
  const { task } = (await res.json()) as { task: Task };
  return task;
}

async function report(path: string, body: unknown, what: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await post(path, body);
      if (res.ok || res.status === 409) {
        if (res.status === 409) log(`${what}: lease was gone (409); the instance will re-run the scan`);
        return;
      }
      log(`${what} returned ${res.status}; retry ${attempt}/5`);
    } catch (err) {
      log(`${what} failed: ${err instanceof Error ? err.message : String(err)}; retry ${attempt}/5`);
    }
    await sleep(5_000 * attempt);
  }
}

async function scan(task: Task): Promise<void> {
  const registryUrl = registryOverride ?? task.registryUrl;
  const started = Date.now();
  log(`scanning ${task.repositoryPath}@${task.digest.slice(7, 19)} (attempt ${task.attempt}) via ${registryUrl}`);
  try {
    const out = await trivy.scan({ repositoryPath: task.repositoryPath, digest: task.digest, manifest: task.manifest, layers: task.layers, registryUrl, token: task.token });
    scannerVersion = out.scannerVersion ?? scannerVersion;
    await report(`/api/internal/worker/tasks/${task.id}/result`, { worker: identity(), result: { findings: out.findings, raw: out.raw, scannerVersion: out.scannerVersion } }, "result");
    const total = Object.values(out.summary).reduce((a, b) => a + b, 0);
    log(`done ${task.repositoryPath}@${task.digest.slice(7, 19)}: ${total} finding${total === 1 ? "" : "s"} in ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`failed ${task.repositoryPath}@${task.digest.slice(7, 19)}: ${message}`);
    await report(`/api/internal/worker/tasks/${task.id}/fail`, { worker: identity(), error: message }, "failure report");
  }
}

async function loop(slot: number): Promise<void> {
  while (!stopping) {
    const task = await claim();
    if (!task) continue;
    running++;
    try {
      await scan(task);
    } finally {
      running--;
    }
  }
  log(`slot ${slot} stopped`);
}

async function heartbeats(): Promise<void> {
  while (!stopping) {
    await post("/api/internal/worker/heartbeat", { worker: identity(), running }).catch(() => {});
    await sleep(30_000);
  }
}

async function main() {
  scannerVersion = await trivy.version();
  log(`starting: ${baseUrl}, concurrency ${concurrency}, trivy ${scannerVersion ?? "unknown"}${registryOverride ? `, registry ${registryOverride}` : ""}`);
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log(`stopping after ${running} running scan${running === 1 ? "" : "s"}`);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  void heartbeats();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i + 1)));
  process.exit(0);
}

void main();
