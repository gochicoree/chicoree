// Pure helpers for proxy-cache organizations, safe for client components.
// The Go side (registryd/internal/upstream/names.go) applies the same name
// mapping and allow-list rules; keep both in sync.

export type ProxyPreset = "dockerhub" | "ghcr" | "quay" | "custom";

export const PROXY_PRESETS: { value: ProxyPreset; label: string; url: string; hint: string }[] = [
  {
    value: "dockerhub",
    label: "Docker Hub",
    url: "https://registry-1.docker.io",
    hint: "Anonymous pulls are rate-limited (100 per 6 h per IP); add a Docker Hub account or access token.",
  },
  { value: "ghcr", label: "GitHub Container Registry", url: "https://ghcr.io", hint: "Public images need no credentials; private ones a personal access token with read:packages." },
  { value: "quay", label: "Quay.io", url: "https://quay.io", hint: "Use a robot account for private repositories." },
  { value: "custom", label: "Other OCI registry", url: "", hint: "Any registry that speaks the distribution API, including another Chicorée instance." },
];

export function presetFor(url: string): ProxyPreset {
  const host = hostOf(url);
  if (isDockerHubHost(host)) return "dockerhub";
  if (host === "ghcr.io") return "ghcr";
  if (host === "quay.io") return "quay";
  return "custom";
}

export function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return url.trim().replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  }
}

function isDockerHubHost(host: string): boolean {
  const h = host.split(":")[0];
  return ["registry-1.docker.io", "index.docker.io", "docker.io", "registry.hub.docker.com", "hub.docker.com"].includes(h);
}

export function isDockerHubUrl(url: string): boolean {
  return isDockerHubHost(hostOf(url));
}

/** What users see: "docker.io" instead of the API host. */
export function displayHost(url: string): string {
  const host = hostOf(url);
  return isDockerHubHost(host) ? "docker.io" : host;
}

/**
 * Canonical local repository name for a requested path. Docker Hub library
 * images are stored in their short form (`library/nginx` → `nginx`), so both
 * spellings resolve to the same repository.
 */
export function proxyLocalName(dockerHub: boolean, requested: string): string {
  if (dockerHub) {
    const rest = requested.startsWith("library/") ? requested.slice("library/".length) : null;
    if (rest && !rest.includes("/")) return rest;
  }
  return requested;
}

/** The path on the upstream for a local repository name. */
export function proxyUpstreamPath(dockerHub: boolean, local: string): string {
  return dockerHub && !local.includes("/") ? `library/${local}` : local;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Space/comma-separated globs on the upstream path; empty allows everything. */
export function proxyPatternsAllow(patterns: string, upstreamPath: string): boolean {
  const list = patterns.split(/[\s,]+/).filter(Boolean);
  if (list.length === 0) return true;
  return list.some((p) => globToRegex(p).test(upstreamPath));
}

/** One OCI path component. */
const COMPONENT_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

/** Validate a (possibly nested) repository name: every component must be an OCI path component. */
export function isValidRepoName(name: string, allowNested: boolean): boolean {
  if (!name || name.length > 255) return false;
  const parts = name.split("/");
  if (parts.length > 1 && !allowNested) return false;
  return parts.every((p) => COMPONENT_RE.test(p));
}

/**
 * Link to a repository page. Nested names (proxy caches) are a single URL
 * segment with the slashes percent-encoded: /dockerhub/bitnami%2Fredis.
 */
export function repoHref(orgSlug: string, repoName: string): string {
  return `/${orgSlug}/${encodeRepoSegment(repoName)}`;
}

export function encodeRepoSegment(repoName: string): string {
  return repoName.includes("/") ? encodeURIComponent(repoName) : repoName;
}

/** The repository name from a route param (Next decodes %2F to "/" already). */
export function decodeRepoParam(param: string): string {
  return param.includes("%") ? decodeURIComponent(param) : param;
}

/** Parse a duration like "30d", "12h", "45m" into milliseconds. */
export function durationToMs(value: string | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const m = /^(\d+)([smhd])$/.exec(value.trim());
  if (!m) return fallbackMs;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}
