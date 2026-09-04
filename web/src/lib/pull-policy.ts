// Vulnerability pull policy: an organization-wide severity threshold with a
// per-repository override. Images whose scan has findings at or above the
// threshold are recorded in manifest_blocks, which registryd consults on
// every manifest pull (its own service reads excepted).
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { manifestBlocks, manifests, organizationSettings, repositories, vulnerabilityExceptions, vulnerabilityScans } from "@/db/schema";
import type { SeveritySummary } from "@/components/severity";
import { effectivePolicy, violation } from "./pull-policy-shared";
import { notify } from "./notify";
import { effectiveSummary, type ExceptionRule } from "./scanner-shared";
import { findingsOf } from "./scanners/normalize";

export * from "./pull-policy-shared";

/**
 * The exceptions that can apply to a repository: the organization-wide ones
 * plus its own. Expired rows are returned too; the pure helpers ignore them.
 */
export async function loadExceptionRules(organizationId: string, repositoryId: string | null): Promise<(typeof vulnerabilityExceptions.$inferSelect)[]> {
  return db.query.vulnerabilityExceptions.findMany({
    where: and(
      eq(vulnerabilityExceptions.organizationId, organizationId),
      repositoryId
        ? or(isNull(vulnerabilityExceptions.repositoryId), eq(vulnerabilityExceptions.repositoryId, repositoryId))
        : isNull(vulnerabilityExceptions.repositoryId),
    ),
  });
}

/**
 * The severity counts the pull policy judges: the scan's findings minus
 * whatever the exceptions accept. Rows without findings or report (never
 * normalised) fall back to their stored summary.
 */
export function effectiveScanSummary(
  scan: { findings: unknown; report: unknown; scanner: string | null; summary: unknown },
  rules: ExceptionRule[],
  repositoryId: string | null,
): SeveritySummary | null {
  const { findings } = findingsOf(scan);
  if (findings.length === 0 && !Array.isArray(scan.findings) && !scan.report) return (scan.summary as SeveritySummary | null) ?? null;
  return effectiveSummary(findings, rules, repositoryId);
}

/**
 * Recompute manifest_blocks for one repository from its scans and policy.
 * Index manifests are blocked when any of their platform variants is.
 */
export async function refreshRepositoryBlocks(repositoryId: string): Promise<{ blocked: number }> {
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { blocked: 0 };
  const org = await db.query.organizationSettings.findFirst({
    where: eq(organizationSettings.organizationId, repo.organizationId),
  });
  const policy = effectivePolicy(org, repo);

  const rows = await db
    .select({ digest: manifests.digest, mediaType: manifests.mediaType, payload: manifests.payload })
    .from(manifests)
    .where(eq(manifests.repositoryId, repositoryId));
  const blocked = new Map<string, string>();

  if (policy.level && rows.length > 0) {
    const scans = await db.query.vulnerabilityScans.findMany({
      where: inArray(
        vulnerabilityScans.digest,
        rows.map((r) => r.digest),
      ),
    });
    const byDigest = new Map(scans.map((s) => [s.digest, s]));
    const rules = await loadExceptionRules(repo.organizationId, repositoryId);
    for (const r of rows) {
      const scan = byDigest.get(r.digest);
      if (scan?.status !== "scanned") continue; // only definitive results block
      // Accepted risks (vulnerability_exceptions) never count against the policy.
      const why = violation(effectiveScanSummary(scan, rules, repositoryId), policy);
      if (why) blocked.set(r.digest, why);
    }
    for (const r of rows) {
      if (!/index|list/.test(r.mediaType)) continue;
      let children: string[] = [];
      try {
        const parsed = JSON.parse(r.payload) as { manifests?: { digest?: string }[] };
        children = (parsed.manifests ?? []).map((m) => m.digest ?? "").filter(Boolean);
      } catch {
        continue;
      }
      const hit = children.find((d) => blocked.has(d));
      if (hit) blocked.set(r.digest, `variant ${hit.slice(7, 19)}: ${blocked.get(hit)}`);
    }
  }

  const existing = await db.query.manifestBlocks.findMany({ where: eq(manifestBlocks.repositoryId, repositoryId) });
  const current = new Map(existing.map((e) => [e.digest, e.reason]));
  const newlyBlocked: { digest: string; reason: string }[] = [];
  for (const [digest, reason] of blocked) {
    if (current.get(digest) === reason) continue;
    if (!current.has(digest)) newlyBlocked.push({ digest, reason });
    await db
      .insert(manifestBlocks)
      .values({ repositoryId, digest, reason })
      .onConflictDoUpdate({ target: [manifestBlocks.repositoryId, manifestBlocks.digest], set: { reason } });
  }
  for (const e of existing) {
    if (!blocked.has(e.digest)) {
      await db
        .delete(manifestBlocks)
        .where(and(eq(manifestBlocks.repositoryId, repositoryId), eq(manifestBlocks.digest, e.digest)));
    }
  }
  if (newlyBlocked.length > 0) {
    await notify({ event: "scan.blocked", repositoryId, blocked: newlyBlocked }).catch((err) =>
      console.error("scan.blocked notification failed:", err),
    );
  }
  return { blocked: blocked.size };
}

/** Recompute every repository of an organization (after its policy changed). */
export async function refreshOrganizationBlocks(organizationId: string): Promise<void> {
  const repos = await db.query.repositories.findMany({ where: eq(repositories.organizationId, organizationId) });
  for (const r of repos) await refreshRepositoryBlocks(r.id);
}

/** The block reason for one manifest, if any. */
export async function manifestBlockReason(repositoryId: string, digest: string): Promise<string | null> {
  const row = await db.query.manifestBlocks.findFirst({
    where: and(eq(manifestBlocks.repositoryId, repositoryId), eq(manifestBlocks.digest, digest)),
  });
  return row?.reason ?? null;
}
