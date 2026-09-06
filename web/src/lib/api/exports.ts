// Vulnerability exports: the findings of one image as SARIF 2.1.0 (what
// GitHub code scanning and most security dashboards ingest) and as a
// CycloneDX 1.5 VEX document (which findings are accepted risks and why).
// Pure transformations over the normalised findings and their exceptions.
import type { AssessedFinding, Finding, Severity } from "@/lib/scanner-shared";
import { API_REVISION } from "./version";

export interface ExportSubject {
  /** registry.example.com/acme/api */
  reference: string;
  organization: string;
  repository: string;
  digest: string;
  tags: string[];
  scanner: string | null;
  scannerVersion: string | null;
  scannedAt: string | null;
}

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note" | "none"> = {
  Critical: "error",
  High: "error",
  Medium: "warning",
  Low: "note",
  Negligible: "note",
  Unknown: "warning",
};

const SECURITY_SEVERITY: Record<Severity, string> = { Critical: "9.5", High: "8.0", Medium: "5.5", Low: "2.5", Negligible: "1.0", Unknown: "5.0" };

function describe(f: Finding): string {
  const fix = f.fixedIn ? `fixed in ${f.fixedIn}` : "no fix available";
  return `${f.package} ${f.version}: ${f.title ?? f.id} (${f.severity}, ${fix})`;
}

/** SARIF 2.1.0 with one rule per advisory and one result per affected package; accepted risks become suppressions. */
export function toSarif(subject: ExportSubject, findings: AssessedFinding[]) {
  const rules = new Map<string, Record<string, unknown>>();
  for (const { finding: f } of findings) {
    if (rules.has(f.id)) continue;
    rules.set(f.id, {
      id: f.id,
      name: f.id.replace(/[^A-Za-z0-9]+/g, ""),
      shortDescription: { text: (f.title ?? f.id).slice(0, 1000) },
      ...(f.description ? { fullDescription: { text: f.description.slice(0, 4000) } } : {}),
      ...(f.links[0] ? { helpUri: f.links[0] } : {}),
      help: { text: f.description?.slice(0, 4000) ?? f.title ?? f.id, markdown: f.links.length ? f.links.map((l) => `- ${l}`).join("\n") : (f.title ?? f.id) },
      defaultConfiguration: { level: SARIF_LEVEL[f.severity] },
      properties: { severity: f.severity, "security-severity": SECURITY_SEVERITY[f.severity], tags: ["security", ...(f.ecosystem ? [f.ecosystem] : [])] },
    });
  }
  const ruleIds = [...rules.keys()];
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Chicorée",
            informationUri: "https://github.com/gochicoree/chicoree",
            version: API_REVISION,
            ...(subject.scanner ? { properties: { scanner: subject.scanner, scannerVersion: subject.scannerVersion } } : {}),
            rules: [...rules.values()],
          },
        },
        automationDetails: { id: `chicoree/${subject.organization}/${subject.repository}/${subject.digest}` },
        artifacts: [{ location: { uri: `${subject.reference}@${subject.digest}` }, description: { text: subject.tags.length ? `tags: ${subject.tags.join(", ")}` : "untagged" } }],
        results: findings.map(({ finding: f, exception }) => ({
          ruleId: f.id,
          ruleIndex: ruleIds.indexOf(f.id),
          level: SARIF_LEVEL[f.severity],
          message: { text: describe(f) },
          locations: [
            {
              physicalLocation: { artifactLocation: { uri: `${subject.reference}@${subject.digest}`, index: 0 } },
              logicalLocations: [{ name: f.package, fullyQualifiedName: `${f.package}@${f.version}`, kind: "package" }],
            },
          ],
          partialFingerprints: { package: f.package, version: f.version, ...(f.layerDigest ? { layer: f.layerDigest } : {}) },
          properties: { severity: f.severity, package: f.package, version: f.version, fixedIn: f.fixedIn, type: f.type, ecosystem: f.ecosystem, distro: f.distro, layerDigest: f.layerDigest },
          ...(exception
            ? { suppressions: [{ kind: "external", status: "accepted", justification: exception.justification, properties: { exceptionId: exception.id, scope: exception.repositoryId ? "repository" : "organization", expiresAt: exception.expiresAt } }] }
            : {}),
        })),
        properties: { scannedAt: subject.scannedAt, digest: subject.digest, tags: subject.tags },
      },
    ],
  };
}

const CDX_SEVERITY: Record<Severity, string> = { Critical: "critical", High: "high", Medium: "medium", Low: "low", Negligible: "info", Unknown: "unknown" };

function purl(subject: ExportSubject): string {
  const [host, ...path] = subject.reference.split("/");
  const name = path[path.length - 1] ?? subject.repository;
  return `pkg:oci/${name}@${encodeURIComponent(subject.digest)}?repository_url=${encodeURIComponent(`${host}/${path.join("/")}`)}`;
}

/** CycloneDX 1.5 VEX: every finding with its analysis state — accepted risks are not_affected with the justification, the rest in_triage. */
export function toCycloneDxVex(subject: ExportSubject, findings: AssessedFinding[], now = new Date()) {
  const ref = purl(subject);
  const byId = new Map<string, { finding: Finding; exceptions: AssessedFinding["exception"][]; packages: Set<string> }>();
  for (const a of findings) {
    const entry = byId.get(a.finding.id) ?? { finding: a.finding, exceptions: [], packages: new Set<string>() };
    entry.packages.add(`${a.finding.package}@${a.finding.version}`);
    if (a.exception) entry.exceptions.push(a.exception);
    byId.set(a.finding.id, entry);
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    metadata: {
      timestamp: now.toISOString(),
      tools: [{ vendor: "Chicorée", name: subject.scanner ?? "chicoree", version: subject.scannerVersion ?? API_REVISION }],
      component: { type: "container", name: `${subject.organization}/${subject.repository}`, version: subject.digest, purl: ref, "bom-ref": ref },
    },
    vulnerabilities: [...byId.values()].map(({ finding: f, exceptions, packages }) => {
      const accepted = exceptions.length === findings.filter((a) => a.finding.id === f.id).length && exceptions.length > 0;
      const ex = exceptions[0];
      return {
        id: f.id,
        ...(f.links[0] ? { source: { name: f.id.startsWith("GHSA") ? "GitHub Advisory Database" : f.id.startsWith("CVE") ? "NVD" : "advisory", url: f.links[0] } } : {}),
        ratings: [{ severity: CDX_SEVERITY[f.severity], method: "other", source: { name: subject.scanner ?? "scanner" } }],
        ...(f.title || f.description ? { description: (f.title ?? f.description ?? "").slice(0, 2000) } : {}),
        ...(f.fixedIn ? { recommendation: `Upgrade ${f.package} to ${f.fixedIn}` } : {}),
        affects: [{ ref, versions: [...packages].map((p) => ({ version: p, status: accepted ? "unaffected" : "affected" })) }],
        analysis: accepted
          ? { state: "not_affected", justification: "protected_by_mitigating_control", response: ["will_not_fix"], detail: `${ex?.justification ?? "accepted risk"}${ex?.expiresAt ? ` (until ${new Date(ex.expiresAt).toISOString().slice(0, 10)})` : ""}` }
          : { state: "in_triage" },
        properties: [
          { name: "chicoree:package", value: f.package },
          { name: "chicoree:ecosystem", value: f.ecosystem ?? "" },
          ...(f.layerDigest ? [{ name: "chicoree:layer", value: f.layerDigest }] : []),
        ],
      };
    }),
  };
}
