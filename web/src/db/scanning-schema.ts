// Vulnerability scanning: the searchable side table of findings and the
// VEX-style exceptions that take accepted findings out of the pull policy.
import { index, pgTable, text, timestamp, bigserial } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization } from "./auth-schema";
import { repositories } from "./registry-schema";

/**
 * One row per (digest, vulnerability, package, version), rewritten whenever a
 * scan result is stored (lib/scan.ts). Backs the CVE search and the security
 * dashboards; the full finding objects live in vulnerability_scans.findings.
 */
export const scanFindings = pgTable(
  "scan_findings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Manifest digest of the scanned image (vulnerability_scans.digest). */
    digest: text("digest").notNull(),
    /** CVE-…, GHSA-…, or another advisory id, as the scanner reports it. */
    vulnerabilityId: text("vulnerability_id").notNull(),
    package: text("package").notNull(),
    version: text("version").notNull().default(""),
    fixedIn: text("fixed_in"),
    /** Critical | High | Medium | Low | Negligible | Unknown */
    severity: text("severity").notNull(),
    /** os | library | … */
    type: text("type").notNull().default("os"),
  },
  (t) => [
    index("scan_findings_digest_idx").on(t.digest),
    index("scan_findings_vuln_idx").on(t.vulnerabilityId),
    index("scan_findings_package_idx").on(t.package),
  ],
);

/**
 * Accepted risks: a vulnerability id (optionally limited to a package) that
 * no longer counts against the pull policy for one repository or the whole
 * organization, until it expires or is revoked. Findings stay visible in the
 * report, marked as accepted with the justification.
 */
export const vulnerabilityExceptions = pgTable(
  "vulnerability_exceptions",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** null = every repository of the organization. */
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    vulnerabilityId: text("vulnerability_id").notNull(),
    /** null = the vulnerability in any package. */
    package: text("package"),
    justification: text("justification").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vulnerability_exceptions_org_idx").on(t.organizationId),
    index("vulnerability_exceptions_vuln_idx").on(t.vulnerabilityId),
  ],
);
