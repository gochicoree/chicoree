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
