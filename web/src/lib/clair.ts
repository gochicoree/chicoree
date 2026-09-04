// Minimal client for the Clair v4 HTTP API (indexer + matcher, combo mode).
// Every call takes the base URL: the scanner backend resolves it from the
// instance settings (lib/scanners/clair.ts).

export interface ClairLayer {
  hash: string;
  uri: string;
  headers: Record<string, string[]>;
}

export interface ClairIndexReport {
  manifest_hash: string;
  state: string;
  err?: string;
  success?: boolean;
}

export interface ClairVulnerability {
  id: string;
  name: string;
  description?: string;
  links?: string;
  severity?: string;
  normalized_severity?: string;
  package?: { name?: string; version?: string };
  fixed_in_version?: string;
  updater?: string;
  issued?: string;
  distribution?: { did?: string; name?: string; version?: string; version_id?: string; pretty_name?: string };
}

export interface ClairPackage {
  id?: string;
  name?: string;
  version?: string;
  kind?: string;
  arch?: string;
}

export interface ClairEnvironment {
  package_db?: string;
  introduced_in?: string;
  distribution_id?: string;
  repository_ids?: string[] | null;
}

export interface ClairDistribution {
  id?: string;
  did?: string;
  name?: string;
  version?: string;
  version_id?: string;
  pretty_name?: string;
}

export interface ClairVulnerabilityReport {
  manifest_hash: string;
  vulnerabilities: Record<string, ClairVulnerability>;
  package_vulnerabilities: Record<string, string[]>;
  packages: Record<string, ClairPackage>;
  environments?: Record<string, ClairEnvironment[]>;
  distributions?: Record<string, ClairDistribution>;
}

const base = (url: string) => url.replace(/\/$/, "");

export async function submitIndex(url: string, manifestHash: string, layers: ClairLayer[]): Promise<ClairIndexReport> {
  const res = await fetch(`${base(url)}/indexer/api/v1/index_report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hash: manifestHash, layers }),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 201) {
    throw new Error(`clair indexer answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as ClairIndexReport;
}

export async function getIndexReport(url: string, manifestHash: string): Promise<ClairIndexReport | null> {
  const res = await fetch(`${base(url)}/indexer/api/v1/index_report/${manifestHash}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`clair indexer answered ${res.status}`);
  return (await res.json()) as ClairIndexReport;
}

export async function getVulnerabilityReport(url: string, manifestHash: string): Promise<ClairVulnerabilityReport | null> {
  const res = await fetch(`${base(url)}/matcher/api/v1/vulnerability_report/${manifestHash}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`clair matcher answered ${res.status}`);
  return (await res.json()) as ClairVulnerabilityReport;
}

/**
 * Liveness: /healthz lives on Clair's introspection port; on the API port it
 * is a 404, so fall back to the indexer state endpoint.
 */
export async function probeClair(url: string, timeoutMs = 3000): Promise<{ alive: boolean; probe: string }> {
  const res = await fetch(`${base(url)}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (res.ok) return { alive: true, probe: "/healthz" };
  const state = await fetch(`${base(url)}/indexer/api/v1/index_state`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  return { alive: state.ok, probe: state.ok ? "/indexer/api/v1/index_state" : `index_state answered ${state.status}` };
}

/**
 * Updater freshness (Clair 4.8: GET /matcher/api/v1/internal/update_operation
 * returns { "<updater>": [ { ref, updater, fingerprint, date } ... ] }).
 */
export async function updaterStatus(url: string, timeoutMs = 3000): Promise<{ updaters: number; latest: Date | null } | { error: string }> {
  const res = await fetch(`${base(url)}/matcher/api/v1/internal/update_operation`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return { error: `update_operation answered ${res.status}` };
  const ops = (await res.json()) as Record<string, { date?: string }[]>;
  let updaters = 0;
  let latest = 0;
  for (const list of Object.values(ops ?? {})) {
    if (!Array.isArray(list) || list.length === 0) continue;
    updaters++;
    for (const op of list) {
      const t = op?.date ? Date.parse(op.date) : NaN;
      if (Number.isFinite(t)) latest = Math.max(latest, t);
    }
  }
  return { updaters, latest: latest ? new Date(latest) : null };
}
