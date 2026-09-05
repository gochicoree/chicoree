// Queue a vulnerability scan of one image on request (the tag page's
// "Scan again" button and POST /api/v1/…/scan). Says why when nothing
// happens — index, attestation, scan already running, scanning off — so the
// caller can report it instead of silently doing nothing. The caller has
// checked permissions (instance administrators only: re-scans cost the
// scanner real work).
import { and, eq } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/db";
import { manifests, vulnerabilityScans } from "@/db/schema";
import { recordAudit, type AuditActor } from "./audit";
import { isArtifactManifest, runScan, type ManifestPayload } from "./scan";
import { getScanner } from "./scanners";
import { scanInProgress } from "./scanner-shared";
import { imagePath } from "./library";

export interface RescanResult {
  /** True when a scan was queued; false with the reason otherwise. */
  queued: boolean;
  message: string;
}

export async function queueRescan(
  repo: { id: string; organizationId: string; name: string },
  orgSlug: string,
  digest: string,
  audit: { actor?: AuditActor; headers?: Headers | null; via?: string } = {},
): Promise<RescanResult> {
  if (!(await getScanner())) return { queued: false, message: "Scanning is off (Administration → Scanning)." };
  const manifest = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)),
    columns: { payload: true },
  });
  if (!manifest) return { queued: false, message: "This image does not exist (anymore)." };
  let payload: ManifestPayload = {};
  try {
    payload = JSON.parse(manifest.payload) as ManifestPayload;
  } catch {
    // treated as an image
  }
  if (Array.isArray(payload.manifests)) return { queued: false, message: "Multi-arch indexes are not scanned; their platform variants are." };
  if (isArtifactManifest(payload)) {
    return { queued: false, message: "Not scanned: this manifest carries no filesystem (an attestation, signature or SBOM)." };
  }

  // Someone can still submit while a scan runs (an old page, a double click);
  // queueing a second one would duplicate work.
  const current = await db.query.vulnerabilityScans.findFirst({ where: eq(vulnerabilityScans.digest, digest) });
  if (scanInProgress(current)) return { queued: false, message: "A scan of this image is already running." };

  const path = imagePath(orgSlug, repo.name);
  await recordAudit({
    action: "scan.request",
    actor: audit.actor,
    headers: audit.headers,
    organizationId: repo.organizationId,
    targetType: "manifest",
    targetId: digest,
    targetLabel: `${path}@${digest.slice(0, 19)}`,
    details: audit.via ? { via: audit.via } : undefined,
  });
  // Mark it pending right away so the page shows "scanning" on refresh and a
  // second request is refused until the scanner reports back.
  await db
    .insert(vulnerabilityScans)
    .values({ digest, repositoryId: repo.id, status: "pending", error: null, updatedAt: new Date() })
    .onConflictDoUpdate({ target: vulnerabilityScans.digest, set: { repositoryId: repo.id, status: "pending", error: null, updatedAt: new Date() } });
  after(async () => {
    await runScan(path, digest).catch((err) => console.error("rescan failed:", err));
  });
  return { queued: true, message: "Scan queued; the result appears when it finishes." };
}
