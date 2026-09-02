// Minimal client for *other* OCI registries (Docker Hub, GHCR, Quay, another
// Chicorée…): token/basic auth negotiation, tag listing, manifest and blob
// fetches. Used by the mirror importer.

export interface RemoteAuth {
  username: string;
  password: string;
}

export interface ParsedSource {
  /** Registry API base, e.g. https://registry-1.docker.io */
  baseUrl: string;
  /** Repository path inside the registry, e.g. library/nginx */
  repository: string;
  /** Human-readable host for display. */
  host: string;
}

/**
 * Accepts "nginx", "library/nginx", "docker.io/library/nginx",
 * "ghcr.io/org/app", "registry.example.com:5000/team/app", "http://localhost:5010/acme/web".
 */
export function parseSource(source: string): ParsedSource {
  let s = source.trim();
  let scheme = "https";
  if (s.startsWith("http://")) {
    scheme = "http";
    s = s.slice(7);
  } else if (s.startsWith("https://")) {
    s = s.slice(8);
  }
  const parts = s.split("/").filter(Boolean);
  const first = parts[0] ?? "";
  const looksLikeHost = first.includes(".") || first.includes(":") || first === "localhost";
  let host: string;
  let repoParts: string[];
  if (looksLikeHost && parts.length > 1) {
    host = first;
    repoParts = parts.slice(1);
  } else {
    host = "docker.io";
    repoParts = parts;
  }
  if (host === "docker.io" || host === "index.docker.io") {
    host = "docker.io";
    if (repoParts.length === 1) repoParts = ["library", repoParts[0]];
  }
  const apiHost = host === "docker.io" ? "registry-1.docker.io" : host;
  if (scheme === "https" && (apiHost.startsWith("localhost") || /^127\.|^host\.docker\.internal/.test(apiHost))) {
    scheme = "http";
  }
  return { baseUrl: `${scheme}://${apiHost}`, repository: repoParts.join("/"), host };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Registries and their CDNs close idle keep-alive connections; undici may
 * reuse one a moment too late ("other side closed"). All our requests are
 * idempotent GETs, so retry transient network failures on a fresh attempt.
 */
async function fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      const cause = (err as Error & { cause?: { code?: string } }).cause;
      const code = cause?.code ?? "";
      const transient =
        err instanceof TypeError &&
        (/UND_ERR_SOCKET|ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED/.test(code) || code === "");
      if (!transient || i === attempts - 1) throw err;
      await sleep(300 * (i + 1));
    }
  }
  throw lastErr;
}

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

export class RemoteRegistry {
  private tokens = new Map<string, string>();

  constructor(
    private readonly src: ParsedSource,
    private readonly auth: RemoteAuth | null,
  ) {}

  private basicHeader(): string | null {
    return this.auth ? `Basic ${Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64")}` : null;
  }

  /** Fetch with automatic Bearer/Basic challenge handling and retries. */
  async request(path: string, init: RequestInit = {}, scope = `repository:${this.src.repository}:pull`): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.src.baseUrl}${path}`;
    const headers = new Headers(init.headers);
    const cached = this.tokens.get(scope);
    if (cached) headers.set("Authorization", cached);
    let res = await fetchWithRetry(url, { ...init, headers, redirect: "follow", cache: "no-store" });
    if (res.status !== 401) return res;

    const challenge = res.headers.get("www-authenticate") ?? "";
    // Drain rather than cancel: cancelling a body under Next's patched fetch
    // can stall indefinitely.
    await res.arrayBuffer().catch(() => undefined);
    if (/^Bearer /i.test(challenge)) {
      const params = Object.fromEntries(
        [...challenge.slice(7).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
      );
      const tokenUrl = new URL(params.realm);
      if (params.service) tokenUrl.searchParams.set("service", params.service);
      tokenUrl.searchParams.set("scope", params.scope ?? scope);
      const tokenHeaders: Record<string, string> = {};
      const basic = this.basicHeader();
      if (basic) tokenHeaders.Authorization = basic;
      const tokenRes = await fetchWithRetry(tokenUrl.toString(), { headers: tokenHeaders, cache: "no-store" });
      if (!tokenRes.ok) throw new Error(`token request failed: HTTP ${tokenRes.status}`);
      const body = (await tokenRes.json()) as { token?: string; access_token?: string };
      const token = body.token ?? body.access_token;
      if (!token) throw new Error("token endpoint returned no token");
      this.tokens.set(scope, `Bearer ${token}`);
      headers.set("Authorization", `Bearer ${token}`);
    } else if (/^Basic /i.test(challenge)) {
      const basic = this.basicHeader();
      if (!basic) throw new Error("registry requires credentials");
      headers.set("Authorization", basic);
      this.tokens.set(scope, basic);
    } else {
      throw new Error(`unsupported auth challenge: ${challenge || "none"}`);
    }
    res = await fetchWithRetry(url, { ...init, headers, redirect: "follow", cache: "no-store" });
    return res;
  }

  async listTags(): Promise<string[]> {
    const tags: string[] = [];
    let next: string | null = `/v2/${this.src.repository}/tags/list?n=1000`;
    while (next) {
      const res: Response = await this.request(next);
      if (!res.ok) throw new Error(`tags/list failed: HTTP ${res.status}`);
      const body = (await res.json()) as { tags?: string[] | null };
      tags.push(...(body.tags ?? []));
      const link: string | null = res.headers.get("link");
      const m = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null;
      next = m ? m[1] : null;
    }
    return tags;
  }

  async getManifest(reference: string): Promise<{ bytes: Buffer; mediaType: string; digest: string }> {
    const res = await this.request(`/v2/${this.src.repository}/manifests/${reference}`, {
      headers: { Accept: MANIFEST_ACCEPT },
    });
    if (!res.ok) throw new Error(`manifest ${reference}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const mediaType = res.headers.get("content-type")?.split(";")[0].trim() ?? "application/octet-stream";
    const digest = res.headers.get("docker-content-digest") ?? sha256Digest(bytes);
    return { bytes, mediaType, digest };
  }

  async openBlob(digest: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null }> {
    const res = await this.request(`/v2/${this.src.repository}/blobs/${digest}`);
    if (!res.ok || !res.body) throw new Error(`blob ${digest}: HTTP ${res.status}`);
    const len = res.headers.get("content-length");
    return { stream: res.body, size: len ? Number(len) : null };
  }
}

export function sha256Digest(bytes: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("crypto") as typeof import("crypto");
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}
