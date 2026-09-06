// Trivy backend: runs the trivy binary as a child process against the
// image in the registry (trivy pulls it with the registry token itself),
// optionally against a trivy server that holds the vulnerability database,
// and normalises the JSON report.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { relativeTime } from "../format";
import { normalizeSeverity, sortFindings, summarizeFindings, type Finding } from "../scanner-shared";
import type { ScanInput, ScanOutput, Scanner, ScannerHealth } from "./types";

export interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  PkgID?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Status?: string;
  Severity?: string;
  Title?: string;
  Description?: string;
  PrimaryURL?: string;
  References?: string[];
  Layer?: { Digest?: string; DiffID?: string };
}

export interface TrivyResult {
  Target?: string;
  /** os-pkgs | lang-pkgs | config | secret | license */
  Class?: string;
  /** alpine, debian, ubuntu, gobinary, npm, python-pkg, … */
  Type?: string;
  Vulnerabilities?: TrivyVulnerability[] | null;
}

export interface TrivyReport {
  SchemaVersion?: number;
  ArtifactName?: string;
  ArtifactType?: string;
  Metadata?: { OS?: { Family?: string; Name?: string; EOSL?: boolean }; ImageID?: string; RepoDigests?: string[] };
  Results?: TrivyResult[] | null;
}

function typeFor(cls: string | undefined): string {
  if (cls === "os-pkgs") return "os";
  if (cls === "lang-pkgs") return "library";
  return cls || "library";
}

