// Vulnerability scan orchestration: hand a pushed manifest to the configured
// scanner backend (Clair or Trivy, lib/scanners), store the normalised
// findings plus the raw report, keep the searchable scan_findings side table
// in step, and recompute pull blocks. Runs in the background (next/server
// `after`) so pushes are never slowed down.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { manifests, organization, repositories, scanFindings, vulnerabilityScans } from "@/db/schema";
import { env } from "./env";
import { fetchBlobJson } from "./registry-client";
import { systemPullToken } from "./registry-jwt";
import { manifestBlockReason, refreshRepositoryBlocks } from "./pull-policy";
import { splitImagePath } from "./library";
import { notify } from "./notify";
import { getScanner } from "./scanners";
import { findingsOf, reportKind } from "./scanners/normalize";
import { summarizeFindings, type Finding } from "./scanner-shared";
import { looksLikeArtifact } from "./signatures-shared";

interface ManifestDescriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
}

export interface ManifestPayload {
  mediaType?: string;
  config?: ManifestDescriptor;
  layers?: ManifestDescriptor[];
  manifests?: ManifestDescriptor[];
  subject?: ManifestDescriptor;
}

/**
 * Signatures, attestations, SBOMs and other attached artifacts carry no
 * filesystem: scanners choke on them ("bad block at 0"), so they are never
 * queued. Anything whose layers are all non-image media types counts too.
 */
export function isArtifactManifest(p: ManifestPayload): boolean {
  const layerTypes = (p.layers ?? []).map((l) => l.mediaType ?? "");
  if (looksLikeArtifact({ hasSubject: !!p.subject, tags: [], layerMediaTypes: layerTypes, configMediaType: p.config?.mediaType ?? null })) return true;
  return layerTypes.length > 0 && layerTypes.every((mt) => mt !== "" && !/image\.(layer|rootfs)/.test(mt));
}

async function resolveRepository(repositoryPath: string) {
  // Proxy caches use nested names (dockerhub/bitnami/redis): everything
  // after the organization is the repository.
  const target = splitImagePath(repositoryPath);
  if (!target) return null;
  const org = await db.query.organization.findFirst({ where: eq(organization.slug, target.orgSlug) });
  if (!org) return null;
  const repo = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, org.id), eq(repositories.name, target.repoName)),
  });
  return repo ?? null;
}

/** Cache the image config JSON on the manifest row (layer history, platform). */
export async function cacheManifestConfig(repositoryPath: string, digest: string): Promise<void> {
  const repo = await resolveRepository(repositoryPath);
  if (!repo) return;
  const row = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)),
  });
  if (!row?.configDigest || row.config) return;
  const config = await fetchBlobJson(repositoryPath, row.configDigest);
  if (config && typeof config === "object") {
    await db
      .update(manifests)
      .set({ config })
      .where(and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)));
  }
}

async function setScanState(
  digest: string,
  repositoryId: string | null,
  fields: Partial<typeof vulnerabilityScans.$inferInsert>,
): Promise<void> {
  await db
    .insert(vulnerabilityScans)
    .values({ digest, repositoryId, status: "pending", ...fields, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: vulnerabilityScans.digest,
      set: { ...fields, repositoryId, updatedAt: new Date() },
    });
}

