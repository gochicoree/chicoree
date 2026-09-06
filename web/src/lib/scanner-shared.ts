// Vulnerability scanning types and pure helpers, safe for client components:
// the normalised finding shape every scanner backend produces, severity
// summaries, VEX-style exceptions, and the filters of the vulnerabilities tab.
import type { SeveritySummary } from "@/components/severity";

export const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

export const SCANNER_BACKENDS = ["off", "clair", "trivy"] as const;
export type ScannerBackend = (typeof SCANNER_BACKENDS)[number];

export const SCANNER_LABELS: Record<ScannerBackend, string> = { off: "Off", clair: "Clair", trivy: "Trivy" };

/** What Administration → Scanning stores (env variables are the defaults). */
export interface ScannerSettings {
  backend: ScannerBackend;
  clairUrl: string;
  /** Empty = standalone trivy, downloading its own database into TRIVY_CACHE_DIR. */
  trivyServerUrl: string;
  trivyTimeoutSeconds: number;
  /** Trivy only: hand scans to external workers (SCAN_WORKER_TOKEN) instead of running them in the web container. */
  workers: boolean;
}

/** One vulnerability in one package, as stored in vulnerability_scans.findings. */
export interface Finding {
  /** CVE-…, GHSA-…, ALPINE-…, or whatever the scanner calls it. */
  id: string;
  severity: Severity;
  package: string;
  version: string;
  fixedIn: string | null;
  /** os | library | … */
  type: string;
  title: string | null;
  /** Short; long descriptions are cut when normalising. */
  description: string | null;
  links: string[];
  layerDigest: string | null;
  /** Package ecosystem or distribution: alpine, debian, npm, gobinary, … */
  ecosystem: string | null;
  /** Distribution the OS packages come from ("Alpine Linux v3.21"). */
  distro: string | null;
}

/** The exception fields the pure helpers need (the table row is a superset). */
export interface ExceptionRule {
  id: string;
  organizationId: string;
  repositoryId: string | null;
  vulnerabilityId: string;
  package: string | null;
  justification: string;
  expiresAt: Date | string | null;
}

/**
 * A scan the registry is still working on. A row that has sat in `pending`
 * or `indexing` for longer than this was almost certainly abandoned (the web
 * app restarted mid-scan), so it stops blocking a new attempt.
 */
export const SCAN_STUCK_AFTER_MS = 30 * 60 * 1000;

export function scanInProgress(
  scan: { status: string | null; updatedAt: Date | string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!scan || (scan.status !== "pending" && scan.status !== "indexing")) return false;
  const started = scan.updatedAt ? new Date(scan.updatedAt).getTime() : 0;
  return now.getTime() - started < SCAN_STUCK_AFTER_MS;
}

export function normalizeSeverity(value: string | null | undefined): Severity {
  const v = (value ?? "").trim().toLowerCase();
  switch (v) {
    case "critical":
      return "Critical";
    case "high":
      return "High";
    case "medium":
    case "moderate":
      return "Medium";
    case "low":
      return "Low";
    case "negligible":
      return "Negligible";
    default:
      return "Unknown";
  }
}

export const SEVERITY_RANK: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3, Negligible: 4, Unknown: 5 };

/** Sort most severe first, then by package and id — stable across scanners. */
export function sortFindings<T extends Pick<Finding, "severity" | "package" | "id">>(findings: T[]): T[] {
  return [...findings].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99) ||
      a.package.localeCompare(b.package) ||
      a.id.localeCompare(b.id),
  );
}

/** Per-severity counts over a list of findings (every key present, zeros included). */
export function summarizeFindings(findings: Pick<Finding, "severity">[]): Record<Severity, number> {
  const summary = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) summary[SEVERITY_ORDER.includes(f.severity) ? f.severity : "Unknown"]++;
  return summary;
}

