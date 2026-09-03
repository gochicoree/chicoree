// Vulnerability scan orchestration: submit a pushed manifest's layers to
// Clair, wait for indexing, store the matcher's report. Runs in the
// background (via next/server `after`) so pushes are never slowed down.
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { manifests, organization, repositories, vulnerabilityScans } from "@/db/schema";
import { getIndexReport, getVulnerabilityReport, submitIndex, summarizeReport, type ClairLayer } from "./clair";
import { env } from "./env";
import { fetchBlobJson } from "./registry-client";
import { systemPullToken } from "./registry-jwt";
import { manifestBlockReason, refreshRepositoryBlocks } from "./pull-policy";
import { splitImagePath } from "./library";
import { notify } from "./notify";

interface ManifestDescriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
}

interface ManifestPayload {
  mediaType?: string;
  config?: ManifestDescriptor;
  layers?: ManifestDescriptor[];
  manifests?: ManifestDescriptor[];
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a full scan for one image manifest. Index manifests (multi-arch) are
 * skipped — their children are scanned individually when pushed.
 */
export async function runScan(repositoryPath: string, digest: string): Promise<void> {
  if (!env.clairEnabled) return;
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
  const layers = (payload.layers ?? []).filter((l) => l.digest);
  if (layers.length === 0) return;

  try {
    await setScanState(digest, repo.id, { status: "indexing", error: null });

    // Clair fetches layers straight from the registry with a pull token.
    const token = await systemPullToken(repositoryPath, 2 * 3600);
    const clairLayers: ClairLayer[] = layers.map((l) => ({
      hash: l.digest!,
      uri: `${env.registryInternalUrl}/v2/${repositoryPath}/blobs/${l.digest}`,
      headers: { Authorization: [`Bearer ${token}`] },
    }));

    let report = await submitIndex(digest, clairLayers);
    const deadline = Date.now() + 180_000;
    while (report.state !== "IndexFinished" && report.state !== "IndexError") {
      if (Date.now() > deadline) throw new Error("timed out waiting for Clair indexing");
      await sleep(3000);
      report = (await getIndexReport(digest)) ?? report;
    }
    if (report.state === "IndexError") {
      throw new Error(`Clair indexing failed: ${report.err ?? "unknown error"}`);
    }

    const vulnReport = await getVulnerabilityReport(digest);
    if (!vulnReport) throw new Error("Clair produced no vulnerability report");
    await setScanState(digest, repo.id, {
      status: "scanned",
      report: vulnReport,
      summary: summarizeReport(vulnReport),
      error: null,
    });
    await refreshRepositoryBlocks(repo.id).catch((err) => console.error("pull policy refresh failed:", err));
    const blockedReason = await manifestBlockReason(repo.id, digest).catch(() => null);
    await notify({
      event: "scan.completed",
      repositoryId: repo.id,
      digest,
      summary: summarizeReport(vulnReport),
      blockedReason,
    }).catch((err) => console.error("scan.completed notification failed:", err));
  } catch (err) {
    await setScanState(digest, repo.id, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
