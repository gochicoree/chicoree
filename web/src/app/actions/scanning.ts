"use server";

// Administration → Scanning: which backend scans pushed images, a Test
// button against the entered values, and "re-scan everything".
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireAdmin } from "@/lib/session";
import { resetSettingsSection, saveSettingsSection } from "@/lib/instance-settings";
import { recordAudit } from "@/lib/audit";
import { runJob } from "@/lib/jobs";
import { scannerFromSettings, type ScannerHealth } from "@/lib/scanners";
import { SCANNER_BACKENDS, type ScannerBackend, type ScannerSettings } from "@/lib/scanner-shared";

export interface ScannerActionResult {
  error?: string;
  saved?: boolean;
  message?: string;
  health?: ScannerHealth & { backend: ScannerBackend };
}

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();

function settingsFromForm(fd: FormData): ScannerSettings | { error: string } {
  const backend = str(fd, "backend") as ScannerBackend;
  if (!SCANNER_BACKENDS.includes(backend)) return { error: "Unknown scanner backend." };
  const clairUrl = str(fd, "clairUrl").replace(/\/$/, "");
  const trivyServerUrl = str(fd, "trivyServerUrl").replace(/\/$/, "");
  const timeoutRaw = str(fd, "trivyTimeoutSeconds");
  const trivyTimeoutSeconds = timeoutRaw ? Number(timeoutRaw) : 600;
  if (!Number.isInteger(trivyTimeoutSeconds) || trivyTimeoutSeconds < 30 || trivyTimeoutSeconds > 7200) {
    return { error: "The Trivy timeout must be between 30 and 7200 seconds." };
  }
  if (backend === "clair" && !/^https?:\/\/\S+$/.test(clairUrl)) return { error: "Clair needs an http(s) URL, e.g. http://clair:6060." };
  if (trivyServerUrl && !/^https?:\/\/\S+$/.test(trivyServerUrl)) return { error: "The Trivy server URL must be an http(s) URL, e.g. http://trivy:4954." };
  return { backend, clairUrl, trivyServerUrl, trivyTimeoutSeconds };
}

export async function saveScannerSettings(_prev: ScannerActionResult | null, fd: FormData): Promise<ScannerActionResult> {
  await requireAdmin();
  const parsed = settingsFromForm(fd);
  if ("error" in parsed) return { error: parsed.error };
  await saveSettingsSection("scanner", { ...parsed });
  await recordAudit({ action: "settings.update", targetType: "settings", targetId: "scanner", targetLabel: "scanner", details: { backend: parsed.backend } });
  revalidatePath("/admin/scanning");
  revalidatePath("/admin/health");
  revalidatePath("/admin/jobs");
  return {
    saved: true,
    message: parsed.backend === "off" ? "Scanning switched off; new pushes are not scanned" : `Scanner set to ${parsed.backend}; it applies to new scans`,
  };
}

/** Probe the backend described by the form values (unsaved) and report what it says. */
export async function testScannerSettings(_prev: ScannerActionResult | null, fd: FormData): Promise<ScannerActionResult> {
  await requireAdmin();
  const parsed = settingsFromForm(fd);
  if ("error" in parsed) return { error: parsed.error };
  if (parsed.backend === "off") return { error: "Pick a backend to test." };
  const scanner = scannerFromSettings(parsed);
  if (!scanner) return { error: "The backend is not configured." };
  try {
    const health = await Promise.race([
      scanner.health(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the test timed out after 20 s")), 20_000)),
    ]);
    return {
      saved: false,
      message: health.status === "error" ? undefined : `${scanner.label}: ${health.summary}`,
      error: health.status === "error" ? `${scanner.label}: ${health.summary}` : undefined,
      health: { ...health, backend: parsed.backend },
    };
  } catch (e) {
    return { error: `${scanner.label}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function resetScannerSettings(_prev: ScannerActionResult | null, _fd: FormData): Promise<ScannerActionResult> {
  await requireAdmin();
  await resetSettingsSection("scanner");
  await recordAudit({ action: "settings.reset", targetType: "settings", targetId: "scanner", targetLabel: "scanner" });
  revalidatePath("/admin/scanning");
  revalidatePath("/admin/health");
  return { saved: true, message: "Scanner settings reset to the environment defaults" };
}

/** Queue the scan-stale job with olderThan=0s: every tagged image is scanned again in the background. */
export async function rescanEverything(_prev: ScannerActionResult | null, _fd: FormData): Promise<ScannerActionResult> {
  const session = await requireAdmin();
  await recordAudit({ action: "scan.rescan_all", targetType: "job", targetId: "scan-stale", targetLabel: "scan-stale", details: { olderThan: "0s", limit: "500" } });
  after(async () => {
    await runJob("scan-stale", { olderThan: "0s", limit: "500" }, `user:${session.user.id}`).catch((err) =>
      console.error("re-scan everything failed:", err),
    );
  });
  revalidatePath("/admin/scanning");
  return { saved: true, message: "Re-scan queued: every tagged image is being scanned again in the background (up to 500 per run)" };
}
