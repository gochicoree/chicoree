// Server-side HTTP client for talking to registryd over the internal network.
import { env } from "./env";
import { systemPullToken } from "./registry-jwt";

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
].join(", ");

export async function fetchManifestRaw(
  repositoryPath: string,
  reference: string,
): Promise<{ payload: string; mediaType: string; digest: string } | null> {
  const token = await systemPullToken(repositoryPath);
  const res = await fetch(`${env.registryInternalUrl}/v2/${repositoryPath}/manifests/${reference}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return {
    payload: await res.text(),
    mediaType: res.headers.get("content-type") ?? "application/octet-stream",
    digest: res.headers.get("docker-content-digest") ?? reference,
  };
}

/** Fetch a JSON blob (an image config) through the registry. */
export async function fetchBlobJson(repositoryPath: string, digest: string): Promise<unknown | null> {
  const token = await systemPullToken(repositoryPath);
  const res = await fetch(`${env.registryInternalUrl}/v2/${repositoryPath}/blobs/${digest}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The message from an OCI error body ({"errors":[{"code","message"}]}), or
 * a generic "HTTP <status>" when the response carries none.
 */
export async function registryErrorMessage(res: Response): Promise<string> {
  try {
    const parsed = (await res.json()) as { errors?: { message?: string }[] };
    const message = parsed.errors?.[0]?.message;
    if (message) return message;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}

/** Trigger a garbage-collection pass on registryd (admin action). */
export async function triggerGarbageCollection(grace?: string): Promise<
  { ok: true; result: Record<string, number> } | { ok: false; error: string }
> {
  try {
    const query = grace ? `?grace=${encodeURIComponent(grace)}` : "";
    const res = await fetch(`${env.registryInternalUrl}/internal/v1/gc${query}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.webhookSecret}` },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `registry answered ${res.status}` };
    return { ok: true, result: (await res.json()) as Record<string, number> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "registry unreachable" };
  }
}

/** What GET /internal/v1/status on registryd reports (bearer = webhook secret). */
export interface RegistryStatus {
  status: string;
  version: string;
  goVersion: string;
  storage: string;
  /** "local" (files under stagingDir) or "shared" (sessions in Postgres, chunks in the backend). */
  staging?: string;
  stagingDir: string;
  /** -1 when unknown (always in shared mode, where no staging disk exists). */
  stagingFreeBytes: number;
  /** In-flight shared upload sessions; -1 in local mode. */
  uploadSessions?: number;
  blobCount: number;
  blobBytes: number;
  startedAt: string;
  uptimeSeconds: number;
  /** Fingerprint of the file key (kept for older registries); see trustedKeys for the full set. */
  publicKeyFingerprint: string;
  /** Every key the registry verifies tokens with right now (file key + database keys). */
  publicKeyFingerprints?: string[];
  trustedKeys?: { kid: string; fingerprint: string; source: "file" | "database"; retiredAt: string | null }[];
  authDisabled: boolean;
  databaseError?: string;
}

/** Build, storage and key facts from registryd for the health page; null when unreachable. */
export async function registryStatus(timeoutMs = 3000): Promise<{ status: RegistryStatus; latencyMs: number } | { error: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`${env.registryInternalUrl}/internal/v1/status`, {
      headers: { Authorization: `Bearer ${env.webhookSecret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { error: `registry answered ${res.status} to /internal/v1/status` };
    return { status: (await res.json()) as RegistryStatus, latencyMs: Date.now() - started };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "registry unreachable" };
  }
}

/** Health probe used on the admin screen. */
export async function registryHealth(): Promise<{ ok: boolean; storage?: string }> {
  try {
    const res = await fetch(`${env.registryInternalUrl}/internal/v1/healthz`, { cache: "no-store" });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { storage?: string };
    return { ok: true, storage: body.storage };
  } catch {
    return { ok: false };
  }
}
