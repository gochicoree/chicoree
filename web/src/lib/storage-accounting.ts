// How many bytes a move actually adds to an organization. Blob content is
// content-addressed and shared across repositories, so only blobs the target
// organization does not hold anywhere yet count against its storage quota.
// Used by the repository transfer (app/actions/repo-tools.ts) and by the
// single-image copy/move (lib/image-move.ts).
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Bytes of a repository's blobs the organization does not hold yet.
 * `exclude` names repositories that will already be in the organization by
 * the time this one lands, so previewing a batch counts a layer shared
 * between two moved repositories once (lib/repo-move.ts).
 */
export async function repositoryBytesNewToOrg(repositoryId: string, organizationId: string, exclude: string[] = []): Promise<number> {
  const { rows } = await db.execute(sql`
    SELECT COALESCE(sum(b.size), 0)::bigint AS bytes
    FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest
    WHERE rb.repository_id = ${repositoryId}
      AND NOT EXISTS (
        SELECT 1 FROM repository_blobs o JOIN repositories r ON r.id = o.repository_id
        WHERE o.blob_digest = rb.blob_digest AND r.organization_id = ${organizationId})
      ${
        exclude.length > 0
          ? sql`AND NOT EXISTS (
        SELECT 1 FROM repository_blobs p
        WHERE p.blob_digest = rb.blob_digest
          AND p.repository_id = ANY(string_to_array(${exclude.join(",")}, ',')))`
          : sql``
      }`);
  return Number(rows[0]?.bytes ?? 0);
}

/** Bytes of the given blob digests the organization does not hold yet (each digest counted once). */
export async function blobBytesNewToOrg(digests: string[], organizationId: string): Promise<number> {
  if (digests.length === 0) return 0;
  const { rows } = await db.execute(sql`
    SELECT COALESCE(sum(b.size), 0)::bigint AS bytes
    FROM blobs b
    WHERE ${inArray(sql`b.digest`, digests)}
      AND NOT EXISTS (
        SELECT 1 FROM repository_blobs o JOIN repositories r ON r.id = o.repository_id
        WHERE o.blob_digest = b.digest AND r.organization_id = ${organizationId})`);
  return Number(rows[0]?.bytes ?? 0);
}
