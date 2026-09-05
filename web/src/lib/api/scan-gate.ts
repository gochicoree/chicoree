// The scan gate: the current scan of an image, optionally waited for, judged
// against a severity threshold — what a pipeline calls to decide whether an
// image may ship. `passed` is null while nothing can be judged (never
// scanned, still running after the wait, scan failed).
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { vulnerabilityScans } from "@/db/schema";
import { getManifestWithScan } from "@/lib/data";
import { effectiveScanSummary, loadExceptionRules } from "@/lib/pull-policy";
import { LEVELS, violation, type Level } from "@/lib/pull-policy-shared";
import { scanInProgress } from "@/lib/scanner-shared";
import { scanningEnabled } from "@/lib/scanners";
import type { SeveritySummary } from "@/components/severity";
import type { RepoAccess } from "./access";
import { badRequest, iso, notFound } from "./respond";
import { compactSummary, scanJson } from "./serialize";

export const MAX_WAIT_SECONDS = 300;

export interface GateOptions {
  /** Seconds to wait for a running scan (0 = answer at once). */
  waitSeconds: number;
  /** Fail when findings at this severity or above remain after accepted risks; null = report only. */
  failOn: Level | null;
  /** Count unrated findings as failures too. */
  unrated: boolean;
}

/** `?wait=120&fail_on=high&unrated=true` → options, with the caps applied. */
export function gateOptions(url: URL): GateOptions {
  const waitRaw = Math.trunc(Number(url.searchParams.get("wait") ?? 0));
  const waitSeconds = Number.isFinite(waitRaw) && waitRaw > 0 ? Math.min(waitRaw, MAX_WAIT_SECONDS) : 0;
  const failRaw = (url.searchParams.get("fail_on") ?? "").trim().toLowerCase();
  if (failRaw && !(LEVELS as string[]).includes(failRaw)) throw badRequest(`"fail_on" must be one of ${LEVELS.join(", ")}.`);
  const unratedRaw = (url.searchParams.get("unrated") ?? "").trim().toLowerCase();
  return { waitSeconds, failOn: (failRaw as Level) || null, unrated: /^(1|true|yes|on)$/.test(unratedRaw) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function scanGate(a: RepoAccess, digest: string, opts: GateOptions) {
  const found = await getManifestWithScan(a.repo.id, digest);
  if (!found) throw notFound("No such image in this repository.");
  const isIndex = /index|list/.test(found.manifest.mediaType);
  let scan = found.scan;

  // Wait for a running scan, polling the row every two seconds.
  const deadline = Date.now() + opts.waitSeconds * 1000;
  while (scan && scanInProgress(scan) && Date.now() < deadline) {
    await sleep(Math.min(2000, Math.max(200, deadline - Date.now())));
    scan = (await db.query.vulnerabilityScans.findFirst({ where: eq(vulnerabilityScans.digest, digest) })) ?? null;
  }

  const rules = await loadExceptionRules(a.org.id, a.repo.id);
  const effective = scan && scan.status === "scanned" ? effectiveScanSummary(scan, rules, a.repo.id) : null;
  const policy = opts.failOn ? { level: opts.failOn, unrated: opts.unrated } : null;
  const reason = policy && effective ? violation(effective, policy) : null;
  let passed: boolean | null = null;
  let note: string | null = null;
  if (isIndex) note = "Indexes are not scanned; gate one of the platform variants.";
  else if (!scan) note = (await scanningEnabled()) ? "This image has not been scanned yet." : "Scanning is switched off on this registry.";
  else if (scanInProgress(scan)) note = opts.waitSeconds > 0 ? `The scan was still running after ${opts.waitSeconds} s.` : "A scan is running; add ?wait= to wait for it.";
  else if (scan.status === "failed") note = `The last scan failed${scan.error ? `: ${scan.error}` : "."}`;
  else if (scan.status === "scanned") passed = policy ? reason === null : null;

  return {
    digest,
    isIndex,
    scan: scan ? scanJson(scan, effective) : null,
    summary: compactSummary((scan?.summary as SeveritySummary | null) ?? null),
    effectiveSummary: compactSummary(effective),
    threshold: policy ? { failOn: policy.level, unrated: policy.unrated } : null,
    /** Null when no threshold was given or the scan cannot be judged. */
    passed,
    violation: reason,
    note,
    checkedAt: iso(new Date()),
  };
}
