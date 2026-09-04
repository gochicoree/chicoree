// Findings for a vulnerability_scans row. Rows written before the findings
// column existed only carry Clair's raw report; those are normalised on the
// fly (lib/scan.ts persists the result the first time it is read).
import type { ClairVulnerabilityReport } from "../clair";
import type { Finding } from "../scanner-shared";
import { normalizeClairReport } from "./clair";
import { normalizeTrivyReport, type TrivyReport } from "./trivy";

export interface ScanRowLike {
  findings: unknown;
  report: unknown;
  scanner: string | null;
}

export function reportKind(report: unknown): "clair" | "trivy" | null {
  if (!report || typeof report !== "object") return null;
  const r = report as Record<string, unknown>;
  if ("package_vulnerabilities" in r || "vulnerabilities" in r) return "clair";
  if ("Results" in r || "SchemaVersion" in r) return "trivy";
  return null;
}

/** Normalise a raw report of either backend; empty when it is neither. */
export function normalizeReport(report: unknown): Finding[] {
  switch (reportKind(report)) {
    case "clair":
      return normalizeClairReport(report as ClairVulnerabilityReport);
    case "trivy":
      return normalizeTrivyReport(report as TrivyReport);
    default:
      return [];
  }
}

/** The stored findings, or the report normalised when the column is still empty. */
export function findingsOf(row: ScanRowLike): { findings: Finding[]; normalised: boolean } {
  if (Array.isArray(row.findings)) return { findings: row.findings as Finding[], normalised: false };
  return { findings: normalizeReport(row.report), normalised: true };
}