/** Rewrite the scan_findings rows of one digest (deduplicated by id/package/version). */
export async function replaceScanFindings(digest: string, findings: Finding[]): Promise<number> {
  const seen = new Set<string>();
  const rows = findings
    .filter((f) => {
      const key = `${f.id}|${f.package}|${f.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((f) => ({
      digest,
      vulnerabilityId: f.id,
      package: f.package,
      version: f.version ?? "",
      fixedIn: f.fixedIn,
      severity: f.severity,
      type: f.type || "os",
    }));
  await db.transaction(async (tx) => {
    await tx.delete(scanFindings).where(eq(scanFindings.digest, digest));
    for (let i = 0; i < rows.length; i += 500) await tx.insert(scanFindings).values(rows.slice(i, i + 500));
  });
  return rows.length;
}

/** Persist a finished scan: findings, summary, raw report, scanner label, side table. */
export async function storeScanResult(
  digest: string,
  repositoryId: string | null,
  result: { scanner: string; scannerVersion: string | null; findings: Finding[]; raw: unknown },
): Promise<void> {
  await setScanState(digest, repositoryId, {
    status: "scanned",
    findings: result.findings,
    summary: summarizeFindings(result.findings),
    report: result.raw,
    scanner: result.scanner,
    scannerVersion: result.scannerVersion,
    error: null,
  });
  await replaceScanFindings(digest, result.findings);
}

/**
 * Findings of a scan row. Rows written before the findings column existed
 * carry only Clair's raw report: those are normalised here and written back
 * (with the side table) so the next read and the CVE search see them.
 */
export async function ensureFindings(scan: {
  digest: string;
  findings: unknown;
  report: unknown;
  scanner: string | null;
}): Promise<Finding[]> {
  const { findings, normalised } = findingsOf(scan);
  if (normalised && scan.report) {
    const kind = scan.scanner ?? reportKind(scan.report);
    await db
      .update(vulnerabilityScans)
      .set({ findings, summary: summarizeFindings(findings), scanner: kind })
      .where(eq(vulnerabilityScans.digest, scan.digest))
      .catch((err) => console.error("scan normalisation write-back failed:", err));
    await replaceScanFindings(scan.digest, findings).catch((err) => console.error("scan_findings backfill failed:", err));
  }
  return findings;
}

/**
 * One-off backfill for the scan-normalize job: normalise legacy rows and
 * (re)build scan_findings for rows that have findings but no side rows.
 */
export async function normalizeLegacyScans(limit = 200): Promise<{ normalised: number; indexed: number; remaining: number }> {
  let normalised = 0;
  let indexed = 0;
  const legacy = await db.execute(sql`
    SELECT digest, findings, report, scanner FROM vulnerability_scans
    WHERE findings IS NULL AND report IS NOT NULL AND status = 'scanned'
    ORDER BY updated_at DESC LIMIT ${limit}`);
  for (const r of legacy.rows) {
    await ensureFindings({ digest: r.digest as string, findings: r.findings, report: r.report, scanner: (r.scanner as string | null) ?? null });
    normalised++;
  }
  const missing = await db.execute(sql`
    SELECT vs.digest, vs.findings FROM vulnerability_scans vs
    WHERE vs.findings IS NOT NULL AND jsonb_typeof(vs.findings) = 'array' AND jsonb_array_length(vs.findings) > 0
      AND NOT EXISTS (SELECT 1 FROM scan_findings sf WHERE sf.digest = vs.digest)
    ORDER BY vs.updated_at DESC LIMIT ${limit}`);
  for (const r of missing.rows) {
    await replaceScanFindings(r.digest as string, r.findings as Finding[]);
    indexed++;
  }
  const rest = await db.execute(sql`
    SELECT count(*)::int AS n FROM vulnerability_scans WHERE findings IS NULL AND report IS NOT NULL AND status = 'scanned'`);
  return { normalised, indexed, remaining: Number(rest.rows[0]?.n ?? 0) };
}

/**
 * Run a full scan for one image manifest with the configured backend. Index
 * manifests (multi-arch) are skipped — their children are scanned
 * individually when pushed.
 */
export async function runScan(repositoryPath: string, digest: string): Promise<void> {
  const scanner = await getScanner();
  if (!scanner) return;
  const repo = await resolveRepository(repositoryPath);
  if (!repo) return;

  const row = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)),
  });
  if (!row) return;

  let payload: ManifestPayload;
  try {
    payload = JSON.parse(row.payload) as ManifestPayload;
  } catch {
    return;
  }
  if (payload.manifests) return; // index: children are scanned on their own
  const layers = (payload.layers ?? []).filter((l): l is ManifestDescriptor & { digest: string } => !!l.digest);
  if (layers.length === 0) return;
  if (isArtifactManifest(payload)) {
    // Drop the failure an older build may have recorded for this artifact.
    await db.delete(vulnerabilityScans).where(and(eq(vulnerabilityScans.digest, digest), eq(vulnerabilityScans.status, "failed")));
    return;
  }

  try {
    await setScanState(digest, repo.id, { status: "indexing", error: null, scanner: scanner.name });

    // The backend reads the image straight from the registry with a pull token.
    const token = await systemPullToken(repositoryPath, 2 * 3600);
    const result = await scanner.scan({
      repositoryPath,
      digest,
      manifest: payload as { mediaType?: string; config?: { digest: string }; layers?: { digest: string }[] },
      layers: layers.map((l) => ({ digest: l.digest, size: l.size, mediaType: l.mediaType })),
      registryUrl: env.registryInternalUrl,
      token,
    });
    await storeScanResult(digest, repo.id, {
      scanner: scanner.name,
      scannerVersion: result.scannerVersion,
      findings: result.findings,
      raw: result.raw,
    });
    await refreshRepositoryBlocks(repo.id).catch((err) => console.error("pull policy refresh failed:", err));
    const blockedReason = await manifestBlockReason(repo.id, digest).catch(() => null);
    await notify({
      event: "scan.completed",
      repositoryId: repo.id,
      digest,
      summary: result.summary,
      blockedReason,
      scanner: scanner.label,
    }).catch((err) => console.error("scan.completed notification failed:", err));
  } catch (err) {
    await setScanState(digest, repo.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface RecentScan {
  digest: string;
  status: string;
  scanner: string | null;
  scannerVersion: string | null;
  summary: Record<string, number> | null;
  error: string | null;
  updatedAt: Date;
  orgSlug: string | null;
  repoName: string | null;
  tags: string[];
}

/** The last N scans with the repository they were run for, for Administration → Scanning. */
export async function recentScans(limit = 10): Promise<RecentScan[]> {
  const { rows } = await db.execute(sql`
    SELECT vs.digest, vs.status, vs.scanner, vs.scanner_version, vs.summary, vs.error, vs.updated_at,
           o.slug AS org_slug, r.name AS repo_name,
           (SELECT string_agg(t.name, ',' ORDER BY t.name) FROM tags t WHERE t.repository_id = vs.repository_id AND t.manifest_digest = vs.digest) AS tags
    FROM vulnerability_scans vs
    LEFT JOIN repositories r ON r.id = vs.repository_id
    LEFT JOIN organization o ON o.id = r.organization_id
    ORDER BY vs.updated_at DESC LIMIT ${limit}`);
  return rows.map((r) => ({
    digest: r.digest as string,
    status: r.status as string,
    scanner: (r.scanner as string | null) ?? null,
    scannerVersion: (r.scanner_version as string | null) ?? null,
    summary: (r.summary as Record<string, number> | null) ?? null,
    error: (r.error as string | null) ?? null,
    updatedAt: new Date(r.updated_at as string),
    orgSlug: (r.org_slug as string | null) ?? null,
    repoName: (r.repo_name as string | null) ?? null,
    tags: r.tags ? String(r.tags).split(",") : [],
  }));
}

export async function scanCounts(): Promise<{ pending: number; indexing: number; scanned: number; failed: number; legacy: number }> {
  const { rows } = await db.execute(sql`
    SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
           count(*) FILTER (WHERE status = 'indexing')::int AS indexing,
           count(*) FILTER (WHERE status = 'scanned')::int AS scanned,
           count(*) FILTER (WHERE status = 'failed')::int AS failed,
           count(*) FILTER (WHERE status = 'scanned' AND findings IS NULL AND report IS NOT NULL)::int AS legacy
    FROM vulnerability_scans`);
  const r = rows[0];
  return { pending: Number(r.pending), indexing: Number(r.indexing), scanned: Number(r.scanned), failed: Number(r.failed), legacy: Number(r.legacy) };
}
