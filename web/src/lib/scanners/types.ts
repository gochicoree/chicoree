// The scanner backend contract. lib/scan.ts drives whichever backend the
// instance settings select; backends only know how to turn one image into
// normalised findings and how to report their own health.
import type { Finding, ScannerBackend, Severity } from "../scanner-shared";

export interface ScanLayer {
  digest: string;
  size?: number;
  mediaType?: string;
}

export interface ScanInput {
  /** Repository path as the registry knows it (org/repo, nested for proxy caches). */
  repositoryPath: string;
  /** Manifest digest of a single-platform image (index children are scanned one by one). */
  digest: string;
  /** Parsed manifest payload. */
  manifest: { mediaType?: string; config?: ScanLayer; layers?: ScanLayer[] };
  layers: ScanLayer[];
  /** Registry base URL the backend pulls from (REGISTRY_INTERNAL_URL). */
  registryUrl: string;
  /** Bearer token granting pull on repositoryPath, valid for a couple of hours. */
  token: string;
}

export interface ScanOutput {
  findings: Finding[];
  /** The backend's own report, stored for reference. */
  raw: unknown;
  summary: Record<Severity, number>;
  scannerVersion: string | null;
}

export interface ScannerHealth {
  status: "ok" | "warn" | "error";
  summary: string;
  details: { label: string; value: string }[];
  latencyMs: number;
}

export interface Scanner {
  name: Exclude<ScannerBackend, "off">;
  /** Human label for the UI ("Clair", "Trivy"). */
  label: string;
  version(): Promise<string | null>;
  scan(input: ScanInput): Promise<ScanOutput>;
  health(): Promise<ScannerHealth>;
}