export function isExpired(rule: Pick<ExceptionRule, "expiresAt">, now: Date = new Date()): boolean {
  if (!rule.expiresAt) return false;
  const t = rule.expiresAt instanceof Date ? rule.expiresAt.getTime() : Date.parse(rule.expiresAt);
  return Number.isFinite(t) && t <= now.getTime();
}

/**
 * Does an exception cover a finding of the given repository? Ids compare
 * case-insensitively; a package-limited exception must match the package
 * name exactly; a repository-scoped exception only applies to its repository.
 */
export function exceptionApplies(
  rule: ExceptionRule,
  finding: Pick<Finding, "id" | "package">,
  repositoryId: string | null,
  now: Date = new Date(),
): boolean {
  if (isExpired(rule, now)) return false;
  if (rule.repositoryId && rule.repositoryId !== repositoryId) return false;
  if (rule.vulnerabilityId.toLowerCase() !== finding.id.toLowerCase()) return false;
  if (rule.package && rule.package !== finding.package) return false;
  return true;
}

export interface AssessedFinding<T extends Finding = Finding> {
  finding: T;
  /** The exception that accepts this finding, when one applies (repository-scoped rules win over organization-wide ones). */
  exception: ExceptionRule | null;
}

/** Pair every finding with the exception that accepts it, if any. */
export function applyExceptions<T extends Finding>(
  findings: T[],
  rules: ExceptionRule[],
  repositoryId: string | null,
  now: Date = new Date(),
): AssessedFinding<T>[] {
  const active = rules.filter((r) => !isExpired(r, now));
  return findings.map((finding) => {
    const matches = active.filter((r) => exceptionApplies(r, finding, repositoryId, now));
    const exception = matches.find((r) => r.repositoryId) ?? matches[0] ?? null;
    return { finding, exception };
  });
}

/** Severity counts of the findings no exception accepts — what the pull policy sees. */
export function effectiveSummary(
  findings: Finding[],
  rules: ExceptionRule[],
  repositoryId: string | null,
  now: Date = new Date(),
): Record<Severity, number> {
  return summarizeFindings(applyExceptions(findings, rules, repositoryId, now).filter((a) => !a.exception).map((a) => a.finding));
}

export interface FindingFilter {
  /** Empty = every severity. */
  severities: Severity[];
  fixedOnly: boolean;
  /** Matched against id, package, title (case-insensitive substring). */
  query: string;
  /** Hide findings an exception accepts. */
  hideAccepted: boolean;
}

export const EMPTY_FILTER: FindingFilter = { severities: [], fixedOnly: false, query: "", hideAccepted: false };

export function filterFindings<T extends Finding>(rows: AssessedFinding<T>[], filter: FindingFilter): AssessedFinding<T>[] {
  const q = filter.query.trim().toLowerCase();
  return rows.filter(({ finding, exception }) => {
    if (filter.severities.length > 0 && !filter.severities.includes(finding.severity)) return false;
    if (filter.fixedOnly && !finding.fixedIn) return false;
    if (filter.hideAccepted && exception) return false;
    if (q) {
      const hay = `${finding.id} ${finding.package} ${finding.title ?? ""} ${finding.ecosystem ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** A SeveritySummary (partial) as the full record the pure helpers return. */
export function toSummary(summary: SeveritySummary | null | undefined): Record<Severity, number> {
  const out = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  for (const s of SEVERITY_ORDER) out[s] = summary?.[s] ?? 0;
  return out;
}

/** Validate an advisory id typed by a user: CVE-YYYY-N…, GHSA-xxxx-xxxx-xxxx, or a scanner-specific id. */
export function normalizeVulnerabilityId(value: string): string {
  const v = value.trim();
  if (/^cve-\d{4}-\d{4,}$/i.test(v)) return v.toUpperCase();
  if (/^ghsa-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i.test(v)) return v.toUpperCase();
  return v;
}

export function isVulnerabilityIdLike(value: string): boolean {
  return /^(cve-\d{4}-\d+|ghsa-[a-z0-9-]+|[a-z]+-\d{4}-\d+|[A-Za-z]+-\d+)$/i.test(value.trim());
}
