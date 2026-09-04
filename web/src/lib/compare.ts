// Server side of the tag compare page: load the two images (resolving tags,
// picking a platform child out of multi-arch indexes), their configs and
// scan findings. The diffing itself is pure (lib/compare-shared.ts).
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { manifests, tags, vulnerabilityScans } from "@/db/schema";
import { fetchBlobJson } from "./registry-client";
import { imagePath } from "./library";
import { layersWithInstructions, normalizeFindings, type Finding, type ImageConfigView, type LayerInfo } from "./compare-shared";
import type { SeveritySummary } from "@/components/severity";

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
  platform?: { os?: string; architecture?: string; variant?: string };
}

interface ManifestPayload {
  config?: Descriptor;
  layers?: Descriptor[];
  manifests?: Descriptor[];
  annotations?: Record<string, string>;
}

export interface CompareScan {
  status: string;
  summary: SeveritySummary | null;
  findings: Finding[];
  updatedAt: Date;
}

export interface CompareSide {
  /** The reference as requested: a tag name or a digest. */
  ref: string;
  isTag: boolean;
  /** Digest of the multi-arch index the ref named, when it did. */
  indexDigest: string | null;
  /** Platforms the index offers (empty for a plain image). */
  platforms: string[];
  /** The image manifest actually compared. */
  digest: string;
  mediaType: string;
  platform: string | null;
  pushedAt: Date;
  /** `created` from the image config, when present. */
  created: string | null;
  layers: LayerInfo[];
  configSize: number;
  totalSize: number;
  config: ImageConfigView | null;
  annotations: Record<string, string>;
  scan: CompareScan | null;
}

function platformString(p: Descriptor["platform"]): string | null {
  if (!p?.os && !p?.architecture) return null;
  return `${p.os ?? "?"}/${p.architecture ?? "?"}${p.variant ? `/${p.variant}` : ""}`;
}

function parsePayload(payload: string): ManifestPayload {
  try {
    return JSON.parse(payload) as ManifestPayload;
  } catch {
    return {};
  }
}

/**
 * Normalised findings of a scan row: the `findings` column when present,
 * else the Clair `report` (lib/compare-shared.ts `normalizeFindings`).
 */
export function findingsOf(scan: { findings?: unknown; report?: unknown } | null | undefined): Finding[] {
  return normalizeFindings(scan);
}

async function scanFor(digest: string): Promise<CompareScan | null> {
  const row = await db.query.vulnerabilityScans.findFirst({ where: eq(vulnerabilityScans.digest, digest) });
  if (!row) return null;
  return {
    status: row.status,
    summary: (row.summary as SeveritySummary) ?? null,
    findings: row.status === "scanned" ? findingsOf(row as { findings?: unknown; report?: unknown }) : [],
    updatedAt: row.updatedAt,
  };
}

export type CompareLoadError = { error: string };

/**
 * Load one side of the comparison. `platform` picks the child of a
 * multi-arch index (`linux/arm64`); when absent the first child is used.
 * Returns an error message for unknown references.
 */
export async function loadCompareSide(
  repo: { id: string; orgSlug: string; name: string },
  ref: string,
  platform?: string | null,
): Promise<CompareSide | CompareLoadError> {
  const isTag = !ref.startsWith("sha256:");
  let digest = ref;
  if (isTag) {
    const row = await db.query.tags.findFirst({ where: and(eq(tags.repositoryId, repo.id), eq(tags.name, ref)) });
    if (!row) return { error: `Tag "${ref}" does not exist in this repository.` };
    digest = row.manifestDigest;
  }
  let manifest = await db.query.manifests.findFirst({ where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)) });
  if (!manifest) return { error: `Manifest ${digest.slice(0, 19)} does not exist in this repository.` };

  let payload = parsePayload(manifest.payload);
  let indexDigest: string | null = null;
  let platforms: string[] = [];
  let indexAnnotations: Record<string, string> = {};
  if (Array.isArray(payload.manifests)) {
    indexDigest = manifest.digest;
    indexAnnotations = payload.annotations ?? {};
    // Attestation manifests (unknown/unknown) are not images; leave them out.
    const children = payload.manifests.filter((c) => c.digest && platformString(c.platform) !== "unknown/unknown");
    platforms = children.map((c) => platformString(c.platform) ?? "unknown").filter((p, i, a) => a.indexOf(p) === i);
    const pick = (platform && children.find((c) => platformString(c.platform) === platform)) || children[0];
    if (!pick?.digest) return { error: `Index ${digest.slice(0, 19)} lists no platform images.` };
    const child = await db.query.manifests.findFirst({ where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, pick.digest)) });
    if (!child) return { error: `Platform image ${pick.digest.slice(0, 19)} of ${ref} is missing from the repository.` };
    manifest = child;
    payload = parsePayload(child.payload);
  }

  let config: ImageConfigView | null = (manifest.config as ImageConfigView) ?? null;
  if (!config && manifest.configDigest) {
    config = (await fetchBlobJson(imagePath(repo.orgSlug, repo.name), manifest.configDigest)) as ImageConfigView | null;
  }
  const layers = layersWithInstructions(payload.layers ?? [], config);
  const configSize = payload.config?.size ?? 0;
  return {
    ref,
    isTag,
    indexDigest,
    platforms,
    digest: manifest.digest,
    mediaType: manifest.mediaType,
    platform: config?.os || config?.architecture ? `${config?.os ?? "?"}/${config?.architecture ?? "?"}${config?.variant ? `/${config.variant}` : ""}` : null,
    pushedAt: manifest.createdAt,
    created: config?.created ?? null,
    layers,
    configSize,
    totalSize: layers.reduce((s, l) => s + l.size, 0) + configSize,
    config,
    annotations: { ...indexAnnotations, ...(payload.annotations ?? {}) },
    scan: await scanFor(manifest.digest),
  };
}
