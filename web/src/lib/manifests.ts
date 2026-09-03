// Manifest-level helpers: the untagged-manifest browser and deletion by
// digest through the registry (so events and garbage collection stay
// consistent), guarded by tag rules and index membership.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { manifests, organization, repositories } from "@/db/schema";
import { env } from "./env";
import { imagePath } from "./library";
import { registryErrorMessage } from "./registry-client";
import { signRegistryToken } from "./registry-jwt";
import { effectiveTagRules, protectedReason } from "./tag-rules";

export interface UntaggedManifest {
  digest: string;
  mediaType: string;
  artifactType: string | null;
  isIndex: boolean;
  /** Size of the manifest document itself. */
  size: number;
  /** Bytes of the blobs it references (null for indexes). */
  contentBytes: number | null;
  /** "linux/arm64" from the cached image config, when known. */
  platform: string | null;
  pushedAt: Date;
  pushedBy: string | null;
  /** Referenced by a multi-arch index that still exists. */
  isChild: boolean;
  /** Attached to another manifest that still exists (its `subject`). */
  isReferrer: boolean;
  subjectDigest: string | null;
  /** Manifests attached to this one. */
  referrerCount: number;
}

const untaggedSelect = sql`
  m.digest, m.media_type, m.artifact_type, m.size, m.created_at, m.pushed_by, m.subject_digest,
  m.config->>'os' AS os, m.config->>'architecture' AS arch, m.config->>'variant' AS variant,
  (SELECT sum(b.size)::bigint FROM manifest_refs mr JOIN blobs b ON b.digest = mr.ref_digest
    WHERE mr.repository_id = m.repository_id AND mr.manifest_digest = m.digest) AS content_bytes,
  EXISTS (SELECT 1 FROM manifest_refs mr WHERE mr.repository_id = m.repository_id AND mr.ref_digest = m.digest) AS is_child,
  (m.subject_digest IS NOT NULL AND EXISTS (SELECT 1 FROM manifests s
    WHERE s.repository_id = m.repository_id AND s.digest = m.subject_digest)) AS is_referrer,
  (SELECT count(*)::int FROM manifests r WHERE r.repository_id = m.repository_id AND r.subject_digest = m.digest) AS referrer_count`;

/** Manifests in the repository that no tag points at, newest first. One query. */
export async function listUntaggedManifests(repoId: string): Promise<UntaggedManifest[]> {
  const { rows } = await db.execute(sql`
    SELECT ${untaggedSelect}
    FROM manifests m
    WHERE m.repository_id = ${repoId}
      AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.repository_id = m.repository_id AND t.manifest_digest = m.digest)
    ORDER BY m.created_at DESC`);
  return rows.map((r) => {
    const mediaType = r.media_type as string;
    return {
      digest: r.digest as string,
      mediaType,
      artifactType: (r.artifact_type as string | null) ?? null,
      isIndex: /index|list/.test(mediaType),
      size: Number(r.size),
      contentBytes: r.content_bytes != null ? Number(r.content_bytes) : null,
      platform: describePlatform(r.os as string | null, r.arch as string | null, r.variant as string | null),
      pushedAt: new Date(r.created_at as string),
      pushedBy: (r.pushed_by as string | null) ?? null,
      isChild: Boolean(r.is_child),
      isReferrer: Boolean(r.is_referrer),
      subjectDigest: (r.subject_digest as string | null) ?? null,
      referrerCount: Number(r.referrer_count),
    };
  });
}

export function describePlatform(os: string | null, arch: string | null, variant: string | null): string | null {
  if (!os && !arch) return null;
  return `${os ?? "?"}/${arch ?? "?"}${variant ? `/${variant}` : ""}`;
}

/** Short label for a manifest media type ("OCI image", "Docker index", or the artifact type). */
export function describeMediaType(mediaType: string, artifactType?: string | null): string {
  if (artifactType) return artifactType;
  const index = /index|list/.test(mediaType);
  if (mediaType.includes("vnd.oci")) return index ? "OCI index" : "OCI image";
  if (mediaType.includes("vnd.docker")) return index ? "Docker manifest list" : "Docker image";
  return mediaType;
}

/** Tags in the repository pointing at the digest. */
export async function tagsForDigest(repoId: string, digest: string): Promise<string[]> {
  const { rows } = await db.execute(sql`
    SELECT name FROM tags WHERE repository_id = ${repoId} AND manifest_digest = ${digest} ORDER BY name`);
  return rows.map((r) => r.name as string);
}

/** Digests of indexes in the repository that list this manifest as a child. */
export async function indexParents(repoId: string, digest: string): Promise<string[]> {
  const { rows } = await db.execute(sql`
    SELECT mr.manifest_digest FROM manifest_refs mr
    JOIN manifests m ON m.repository_id = mr.repository_id AND m.digest = mr.manifest_digest
    WHERE mr.repository_id = ${repoId} AND mr.ref_digest = ${digest}
    ORDER BY m.created_at DESC`);
  return rows.map((r) => r.manifest_digest as string);
}

export interface DeleteManifestOutcome {
  digest: string;
  /** Tags that were removed along with the manifest. */
  tags: string[];
}

/**
 * Why a manifest cannot be deleted by digest right now, or null. Checked
 * before showing the button and again before deleting.
 */
export async function manifestDeleteBlocker(
  repo: { id: string; organizationId: string },
  digest: string,
): Promise<{ reason: string; tags: string[] } | { reason: null; tags: string[] }> {
  const [parents, tags, rules] = await Promise.all([
    indexParents(repo.id, digest),
    tagsForDigest(repo.id, digest),
    effectiveTagRules(repo.organizationId, repo.id),
  ]);
  if (parents.length > 0) {
    return {
      reason: `This image is a platform variant of a multi-arch index (${parents.map((p) => p.slice(7, 19)).join(", ")}) that still exists; delete the index instead.`,
      tags,
    };
  }
  for (const t of tags) {
    const why = protectedReason(rules, t);
    if (why) return { reason: `${why} The image cannot be deleted while it carries that tag.`, tags };
  }
  return { reason: null, tags };
}

/**
 * Delete a manifest by digest as `subject` (a registry subject such as
 * "user:<id>"). Every tag pointing at it goes with it. The caller has
 * checked the access model; throws with a user-facing message.
 */
export async function deleteManifestByDigest(
  repositoryId: string,
  digest: string,
  subject: string,
): Promise<DeleteManifestOutcome> {
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) throw new Error("Repository not found.");
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) throw new Error("Organization not found.");
  const exists = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)),
    columns: { digest: true },
  });
  if (!exists) throw new Error("This image does not exist (anymore).");

  const blocker = await manifestDeleteBlocker(repo, digest);
  if (blocker.reason) throw new Error(blocker.reason);

  const path = imagePath(org.slug, repo.name);
  const { token } = await signRegistryToken(subject, [{ type: "repository", name: path, actions: ["delete"] }], 300);
  const res = await fetch(`${env.registryInternalUrl}/v2/${path}/manifests/${digest}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (res.status === 404) throw new Error("This image does not exist (anymore).");
  if (res.status === 403) throw new Error(`The registry refused: ${await registryErrorMessage(res)}`);
  if (res.status !== 202) throw new Error(`The registry refused to delete the image (HTTP ${res.status}).`);
  return { digest, tags: blocker.tags };
}