/** Trivy's JSON report → normalised findings. */
export function normalizeTrivyReport(report: TrivyReport): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const os = report.Metadata?.OS;
  const distro = os?.Family ? `${os.Family}${os.Name ? ` ${os.Name}` : ""}` : null;
  for (const result of report.Results ?? []) {
    if (result?.Class && result.Class !== "os-pkgs" && result.Class !== "lang-pkgs") continue;
    const type = typeFor(result?.Class);
    for (const v of result?.Vulnerabilities ?? []) {
      const id = (v.VulnerabilityID ?? "").trim();
      if (!id) continue;
      const packageName = v.PkgName ?? "unknown";
      const version = v.InstalledVersion ?? "";
      const key = `${id}|${packageName}|${version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const links = [v.PrimaryURL, ...(v.References ?? [])]
        .filter((l): l is string => typeof l === "string" && /^https?:\/\//.test(l))
        .filter((l, i, a) => a.indexOf(l) === i)
        .slice(0, 10);
      findings.push({
        id,
        severity: normalizeSeverity(v.Severity),
        package: packageName,
        version,
        fixedIn: v.FixedVersion || null,
        type,
        title: v.Title ? v.Title.slice(0, 200) : null,
        description: v.Description ? v.Description.slice(0, 500) : null,
        links,
        layerDigest: v.Layer?.Digest || null,
        ecosystem: result?.Type ?? null,
        distro: type === "os" ? distro : null,
      });
    }
  }
  return sortFindings(findings);
}

export interface TrivyOptions {
  bin: string;
  serverUrl: string;
  /** Authentication for the Trivy server (`--token`); empty = none. */
  serverToken?: string;
  timeoutSeconds: number;
  cacheDir: string;
}

interface Exec {
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Exec> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        if (error) {
          const tail = String(stderr ?? "")
            .split("\n")
            .filter((l) => l.trim())
            .slice(-6)
            .join(" · ")
            .slice(0, 600);
          const why = (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `trivy binary not found (${bin}); set TRIVY_BIN or use the container image`
            : error.killed || (error as { signal?: string }).signal === "SIGKILL"
              ? `trivy timed out after ${Math.round(timeoutMs / 1000)} s`
              : `trivy exited with ${(error as { code?: number | string }).code ?? "an error"}`;
          reject(new Error(tail ? `${why}: ${tail}` : why));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** host[:port] of the registry as trivy addresses it; http means --insecure. */
export function registryTarget(registryUrl: string): { host: string; insecure: boolean } {
  try {
    const u = new URL(registryUrl);
    return { host: u.host, insecure: u.protocol === "http:" };
  } catch {
    return { host: registryUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, ""), insecure: registryUrl.startsWith("http://") };
  }
}

interface TrivyVersion {
  Version?: string;
  VulnerabilityDB?: { Version?: number; UpdatedAt?: string; NextUpdate?: string; DownloadedAt?: string } | null;
}

export function createTrivyScanner(opts: TrivyOptions): Scanner {
  const baseEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    TRIVY_CACHE_DIR: opts.cacheDir,
    TRIVY_NO_PROGRESS: "true",
    TRIVY_SKIP_VERSION_CHECK: "true",
    TRIVY_DISABLE_TELEMETRY: "true",
    ...(opts.serverUrl ? { TRIVY_SERVER: opts.serverUrl.replace(/\/$/, "") } : {}),
  });

  async function versionInfo(): Promise<TrivyVersion> {
    await mkdir(opts.cacheDir, { recursive: true }).catch(() => {});
    const { stdout } = await run(opts.bin, ["version", "--format", "json", "--cache-dir", opts.cacheDir], baseEnv(), 20_000);
    return JSON.parse(stdout) as TrivyVersion;
  }

  return {
    name: "trivy",
    label: "Trivy",

    async version() {
      try {
        return (await versionInfo()).Version ?? null;
      } catch {
        return null;
      }
    },

    async scan(input: ScanInput): Promise<ScanOutput> {
      const { host, insecure } = registryTarget(input.registryUrl);
      const image = `${host}/${input.repositoryPath}@${input.digest}`;
      await mkdir(opts.cacheDir, { recursive: true }).catch(() => {});
      const args = [
        "image",
        "--format",
        "json",
        "--quiet",
        "--scanners",
        "vuln",
        "--timeout",
        `${opts.timeoutSeconds}s`,
        "--cache-dir",
        opts.cacheDir,
        // Never fall back to a local docker daemon or containerd socket.
        "--image-src",
        "remote",
      ];
      if (insecure) args.push("--insecure");
      if (opts.serverUrl) {
        args.push("--server", opts.serverUrl.replace(/\/$/, ""));
        if (opts.serverToken) args.push("--token", opts.serverToken);
      }
      args.push(image);
      // The pull token is handed over as a docker config entry for our
      // registry host only (a "registrytoken" is used as the Bearer as is,
      // so the token realm is never contacted). A global --registry-token
      // would also be sent to the registries trivy downloads its database
      // from, and never on the command line: no token in process listings.
      const dockerDir = await mkdtemp(path.join(tmpdir(), "chicoree-trivy-"));
      let stdout: string;
      try {
        await writeFile(
          path.join(dockerDir, "config.json"),
          JSON.stringify({ auths: { [host]: { registrytoken: input.token } } }),
          { mode: 0o600 },
        );
        ({ stdout } = await run(opts.bin, args, { ...baseEnv(), DOCKER_CONFIG: dockerDir }, (opts.timeoutSeconds + 30) * 1000));
      } finally {
        await rm(dockerDir, { recursive: true, force: true }).catch(() => {});
      }
      let report: TrivyReport;
      try {
        report = JSON.parse(stdout) as TrivyReport;
      } catch {
        throw new Error(`trivy produced no JSON report: ${stdout.slice(0, 200)}`);
      }
      const findings = normalizeTrivyReport(report);
      let scannerVersion: string | null = null;
      try {
        scannerVersion = (await versionInfo()).Version ?? null;
      } catch {
        // version is informational
      }
      return { findings, raw: report, summary: summarizeFindings(findings), scannerVersion };
    },

    async health(): Promise<ScannerHealth> {
      const started = Date.now();
      const details: { label: string; value: string }[] = [
        { label: "Binary", value: opts.bin },
        { label: "Cache dir", value: opts.cacheDir },
        { label: "Mode", value: opts.serverUrl ? `client of ${opts.serverUrl}` : "standalone (local database)" },
      ];
      let info: TrivyVersion;
      try {
        info = await versionInfo();
      } catch (e) {
        return { status: "error", summary: e instanceof Error ? e.message : String(e), details, latencyMs: Date.now() - started };
      }
      details.push({ label: "Version", value: info.Version ?? "unknown" });
      if (opts.serverUrl) {
        try {
          const res = await fetch(`${opts.serverUrl.replace(/\/$/, "")}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
          const latencyMs = Date.now() - started;
          details.push({ label: "Server", value: `${res.ok ? "healthy" : `answered ${res.status}`} · ${latencyMs} ms` });
          if (!res.ok) return { status: "error", summary: `Trivy server answered ${res.status}`, details, latencyMs };
          return { status: "ok", summary: `trivy ${info.Version ?? ""} with server ${opts.serverUrl}`.trim(), details, latencyMs };
        } catch (e) {
          return { status: "error", summary: `Trivy server unreachable: ${e instanceof Error ? e.message : String(e)}`, details, latencyMs: Date.now() - started };
        }
      }
      const db = info.VulnerabilityDB;
      const latencyMs = Date.now() - started;
      if (!db?.UpdatedAt) {
        details.push({ label: "Database", value: "not downloaded yet (fetched on the first scan)" });
        return { status: "warn", summary: `trivy ${info.Version ?? ""} ready; the vulnerability database downloads on the first scan`.trim(), details, latencyMs };
      }
      const updated = new Date(db.UpdatedAt);
      details.push({ label: "Database updated", value: `${updated.toISOString()} (${relativeTime(updated)})` });
      if (db.NextUpdate) details.push({ label: "Next update", value: db.NextUpdate });
      const stale = Date.now() - updated.getTime() > 7 * 86_400_000;
      return {
        status: stale ? "warn" : "ok",
        summary: stale ? `trivy ${info.Version}; database is older than a week` : `trivy ${info.Version}; database updated ${relativeTime(updated)}`,
        details,
        latencyMs,
      };
    },
  };
}
