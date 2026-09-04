// Clair v4 backend: submits the image layers to the indexer (Clair fetches
// them from the registry itself with the pull token), waits for indexing and
// normalises the matcher's vulnerability report.
import {
  getIndexReport,
  getVulnerabilityReport,
  probeClair,
  submitIndex,
  updaterStatus,
  type ClairLayer,
  type ClairVulnerabilityReport,
} from "../clair";
import { relativeTime } from "../format";
import { normalizeSeverity, sortFindings, summarizeFindings, type Finding } from "../scanner-shared";
import type { ScanInput, ScanOutput, Scanner, ScannerHealth } from "./types";

const OS_PACKAGE_DBS = ["lib/apk/", "var/lib/dpkg", "var/lib/rpm", "usr/lib/sysimage/rpm", "usr/share/rpm", "var/lib/rpmmanifest"];

function typeFor(packageDb: string | undefined, updater: string | undefined): string {
  if (packageDb && OS_PACKAGE_DBS.some((p) => packageDb.startsWith(p))) return "os";
  if (packageDb) return "library";
  // No environment: guess from the updater name (osv/… and language updaters are libraries).
  if (updater && /^(osv|pypi|npm|go|ruby|maven|crates|cargo|nuget)/i.test(updater)) return "library";
  return updater ? "os" : "library";
}

function ecosystemFor(packageDb: string | undefined, updater: string | undefined, distroDid: string | undefined): string | null {
  if (packageDb) {
    if (packageDb.startsWith("lib/apk/")) return "alpine";
    if (packageDb.startsWith("var/lib/dpkg")) return distroDid ?? "dpkg";
    if (/rpm/.test(packageDb)) return distroDid ?? "rpm";
    const m = /^([a-z0-9_-]+):/i.exec(packageDb);
    if (m) return m[1].toLowerCase();
  }
  if (updater) {
    const m = /^(osv\/)?([a-z0-9]+)/i.exec(updater);
    if (m) return m[2].toLowerCase();
  }
  return distroDid ?? null;
}

/** Clair's report → the normalised findings every scanner produces. */
export function normalizeClairReport(report: ClairVulnerabilityReport): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const [pkgId, vulnIds] of Object.entries(report.package_vulnerabilities ?? {})) {
    const pkg = report.packages?.[pkgId];
    const envs = report.environments?.[pkgId] ?? [];
    const env = envs[0];
    const distro = env?.distribution_id ? report.distributions?.[env.distribution_id] : undefined;
    for (const vulnId of vulnIds ?? []) {
      const vuln = report.vulnerabilities?.[vulnId];
      if (!vuln) continue;
      const id = (vuln.name || vulnId).trim();
      const packageName = pkg?.name ?? vuln.package?.name ?? "unknown";
      const version = pkg?.version ?? "";
      const key = `${id}|${packageName}|${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const links = (vuln.links ?? "")
        .split(/\s+/)
        .map((l) => l.trim())
        .filter((l) => /^https?:\/\//.test(l));
      const distroLabel = distro?.pretty_name || vuln.distribution?.pretty_name || (distro?.name ? `${distro.name} ${distro.version ?? distro.version_id ?? ""}`.trim() : null);
      findings.push({
        id,
        severity: normalizeSeverity(vuln.normalized_severity),
        package: packageName,
        version,
        fixedIn: vuln.fixed_in_version || null,
        type: typeFor(env?.package_db, vuln.updater),
        title: null,
        description: vuln.description ? vuln.description.slice(0, 500) : null,
        links,
        layerDigest: env?.introduced_in || null,
        ecosystem: ecosystemFor(env?.package_db, vuln.updater, distro?.did ?? vuln.distribution?.did),
        distro: distroLabel || null,
      });
    }
  }
  return sortFindings(findings);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createClairScanner(url: string): Scanner {
  const base = url.replace(/\/$/, "");
  return {
    name: "clair",
    label: "Clair",

    async version() {
      // Clair exposes no version on its API port.
      return null;
    },

    async scan(input: ScanInput): Promise<ScanOutput> {
      const layers: ClairLayer[] = input.layers.map((l) => ({
        hash: l.digest,
        uri: `${input.registryUrl}/v2/${input.repositoryPath}/blobs/${l.digest}`,
        headers: { Authorization: [`Bearer ${input.token}`] },
      }));
      let report = await submitIndex(base, input.digest, layers);
      const deadline = Date.now() + 300_000;
      while (report.state !== "IndexFinished" && report.state !== "IndexError") {
        if (Date.now() > deadline) throw new Error("timed out waiting for Clair indexing");
        await sleep(3000);
        report = (await getIndexReport(base, input.digest)) ?? report;
      }
      if (report.state === "IndexError") {
        throw new Error(`Clair indexing failed: ${report.err ?? "unknown error"}`);
      }
      const vulnReport = await getVulnerabilityReport(base, input.digest);
      if (!vulnReport) throw new Error("Clair produced no vulnerability report");
      const findings = normalizeClairReport(vulnReport);
      return { findings, raw: vulnReport, summary: summarizeFindings(findings), scannerVersion: null };
    },

    async health(): Promise<ScannerHealth> {
      const details: { label: string; value: string }[] = [{ label: "URL", value: base }];
      const started = Date.now();
      let probe: { alive: boolean; probe: string };
      try {
        probe = await probeClair(base);
      } catch (e) {
        return { status: "error", summary: `Unreachable: ${e instanceof Error ? e.message : String(e)}`, details, latencyMs: Date.now() - started };
      }
      const latencyMs = Date.now() - started;
      details.push({ label: "Liveness", value: `${probe.probe} · ${latencyMs} ms` });
      if (!probe.alive) return { status: "error", summary: "Clair is not answering", details, latencyMs };
      try {
        const u = await updaterStatus(base);
        if ("error" in u) {
          details.push({ label: "Updaters", value: u.error });
          return { status: "warn", summary: "Up; updater status unavailable", details, latencyMs };
        }
        details.push({ label: "Updaters with data", value: String(u.updaters) });
        if (u.updaters === 0 || !u.latest) {
          details.push({ label: "Last update", value: "none yet" });
          return { status: "warn", summary: "Up; vulnerability databases are still syncing (no updater has run)", details, latencyMs };
        }
        const stale = Date.now() - u.latest.getTime() > 48 * 3600_000;
        details.push({ label: "Last update", value: `${u.latest.toISOString()} (${relativeTime(u.latest)})` });
        return {
          status: stale ? "warn" : "ok",
          summary: stale ? "Up, but no updater ran in the last 48 hours" : `Up; advisories updated ${relativeTime(u.latest)}`,
          details,
          latencyMs,
        };
      } catch (e) {
        details.push({ label: "Updaters", value: e instanceof Error ? e.message : String(e) });
        return { status: "warn", summary: "Up; updater status unavailable", details, latencyMs };
      }
    },
  };
}
