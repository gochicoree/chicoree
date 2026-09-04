// Moving or copying a single image between repositories — including across
// organizations. Blob content is content-addressed and already stored, so
// nothing is re-uploaded: every layer is linked into the destination with the
// OCI cross-repository blob mount and the manifests are PUT back through
// registryd with a system-signed token. Going through the registry (rather
// than writing manifest rows by hand) reuses its validation, quota
// enforcement, immutable-tag guard, event log, webhooks and scan triggers.
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { manifests, tags as tagsTable } from "@/db/schema";
import { env } from "./env";
import { LocalPusher } from "./mirror";
import { openBlobStream, registryErrorMessage } from "./registry-client";
import { signRegistryToken } from "./registry-jwt";
import { discoverArtifacts } from "./signatures";

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
}

/** One manifest to push, with the exact bytes it was stored under. */
export interface PlannedManifest {
  digest: string;
  mediaType: string;
  payload: string;
  /** Extra reference to publish it under (the cosign `sha256-<hex>.sig` tag). */
  tag: string | null;
  /** An attached artifact (signature, attestation, SBOM) rather than the image itself. */
  artifact: boolean;
}

export interface CopyPlan {
  /** The image the destination tag will point at. */
  rootDigest: string;
  /** Child manifests first, the image itself last, then its artifacts. */
  manifests: PlannedManifest[];
  /** Every blob the plan references; mounted into the destination first. */
  blobs: string[];
  /** Image manifests (index + platform variants), for reporting. */
  imageDigests: string[];
  /** How many attached artifacts travel along. */
  artifactCount: number;
}

function parseManifest(payload: string): { config?: Descriptor; layers?: Descriptor[]; manifests?: Descriptor[] } {
  try {
    return JSON.parse(payload) as { config?: Descriptor; layers?: Descriptor[]; manifests?: Descriptor[] };
  } catch {
    return {};
  }
}

/** Blob digests a single manifest references directly (config + non-foreign layers). */
function blobsOf(payload: string): string[] {
  const parsed = parseManifest(payload);
  return [parsed.config, ...(parsed.layers ?? [])]
    .filter((d): d is Descriptor => !!d?.digest)
    .filter((d) => !(d.mediaType && /foreign|nondistributable/.test(d.mediaType)))
    .map((d) => d.digest!);
}

/** Child manifest digests of an index (empty for a plain image manifest). */
function childrenOf(payload: string): string[] {
  const parsed = parseManifest(payload);
  return Array.isArray(parsed.manifests) ? parsed.manifests.map((m) => m.digest).filter((d): d is string => !!d) : [];
}

type ManifestRow = { digest: string; mediaType: string; payload: string };

async function loadManifests(repositoryId: string, digests: string[]): Promise<Map<string, ManifestRow>> {
  if (digests.length === 0) return new Map();
  const rows = await db
    .select({ digest: manifests.digest, mediaType: manifests.mediaType, payload: manifests.payload })
    .from(manifests)
    .where(and(eq(manifests.repositoryId, repositoryId), inArray(manifests.digest, digests)));
  return new Map(rows.map((r) => [r.digest, r]));
}

/**
 * Everything that has to reach the destination for `rootDigest`: the image
 * (an index brings its platform variants), every blob they reference and —
 * unless `includeArtifacts` is false — the cosign signatures, attestations
 * and SBOMs attached to any of them.
 */
export async function planImageCopy(
  sourceRepositoryId: string,
  rootDigest: string,
  opts: { includeArtifacts?: boolean } = {},
): Promise<CopyPlan> {
  const ordered: PlannedManifest[] = [];
  const blobs = new Set<string>();
  const seen = new Set<string>();
  const imageDigests: string[] = [];

  // Depth-first over the index tree: children are pushed before their parent,
  // which is what registryd's manifest validation requires.
  async function walk(digest: string, artifact: boolean, tag: string | null): Promise<void> {
    if (seen.has(digest)) return;
    seen.add(digest);
    const row = (await loadManifests(sourceRepositoryId, [digest])).get(digest);
    if (!row) throw new Error(`Manifest ${digest.slice(0, 19)} is not in the source repository.`);
    for (const child of childrenOf(row.payload)) await walk(child, artifact, null);
    for (const b of blobsOf(row.payload)) blobs.add(b);
    ordered.push({ digest, mediaType: row.mediaType, payload: row.payload, tag, artifact });
    if (!artifact) imageDigests.push(digest);
  }

  await walk(rootDigest, false, null);

  let artifactCount = 0;
  if (opts.includeArtifacts !== false) {
    const attached = await discoverArtifacts(sourceRepositoryId, imageDigests);
    for (const a of attached) {
      if (seen.has(a.digest)) continue;
      await walk(a.digest, true, a.tag);
      artifactCount++;
    }
  }
  return { rootDigest, manifests: ordered, blobs: [...blobs], imageDigests, artifactCount };
}

