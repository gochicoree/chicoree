// Minimal client for the Clair v4 HTTP API (indexer + matcher, combo mode).
import { env } from "./env";

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
}

export interface ClairVulnerabilityReport {
  manifest_hash: string;
  vulnerabilities: Record<string, ClairVulnerability>;
  package_vulnerabilities: Record<string, string[]>;
  packages: Record<string, { id?: string; name?: string; version?: string; kind?: string }>;
  environments?: Record<string, unknown[]>;
}

export const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

function base(): string {
  return env.clairUrl.replace(/\/$/, "");
}

export async function submitIndex(manifestHash: string, layers: ClairLayer[]): Promise<ClairIndexReport> {
  const res = await fetch(`${base()}/indexer/api/v1/index_report`, {
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

export async function getIndexReport(manifestHash: string): Promise<ClairIndexReport | null> {
  const res = await fetch(`${base()}/indexer/api/v1/index_report/${manifestHash}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`clair indexer answered ${res.status}`);
  return (await res.json()) as ClairIndexReport;
}

export async function getVulnerabilityReport(manifestHash: string): Promise<ClairVulnerabilityReport | null> {
  const res = await fetch(`${base()}/matcher/api/v1/vulnerability_report/${manifestHash}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`clair matcher answered ${res.status}`);
  return (await res.json()) as ClairVulnerabilityReport;
}

/** Count findings per normalized severity. */
export function summarizeReport(report: ClairVulnerabilityReport): Record<Severity, number> {
  const summary = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    const sev = (vuln.normalized_severity ?? "Unknown") as Severity;
    summary[SEVERITY_ORDER.includes(sev) ? sev : "Unknown"]++;
  }
  return summary;
}
