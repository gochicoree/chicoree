// Which manifest a multi-arch tag's size, layer count and kind describe.
//
// An index has no layers of its own: what `docker pull` fetches is one of
// its members. Lists and cards therefore report the first platform variant
// (in index order, BuildKit attestation entries skipped) that this registry
// holds — a proxy cache only has the platforms someone pulled — the same
// choice the compare page makes — and name that platform next to the
// figure. A plain manifest is its own variant.
import { sql, type SQL } from "drizzle-orm";

const isIndex = (m: SQL) => sql`(${m}.media_type LIKE '%index%' OR ${m}.media_type LIKE '%list%')`;

/** The index members as rows (c = member, i = position); empty for a plain manifest or an unreadable index. */
const members = (m: SQL) =>
  sql`jsonb_array_elements(CASE WHEN ${isIndex(m)} AND jsonb_typeof(${m}.payload::jsonb->'manifests') = 'array'
        THEN ${m}.payload::jsonb->'manifests' ELSE '[]'::jsonb END) WITH ORDINALITY AS e(c, i)`;

const notAttestation = sql`COALESCE(e.c->'annotations'->>'vnd.docker.reference.type', '') <> 'attestation-manifest'`;
const hasPlatform = sql`COALESCE(e.c->'platform'->>'os', '') NOT IN ('', 'unknown')`;
/** The member's manifest was pushed or proxied into this repository. */
const held = (m: SQL) => sql`EXISTS (SELECT 1 FROM manifests h WHERE h.repository_id = ${m}.repository_id AND h.digest = e.c->>'digest')`;

/**
 * SQL for the index member (as jsonb) whose blobs count as the manifest's
 * size: the first platform variant the registry holds, else the first
 * non-attestation member it holds; NULL for a plain manifest. `m` is the
 * alias of the manifests row.
 */
export function sizedMember(m: SQL): SQL {
  return sql`COALESCE(
    (SELECT e.c FROM ${members(m)} WHERE ${notAttestation} AND ${hasPlatform} AND ${held(m)} ORDER BY e.i LIMIT 1),
    (SELECT e.c FROM ${members(m)} WHERE ${notAttestation} AND ${held(m)} ORDER BY e.i LIMIT 1))`;
}

/** SQL for the digest whose blobs are the manifest's size: the sized member's, or the manifest's own. */
export function sizedManifestDigest(m: SQL): SQL {
  return sql`COALESCE(${sizedMember(m)}->>'digest', ${m}.digest)`;
}

/** SQL for that variant's platform (`linux/arm64/v8`), NULL for a plain manifest. */
export function sizedPlatform(m: SQL): SQL {
  return sql`(SELECT concat_ws('/', p->>'os', p->>'architecture', NULLIF(p->>'variant', ''))
    FROM (SELECT ${sizedMember(m)}->'platform' AS p) v WHERE p->>'os' IS NOT NULL)`;
}

/**
 * SQL for the config media type that says what a manifest holds (an image,
 * a Helm chart): the sized variant's for an index, the manifest's own
 * otherwise. Feeds repoKindOf.
 */
export function configMediaType(m: SQL): SQL {
  return sql`COALESCE(
    (SELECT c.payload::jsonb->'config'->>'mediaType' FROM manifests c
       WHERE c.repository_id = ${m}.repository_id AND c.digest = ${sizedMember(m)}->>'digest'),
    ${m}.payload::jsonb->'config'->>'mediaType')`;
}
