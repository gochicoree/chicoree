// Authentication and request parsing for the scan worker protocol
// (/api/internal/worker/*): a static bearer token (SCAN_WORKER_TOKEN) and a
// worker identity in every request body.
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "./env";
import { workersActive, type WorkerIdentity } from "./scan-tasks";

export function workerTokenValid(authorization: string | null): boolean {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!token || !env.scanWorkerToken) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(env.scanWorkerToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function parseWorker(body: unknown): WorkerIdentity | null {
  const w = (body as { worker?: Record<string, unknown> } | null)?.worker;
  if (!w || typeof w.name !== "string" || !NAME.test(w.name)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : null);
  return { name: w.name, hostname: str(w.hostname), version: str(w.version), scannerVersion: str(w.scannerVersion) };
}

/**
 * Common gate: token, workers switched on, JSON body with a worker identity.
 * Returns the parsed body and worker, or the response to send instead.
 */
export async function workerRequest(req: NextRequest): Promise<{ ok: true; body: Record<string, unknown>; worker: WorkerIdentity } | { ok: false; response: NextResponse }> {
  if (!workerTokenValid(req.headers.get("authorization"))) {
    return { ok: false, response: NextResponse.json({ error: "invalid worker token" }, { status: 401 }) };
  }
  if (!(await workersActive())) {
    return { ok: false, response: NextResponse.json({ error: "scan workers are switched off on this instance (Administration → Scanning)" }, { status: 503 }) };
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, response: NextResponse.json({ error: "invalid JSON body" }, { status: 400 }) };
  }
  const worker = parseWorker(body);
  if (!worker) return { ok: false, response: NextResponse.json({ error: "body.worker.name is required (letters, digits, . _ -)" }, { status: 400 }) };
  return { ok: true, body, worker };
}
