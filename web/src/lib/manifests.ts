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
import { PAGE_SIZES, paginatedQuery, type PageState } from "./paginate-shared";
import { effectiveTagRules, protectedReason } from "./tag-rules";
import { predicateLabel, predicateSubkind, type ArtifactSubkind } from "./signatures-shared";

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
  /** Tags of the indexes that reference it (empty when none of them is tagged). */
  parentTags: string[];
  /** A BuildKit attestation entry (provenance / SBOM stored inside an index, platform unknown/unknown). */
  isAttestation: boolean;
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
  (SELECT string_agg(DISTINCT t.name, ',') FROM manifest_refs mr
    JOIN tags t ON t.repository_id = mr.repository_id AND t.manifest_digest = mr.manifest_digest
    WHERE mr.repository_id = m.repository_id AND mr.ref_digest = m.digest) AS parent_tags,
  (m.subject_digest IS NOT NULL AND EXISTS (SELECT 1 FROM manifests s
    WHERE s.repository_id = m.repository_id AND s.digest = m.subject_digest)) AS is_referrer,
  (SELECT count(*)::int FROM manifests r WHERE r.repository_id = m.repository_id AND r.subject_digest = m.digest) AS referrer_count`;

const untaggedWhere = (repoId: string) => sql`m.repository_id = ${repoId}
      AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.repository_id = m.repository_id AND t.manifest_digest = m.digest)`;

function mapUntagged(rows: Record<string, unknown>[]): UntaggedManifest[] {
  return rows.map((r) => {
    const mediaType = r.media_type as string;
    const platform = describePlatform(r.os as string | null, r.arch as string | null, r.variant as string | null);
    return {
      digest: r.digest as string,
      mediaType,
      artifactType: (r.artifact_type as string | null) ?? null,
      isIndex: /index|list/.test(mediaType),
      size: Number(r.size),
      contentBytes: r.content_bytes != null ? Number(r.content_bytes) : null,
      platform,
      pushedAt: new Date(r.created_at as string),
      pushedBy: (r.pushed_by as string | null) ?? null,
      isChild: Boolean(r.is_child),
      parentTags: r.parent_tags ? String(r.parent_tags).split(",").filter(Boolean).sort() : [],
      isAttestation: Boolean(r.is_child) && isAttestationPlatform(platform),
      isReferrer: Boolean(r.is_referrer),
      subjectDigest: (r.subject_digest as string | null) ?? null,
      referrerCount: Number(r.referrer_count),
    };
  });
}

/**
 * Every untagged manifest of the repository, newest first. One query — the
 * retention planner needs the complete set.
 */
export async function listUntaggedManifests(repoId: string): Promise<UntaggedManifest[]> {
  const { rows } = await db.execute(sql`
    SELECT ${untaggedSelect}
    FROM manifests m
    WHERE ${untaggedWhere(repoId)}
    ORDER BY m.created_at DESC`);
  return mapUntagged(rows as Record<string, unknown>[]);
}

/** One page of the untagged manifests, newest first, plus how many there are. */
export async function untaggedManifestsPage(
  repoId: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ rows: UntaggedManifest[]; state: PageState }> {
  return paginatedQuery<UntaggedManifest>({
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? PAGE_SIZES.untagged,
    count: async () => {
      const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM manifests m WHERE ${untaggedWhere(repoId)}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
        SELECT ${untaggedSelect}
        FROM manifests m
        WHERE ${untaggedWhere(repoId)}
        ORDER BY m.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`);
      return mapUntagged(rows as Record<string, unknown>[]);
    },
  });
}

export function describePlatform(os: string | null, arch: string | null, variant: string | null): string | null {
  if (!os && !arch) return null;
  return `${os ?? "?"}/${arch ?? "?"}${variant ? `/${variant}` : ""}`;
}

/**
 * BuildKit stores provenance and SBOM attestations as extra entries of the
 * image index with the platform "unknown/unknown" (and the annotation
 * vnd.docker.reference.type = attestation-manifest). They are not images.
 */
export function isAttestationPlatform(platform: string | null | undefined): boolean {
  return platform === "unknown/unknown";
}

/** How the untagged list and the delete button explain an index child. */
export function describeIndexChild(m: { isAttestation: boolean; parentTags: string[]; platform: string | null }): string {
  const holder =
    m.parentTags.length > 0
      ? `the multi-arch index tagged ${m.parentTags.map((t) => `"${t}"`).join(", ")}`
      : "a multi-arch index that still exists";
  if (m.isAttestation) {
    return `Not an image: a BuildKit attestation entry (provenance / SBOM) that ${holder} carries. It cannot be deleted on its own — delete the tag or the index, then prune untagged manifests. Build with --provenance=false --sbom=false to stop producing these.`;
  }
  return `The ${m.platform ?? "platform"} variant of ${holder}. It cannot be deleted on its own — delete the index or its tags instead.`;
}

export interface AttestationContent {
  /** Layer blob holding the in-toto statement. */
  digest: string;
  size: number;
  predicateType: string | null;
  subkind: ArtifactSubkind;
  /** "SLSA provenance", "SPDX SBOM", … */
  label: string;
}

