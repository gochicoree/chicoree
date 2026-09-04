// Vulnerability pull policy: an organization-wide severity threshold with a
// per-repository override. Images whose scan has findings at or above the
// threshold are recorded in manifest_blocks, which registryd consults on
// every manifest pull (its own service reads excepted).
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { manifestBlocks, manifestSignatures, manifests, organizationSettings, repositories, tags, vulnerabilityExceptions, vulnerabilityScans } from "@/db/schema";
import type { SeveritySummary } from "@/components/severity";
import { effectivePolicy, effectiveSignaturePolicy, violation } from "./pull-policy-shared";
import { notify } from "./notify";
import { effectiveSummary, type ExceptionRule } from "./scanner-shared";
import { findingsOf } from "./scanners/normalize";
import { looksLikeArtifact, SIGNATURE_BLOCK_REASON } from "./signatures-shared";

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
 * Recompute manifest_blocks for one repository from its scans and policies.
 * Index manifests are blocked when any of their platform variants is. When
 * the signature policy applies, every image without a cosign signature
 * verified by a trusted key is blocked too (attached artifacts never are;
 * variants of a verified index inherit its signature). Both reasons can
 * apply to one image; the reason text names each. `quiet` skips the
 * signature.blocked notification (pushes: the signature usually follows the
 * image within seconds).
 */
export async function refreshRepositoryBlocks(repositoryId: string, opts: { quiet?: boolean } = {}): Promise<{ blocked: number }> {
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { blocked: 0 };
  const org = await db.query.organizationSettings.findFirst({
    where: eq(organizationSettings.organizationId, repo.organizationId),
  });
  const policy = effectivePolicy(org, repo);

  const rows = await db
    .select({ digest: manifests.digest, mediaType: manifests.mediaType, payload: manifests.payload, subjectDigest: manifests.subjectDigest })
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

  // Signature policy: images (not attached artifacts) without a verified signature.
  const unsigned = new Set<string>();
  if (rows.length > 0 && effectiveSignaturePolicy(org, repo)) {
    const tagRows = await db.select({ name: tags.name, digest: tags.manifestDigest }).from(tags).where(eq(tags.repositoryId, repositoryId));
    const tagsByDigest = new Map<string, string[]>();
    for (const t of tagRows) tagsByDigest.set(t.digest, [...(tagsByDigest.get(t.digest) ?? []), t.name]);
    const verifiedRows = await db
      .select({ digest: manifestSignatures.manifestDigest })
      .from(manifestSignatures)
      .where(
        and(eq(manifestSignatures.repositoryId, repositoryId), eq(manifestSignatures.kind, "signature"), eq(manifestSignatures.status, "verified")),
      );
    const verified = new Set(verifiedRows.map((v) => v.digest));
    const parsedRows = rows.map((r) => {
      let parsed: { config?: { mediaType?: string }; layers?: { mediaType?: string }[]; manifests?: { digest?: string }[] } = {};
      try {
        parsed = JSON.parse(r.payload);
      } catch {
        // unparsable payloads are treated as images
      }
      return { ...r, parsed: parsed ?? {} };
    });
    const coveredByIndex = new Set<string>();
    for (const r of parsedRows) {
      if (!/index|list/.test(r.mediaType) || !verified.has(r.digest)) continue;
      for (const c of r.parsed.manifests ?? []) if (c.digest) coveredByIndex.add(c.digest);
    }
    for (const r of parsedRows) {
      const artifact = looksLikeArtifact({
        hasSubject: !!r.subjectDigest,
        tags: tagsByDigest.get(r.digest) ?? [],
        layerMediaTypes: (r.parsed.layers ?? []).map((l) => l.mediaType ?? ""),
        configMediaType: r.parsed.config?.mediaType ?? null,
      });
      if (artifact || verified.has(r.digest) || coveredByIndex.has(r.digest)) continue;
      unsigned.add(r.digest);
    }
  }
  const final = new Map<string, string>(blocked);
  for (const digest of unsigned) {
    final.set(digest, final.has(digest) ? `${final.get(digest)}; ${SIGNATURE_BLOCK_REASON}` : SIGNATURE_BLOCK_REASON);
  }

  const existing = await db.query.manifestBlocks.findMany({ where: eq(manifestBlocks.repositoryId, repositoryId) });
  const current = new Map(existing.map((e) => [e.digest, `${e.pushersExempt ? "1" : "0"}${e.reason}`]));
  const newlyBlocked: { digest: string; reason: string }[] = [];
  for (const [digest, reason] of final) {
    // Only a pure signature block lets pushers (the signers) still read the image.
    const pushersExempt = unsigned.has(digest) && !blocked.has(digest);
    if (current.get(digest) === `${pushersExempt ? "1" : "0"}${reason}`) continue;
    if (!current.has(digest)) newlyBlocked.push({ digest, reason });
    await db
      .insert(manifestBlocks)
      .values({ repositoryId, digest, reason, pushersExempt })
      .onConflictDoUpdate({ target: [manifestBlocks.repositoryId, manifestBlocks.digest], set: { reason, pushersExempt } });
  }
  for (const e of existing) {
    if (!final.has(e.digest)) {
      await db
        .delete(manifestBlocks)
        .where(and(eq(manifestBlocks.repositoryId, repositoryId), eq(manifestBlocks.digest, e.digest)));
    }
  }
  const byScan = newlyBlocked.filter((b) => blocked.has(b.digest));
  const bySignature = newlyBlocked.filter((b) => !blocked.has(b.digest));
  if (byScan.length > 0) {
    await notify({ event: "scan.blocked", repositoryId, blocked: byScan }).catch((err) =>
      console.error("scan.blocked notification failed:", err),
    );
  }
  if (bySignature.length > 0 && !opts.quiet) {
    await notify({ event: "signature.blocked", repositoryId, blocked: bySignature }).catch((err) =>
      console.error("signature.blocked notification failed:", err),
    );
  }
  return { blocked: final.size };
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
