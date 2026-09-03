// Proxy-cache organizations: server-side queries, the configuration feed for
// registryd (credentials decrypted here — the registry never holds the key),
// and the "test upstream" probe.
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organization, organizationProxies } from "@/db/schema";
import { decryptSecret } from "./crypto";
import { env } from "./env";
import { RemoteRegistry } from "./remote-registry";
import { isDockerHubUrl } from "./proxy-shared";

export type OrgProxy = typeof organizationProxies.$inferSelect;

export async function getOrgProxy(organizationId: string): Promise<OrgProxy | null> {
  const row = await db.query.organizationProxies.findFirst({
    where: eq(organizationProxies.organizationId, organizationId),
  });
  return row ?? null;
}

export async function getOrgProxyBySlug(slug: string): Promise<OrgProxy | null> {
  const org = await db.query.organization.findFirst({ where: eq(organization.slug, slug) });
  if (!org) return null;
  return getOrgProxy(org.id);
}

/** Split stored "user:password" (or a bare token) into credentials. */
export function splitProxyAuth(encrypted: string | null): { username: string; password: string } | null {
  const plain = decryptSecret(encrypted);
  if (!plain) return null;
  const sep = plain.indexOf(":");
  if (sep < 0) return { username: "", password: plain };
  return { username: plain.slice(0, sep), password: plain.slice(sep + 1) };
}

export interface ProxyConfigForRegistry {
  organizationId: string;
  slug: string;
  upstreamUrl: string;
  preset: string;
  username: string;
  password: string;
  allowedPatterns: string;
  tagTtlSeconds: number;
  enabled: boolean;
}

/** Every proxy (enabled or not — disabled ones still route nested names) with decrypted credentials. */
export async function listProxyConfigs(): Promise<ProxyConfigForRegistry[]> {
  const rows = await db
    .select({
      organizationId: organizationProxies.organizationId,
      slug: organization.slug,
      upstreamUrl: organizationProxies.upstreamUrl,
      preset: organizationProxies.preset,
      auth: organizationProxies.auth,
      allowedPatterns: organizationProxies.allowedPatterns,
      tagTtlSeconds: organizationProxies.tagTtlSeconds,
      enabled: organizationProxies.enabled,
    })
    .from(organizationProxies)
    .innerJoin(organization, eq(organization.id, organizationProxies.organizationId));
  return rows.map((r) => {
    const creds = splitProxyAuth(r.auth);
    return {
      organizationId: r.organizationId,
      slug: r.slug,
      upstreamUrl: r.upstreamUrl,
      preset: r.preset,
      username: creds?.username ?? "",
      password: creds?.password ?? "",
      allowedPatterns: r.allowedPatterns,
      tagTtlSeconds: r.tagTtlSeconds,
      enabled: r.enabled,
    };
  });
}

/** Ask registryd to drop its configuration cache (fire-and-forget on save). */
export async function reloadRegistryProxies(): Promise<void> {
  try {
    await fetch(`${env.registryInternalUrl}/internal/v1/proxies/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.webhookSecret}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn("registry proxy reload failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Probe an upstream with the given settings: on Docker Hub HEAD
 * library/alpine:latest (exercises the token flow and the rate limit
 * headers), elsewhere ping /v2/. Returns a human-readable summary.
 */
export async function testUpstream(
  upstreamUrl: string,
  auth: { username: string; password: string } | null,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const base = upstreamUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return { ok: false, message: "The upstream URL must start with http:// or https://." };
  const dockerHub = isDockerHubUrl(base);
  const repository = dockerHub ? "library/alpine" : "";
  const remote = new RemoteRegistry({ baseUrl: base, repository, host: base }, auth);
  const started = Date.now();
  try {
    if (dockerHub) {
      const res = await remote.request(`/v2/library/alpine/manifests/latest`, {
        method: "HEAD",
        headers: {
          Accept:
            "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
      });
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok) return { ok: false, message: `Docker Hub answered HTTP ${res.status} for library/alpine:latest.` };
      const digest = res.headers.get("docker-content-digest") ?? "unknown digest";
      const limit = res.headers.get("ratelimit-limit");
      const remaining = res.headers.get("ratelimit-remaining");
      const quota = limit ? ` Pull limit ${limit.split(";")[0]}, remaining ${remaining?.split(";")[0] ?? "?"}${auth ? " (authenticated)" : " (anonymous)"}.` : "";
      return { ok: true, message: `Reached Docker Hub in ${Date.now() - started} ms; library/alpine:latest is ${digest.slice(0, 19)}….${quota}` };
    }
    const res = await remote.request(`/v2/`, { method: "GET" }, "");
    await res.arrayBuffer().catch(() => undefined);
    if (res.ok) return { ok: true, message: `Reached ${base} in ${Date.now() - started} ms; the registry API answered ${res.status}.` };
    if (res.status === 401) return { ok: false, message: `${base} requires credentials (HTTP 401).` };
    return { ok: false, message: `${base} answered HTTP ${res.status} on /v2/.` };
  } catch (err) {
    return { ok: false, message: `Could not reach ${base}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Proxy repositories whose tags were not pulled within the window. */
export async function evictProxyTags(unusedForMs: number, dryRun: boolean): Promise<{ candidates: number; deleted: number; repositories: number }> {
  const cutoff = new Date(Date.now() - unusedForMs);
  const { rows } = await db.execute(sql`
    SELECT t.repository_id, t.name FROM tags t
    JOIN repositories r ON r.id = t.repository_id
    JOIN organization_proxies p ON p.organization_id = r.organization_id
    WHERE COALESCE(t.last_pulled_at, t.created_at) < ${cutoff}`);
  const repos = new Set(rows.map((r) => r.repository_id as string));
  if (dryRun || rows.length === 0) return { candidates: rows.length, deleted: 0, repositories: repos.size };
  const { rows: deleted } = await db.execute(sql`
    DELETE FROM tags t
    USING repositories r, organization_proxies p
    WHERE r.id = t.repository_id AND p.organization_id = r.organization_id
      AND COALESCE(t.last_pulled_at, t.created_at) < ${cutoff}
    RETURNING t.name`);
  return { candidates: rows.length, deleted: deleted.length, repositories: repos.size };
}
