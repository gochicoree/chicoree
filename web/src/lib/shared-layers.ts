// Layer sharing: which other images reference the blobs of a manifest, and
// how much of a repository's storage is deduplicated / shared. One query per
// manifest, never one per layer.
import { sql } from "drizzle-orm";
import { db } from "@/db";

export interface SharedLayerInfo {
  /** Distinct `org/repo:tag` (or `org/repo@digest`) references other than the manifest being viewed. */
  total: number;
  /** References the viewer may see (public, or in an organization they belong to). */
  visible: string[];
  /** References hidden from the viewer (private repositories elsewhere). */
  hidden: number;
}

/** Up to this many visible references are listed per layer. */
const MAX_VISIBLE_REFS = 25;

/**
 * Map of blob digest → who else references it, for every ref of the
 * manifest (config and layers alike; the caller picks the layers). A
 * reference is an image (tagged: `org/repo:tag`; untagged: the tag of the
 * index it belongs to, else `org/repo@short digest`) other than the one
 * being viewed. Viewer scope: instance admins see everything; otherwise
 * public repositories plus the organizations in `memberOrgIds`.
 */
export async function sharedLayerRefs(
  repositoryId: string,
  manifestDigest: string,
  viewer: { isAdmin: boolean; memberOrgIds: string[] },
): Promise<Map<string, SharedLayerInfo>> {
  // Passed as one comma-separated parameter: drizzle would expand a JS array
  // into a row constructor, and ids never contain commas.
  const orgIds = viewer.memberOrgIds.join(",");
  const { rows } = await db.execute(sql`
    WITH mine AS (
      SELECT ref_digest FROM manifest_refs
      WHERE repository_id = ${repositoryId} AND manifest_digest = ${manifestDigest}
    ),
    refs AS (
      SELECT DISTINCT mine.ref_digest,
        o.slug || '/' || r.name || COALESCE(':' || COALESCE(t.name, pt.name), '@' || substr(mr.manifest_digest, 8, 12)) AS label,
        (r.visibility = 'public' OR ${viewer.isAdmin} OR r.organization_id = ANY(string_to_array(${orgIds}, ','))) AS visible
      FROM mine
      JOIN manifest_refs mr ON mr.ref_digest = mine.ref_digest
      JOIN repositories r ON r.id = mr.repository_id
      JOIN organization o ON o.id = r.organization_id
      LEFT JOIN tags t ON t.repository_id = mr.repository_id AND t.manifest_digest = mr.manifest_digest
      LEFT JOIN manifest_refs pr ON pr.repository_id = mr.repository_id AND pr.ref_digest = mr.manifest_digest
      LEFT JOIN tags pt ON pt.repository_id = pr.repository_id AND pt.manifest_digest = pr.manifest_digest
      WHERE NOT (mr.repository_id = ${repositoryId} AND mr.manifest_digest = ${manifestDigest})
    )
    SELECT ref_digest,
      count(*)::int AS total,
      count(*) FILTER (WHERE NOT visible)::int AS hidden,
      (array_agg(label ORDER BY label) FILTER (WHERE visible))[1:${MAX_VISIBLE_REFS}] AS labels
    FROM refs
    GROUP BY ref_digest`);
  const out = new Map<string, SharedLayerInfo>();
  for (const r of rows) {
    out.set(r.ref_digest as string, {
      total: Number(r.total),
      hidden: Number(r.hidden),
      visible: (r.labels as string[] | null) ?? [],
    });
  }
  return out;
}

export interface RepoStorage {
  /** Bytes every tag would occupy on its own (layers counted once per tag). */
  logicalBytes: number;
  /** Bytes of distinct blobs linked to the repository. */
  physicalBytes: number;
  /** Part of physicalBytes that other repositories link too. */
  sharedBytes: number;
  /** Repositories other than this one linking at least one shared blob. */
  sharedWithRepos: number;
}

/** Logical vs. deduplicated size of a repository, and how much of it is shared elsewhere. One query. */
export async function repositoryStorage(repositoryId: string): Promise<RepoStorage> {
  const { rows } = await db.execute(sql`
    SELECT
      COALESCE((SELECT sum(size) FROM (
        SELECT t.name, b.digest, b.size
        FROM tags t
        JOIN manifest_refs mr ON mr.repository_id = t.repository_id AND mr.manifest_digest = t.manifest_digest
        JOIN blobs b ON b.digest = mr.ref_digest
        WHERE t.repository_id = ${repositoryId}
        UNION
        SELECT t.name, b.digest, b.size
        FROM tags t
        JOIN manifest_refs mr ON mr.repository_id = t.repository_id AND mr.manifest_digest = t.manifest_digest
        JOIN manifest_refs cr ON cr.repository_id = mr.repository_id AND cr.manifest_digest = mr.ref_digest
        JOIN blobs b ON b.digest = cr.ref_digest
        WHERE t.repository_id = ${repositoryId}
      ) x), 0)::bigint AS logical_bytes,
      COALESCE((SELECT sum(b.size) FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest
        WHERE rb.repository_id = ${repositoryId}), 0)::bigint AS physical_bytes,
      COALESCE((SELECT sum(b.size) FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest
        WHERE rb.repository_id = ${repositoryId}
          AND EXISTS (SELECT 1 FROM repository_blobs o WHERE o.blob_digest = rb.blob_digest AND o.repository_id <> ${repositoryId})), 0)::bigint AS shared_bytes,
      (SELECT count(DISTINCT o.repository_id) FROM repository_blobs rb
        JOIN repository_blobs o ON o.blob_digest = rb.blob_digest AND o.repository_id <> ${repositoryId}
        WHERE rb.repository_id = ${repositoryId})::int AS shared_with`);
  const r = rows[0];
  return {
    logicalBytes: Number(r?.logical_bytes ?? 0),
    physicalBytes: Number(r?.physical_bytes ?? 0),
    sharedBytes: Number(r?.shared_bytes ?? 0),
    sharedWithRepos: Number(r?.shared_with ?? 0),
  };
}

/** Organizations the user belongs to (any role), for visibility filtering. */
export async function memberOrgIds(userId: string): Promise<string[]> {
  const { rows } = await db.execute(sql`SELECT organization_id FROM member WHERE user_id = ${userId}`);
  return rows.map((r) => r.organization_id as string);
}