export interface CopyOutcome {
  /** Blobs linked into the destination (none of them re-uploaded when mounts work). */
  mounted: number;
  /** Blobs whose cross-repository mount was refused and had to be streamed. */
  uploaded: number;
  manifestsPushed: number;
  artifactsCopied: number;
}

/**
 * Push a plan into `destinationPath` under `destinationTag`. `sourcePath` is
 * only used as the mount source, so the caller must hold pull rights there.
 */
export async function executeImageCopy(
  plan: CopyPlan,
  opts: { sourcePath: string; destinationPath: string; destinationTag: string; subject: string },
): Promise<CopyOutcome> {
  const { sourcePath, destinationPath, destinationTag, subject } = opts;
  const { token } = await signRegistryToken(
    subject,
    [
      { type: "repository", name: sourcePath, actions: ["pull"] },
      { type: "repository", name: destinationPath, actions: ["pull", "push"] },
    ],
    3600,
  );
  const pusher = new LocalPusher(destinationPath, token);
  const outcome: CopyOutcome = { mounted: 0, uploaded: 0, manifestsPushed: 0, artifactsCopied: 0 };

  for (const digest of plan.blobs) {
    const mounted = await mountBlob(destinationPath, sourcePath, digest, token);
    if (mounted) {
      outcome.mounted++;
      continue;
    }
    // The mount was refused (a registry that does not implement it, or a link
    // that vanished). Stream the bytes instead so the copy still completes.
    const source = await openBlobStream(sourcePath, digest);
    if (!source?.body) throw new Error(`Layer ${digest.slice(0, 19)} could not be read from ${sourcePath}.`);
    const size = Number(source.headers.get("content-length") ?? 0) || null;
    await pusher.putBlob(digest, source.body, size);
    outcome.uploaded++;
  }

  for (const m of plan.manifests) {
    // Children and artifacts go in by digest; the image itself gets the tag.
    const reference = m.digest === plan.rootDigest ? destinationTag : (m.tag ?? m.digest);
    await putManifest(destinationPath, reference, m, token);
    outcome.manifestsPushed++;
    if (m.artifact) outcome.artifactsCopied++;
  }
  return outcome;
}

/** POST /v2/<dest>/blobs/uploads/?mount=&from= — 201 means the blob was linked without any upload. */
async function mountBlob(destinationPath: string, sourcePath: string, digest: string, token: string): Promise<boolean> {
  const url = `${env.registryInternalUrl}/v2/${destinationPath}/blobs/uploads/?mount=${encodeURIComponent(digest)}&from=${encodeURIComponent(sourcePath)}`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (res.status === 201) return true;
  if (res.status === 202) return false; // fell through to a regular upload session
  throw new Error(`Layer ${digest.slice(0, 19)}: ${await registryErrorMessage(res)}`);
}

async function putManifest(destinationPath: string, reference: string, m: PlannedManifest, token: string): Promise<void> {
  const res = await fetch(`${env.registryInternalUrl}/v2/${destinationPath}/manifests/${encodeURIComponent(reference)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": m.mediaType },
    body: m.payload,
    cache: "no-store",
  });
  if (res.status !== 201) {
    const what = m.artifact ? `attached artifact ${m.digest.slice(0, 19)}` : `manifest ${reference}`;
    throw new Error(`Pushing ${what} to ${destinationPath} failed: ${await registryErrorMessage(res)}`);
  }
}

/** The digest a tag points at in a repository, or null. */
export async function tagDigest(repositoryId: string, tag: string): Promise<string | null> {
  const row = await db.query.tags.findFirst({
    where: and(eq(tagsTable.repositoryId, repositoryId), eq(tagsTable.name, tag)),
    columns: { manifestDigest: true },
  });
  return row?.manifestDigest ?? null;
}
