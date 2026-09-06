// Which scanner backend this instance uses. Everything that used to ask
// "is Clair configured?" asks scanningEnabled() / getScanner() instead; the
// answer comes from Administration → Scanning with SCANNER / CLAIR_URL /
// TRIVY_SERVER_URL as the environment defaults.
import { env } from "../env";
import { getInstanceSettings } from "../instance-settings";
import type { ScannerSettings } from "../scanner-shared";
import { createClairScanner } from "./clair";
import { createTrivyScanner } from "./trivy";
import type { Scanner } from "./types";

export type { ScanInput, ScanOutput, Scanner, ScannerHealth } from "./types";

/** Build the backend a settings section describes; null when scanning is off or misconfigured. */
export function scannerFromSettings(s: ScannerSettings): Scanner | null {
  switch (s.backend) {
    case "clair":
      return s.clairUrl ? createClairScanner(s.clairUrl) : null;
    case "trivy":
      return createTrivyScanner({
        bin: env.trivyBin,
        serverUrl: s.trivyServerUrl,
        serverToken: env.trivyServerToken,
        timeoutSeconds: s.trivyTimeoutSeconds > 0 ? s.trivyTimeoutSeconds : env.trivyTimeoutSeconds,
        cacheDir: env.trivyCacheDir,
      });
    default:
      return null;
  }
}

export async function getScannerSettings(): Promise<ScannerSettings> {
  return (await getInstanceSettings()).scanner;
}

/** The configured backend, or null when scanning is off. */
export async function getScanner(): Promise<Scanner | null> {
  return scannerFromSettings(await getScannerSettings());
}

/** One answer for the tag-list column, the tab, the jobs list and the health page. */
export async function scanningEnabled(): Promise<boolean> {
  return (await getScanner()) !== null;
}

/** "Clair", "Trivy" or "off" for labels. */
export async function scannerLabel(): Promise<string> {
  return (await getScanner())?.label ?? "off";
}