/**
 * What a BuildKit attestation entry holds: one in-toto statement per layer,
 * labelled by its predicate type annotation.
 */
export function attestationContents(payload: { layers?: { digest?: string; size?: number; mediaType?: string; annotations?: Record<string, string> }[] }): AttestationContent[] {
  return (payload.layers ?? [])
    .filter((l) => l.digest && /in-toto/.test(l.mediaType ?? ""))
    .map((l) => {
      const predicateType = l.annotations?.["in-toto.io/predicate-type"] ?? null;
      const subkind = predicateSubkind(predicateType);
      return { digest: l.digest!, size: l.size ?? 0, predicateType, subkind, label: predicateLabel(predicateType, subkind) };
    });
}

export interface BuildkitAttestation {
  /** The attestation entry (unknown/unknown manifest) in the index. */
  digest: string;
  contents: AttestationContent[];
}

/**
 * BuildKit attestation entries that describe this image: siblings in the
 * same index whose vnd.docker.reference.digest names it, with what each
 * holds. Shown on the image page so provenance and SBOMs stored this way
 * are not invisible.
 */
export async function buildkitAttestationsFor(repoId: string, digest: string): Promise<BuildkitAttestation[]> {
  const { rows } = await db.execute(sql`
    SELECT m.payload FROM manifest_refs mr
    JOIN manifests m ON m.repository_id = mr.repository_id AND m.digest = mr.manifest_digest
    WHERE mr.repository_id = ${repoId} AND mr.ref_digest = ${digest}`);
  const entries = new Set<string>();
  for (const r of rows) {
    try {
      const parsed = JSON.parse(String(r.payload)) as { manifests?: { digest?: string; annotations?: Record<string, string> }[] };
      for (const c of parsed.manifests ?? []) {
        if (c.digest && c.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" && c.annotations["vnd.docker.reference.digest"] === digest) {
          entries.add(c.digest);
        }
      }
    } catch {
      // not an index we can read
    }
  }
  const out: BuildkitAttestation[] = [];
  for (const d of entries) {
    const row = await db.query.manifests.findFirst({ where: and(eq(manifests.repositoryId, repoId), eq(manifests.digest, d)), columns: { payload: true } });
    if (!row) continue;
    try {
      out.push({ digest: d, contents: attestationContents(JSON.parse(row.payload)) });
    } catch {
      out.push({ digest: d, contents: [] });
    }
  }
  return out;
}

export interface IndexMembership {
  parentDigest: string;
  parentTags: string[];
  /** Platform the index entry declares for this manifest. */
  platform: string | null;
  /** BuildKit attestation entry: the variant it describes, when the annotation says. */
  attestation: { referenceDigest: string | null } | null;
}

/**
 * The indexes in the repository that list this manifest as a child, with
 * what each entry says about it (platform, attestation annotations) and
 * the tags that point at the index — everything the manifest page needs
 * to explain why the manifest exists and why it cannot go on its own.
 */
export async function indexMemberships(repoId: string, digest: string): Promise<IndexMembership[]> {
  const { rows } = await db.execute(sql`
    SELECT m.digest, m.payload,
      (SELECT string_agg(t.name, ',' ORDER BY t.name) FROM tags t WHERE t.repository_id = m.repository_id AND t.manifest_digest = m.digest) AS tags
    FROM manifest_refs mr
    JOIN manifests m ON m.repository_id = mr.repository_id AND m.digest = mr.manifest_digest
    WHERE mr.repository_id = ${repoId} AND mr.ref_digest = ${digest}
    ORDER BY m.created_at DESC`);
  const out: IndexMembership[] = [];
  for (const r of rows) {
    let entry: { platform?: { os?: string; architecture?: string; variant?: string }; annotations?: Record<string, string> } | undefined;
    try {
      const parsed = JSON.parse(String(r.payload)) as { manifests?: { digest?: string; platform?: { os?: string; architecture?: string; variant?: string }; annotations?: Record<string, string> }[] };
      entry = (parsed.manifests ?? []).find((c) => c.digest === digest);
    } catch {
      // an index we cannot parse still blocks deletion; describe it without details
    }
    const platform = entry?.platform ? describePlatform(entry.platform.os ?? null, entry.platform.architecture ?? null, entry.platform.variant ?? null) : null;
    const type = entry?.annotations?.["vnd.docker.reference.type"];
    const attestation =
      type === "attestation-manifest" || isAttestationPlatform(platform)
        ? { referenceDigest: entry?.annotations?.["vnd.docker.reference.digest"] ?? null }
        : null;
    out.push({
      parentDigest: String(r.digest),
      parentTags: r.tags ? String(r.tags).split(",").filter(Boolean) : [],
      platform,
      attestation,
    });
  }
  return out;
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
    indexMemberships(repo.id, digest),
    tagsForDigest(repo.id, digest),
    effectiveTagRules(repo.organizationId, repo.id),
  ]);
  if (parents.length > 0) {
    const first = parents[0];
    return {
      reason: describeIndexChild({
        isAttestation: !!first.attestation,
        parentTags: [...new Set(parents.flatMap((p) => p.parentTags))],
        platform: first.platform,
      }),
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
