// Read queries the REST API needs beyond what the UI's libraries offer:
// organization listings filtered by the caller, and the image document
// (config, layers, variants, scan, signature, block) the tag page assembles
// inline. Everything here is scoped by lib/api/access.ts.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { ciIdentitiesTrusted, manifestSignatures, member, organizationSettings, serviceAccounts, user as userTable, userSettings, vulnerabilityScans } from "@/db/schema";
import { getManifestWithScan, indexScanRollups, mapRepoRow, repoListSelect, type RepoListItem } from "@/lib/data";
import { env } from "@/lib/env";
import { imagePath, imageReference } from "@/lib/library";
import { describePlatform, indexMemberships, isAttestationPlatform, manifestDeleteBlocker, tagsForDigest } from "@/lib/manifests";
import { effectiveScanSummary, loadExceptionRules, manifestBlockReason } from "@/lib/pull-policy";
import { fetchBlobJson } from "@/lib/registry-client";
import { layersWithInstructions, type ImageConfigView } from "@/lib/compare-shared";
import { PAGE_SIZES, paginatedQuery, type PageState } from "@/lib/paginate-shared";
import { repoHref } from "@/lib/proxy-shared";
import type { SeveritySummary } from "@/components/severity";
import type { ApiCaller } from "./auth";
import { orgFilter, repoFilter, type OrgAccess, type RepoAccess } from "./access";
import { iso } from "./respond";
import { absolute, compactSummary, scanJson } from "./serialize";
import { helmCommands, isHelmConfig, parseChartMeta } from "@/lib/helm-shared";

// --- Organizations ------------------------------------------------------------

export interface OrgJson {
  id: string;
  slug: string;
  name: string;
  role: string | null;
  repositoryCount: number;
  proxy: boolean;
  createdAt: string | null;
  url: string;
}

function roleSql(c: ApiCaller) {
  if (c.kind !== "user") return sql`NULL`;
  if (c.caller.isAdmin) return sql`'owner'`;
  return sql`(SELECT m.role FROM member m WHERE m.organization_id = o.id AND m.user_id = ${c.user.id} LIMIT 1)`;
}

const orgSelect = (c: ApiCaller) => sql`
  o.id, o.slug, o.name, o.created_at,
  (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id AND ${repoFilter(c)}) AS repo_count,
  ${roleSql(c)} AS role,
  EXISTS (SELECT 1 FROM organization_proxies p WHERE p.organization_id = o.id) AS proxy`;

function mapOrg(r: Record<string, unknown>): OrgJson {
  return {
    id: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    role: (r.role as string | null) ?? null,
    repositoryCount: Number(r.repo_count ?? 0),
    proxy: Boolean(r.proxy),
    createdAt: iso(r.created_at as string),
    url: absolute(`/${r.slug as string}`),
  };
}

export async function listOrgs(c: ApiCaller, opts: { q?: string; page: number; pageSize: number }): Promise<{ rows: OrgJson[]; state: PageState }> {
  const term = (opts.q ?? "").trim();
  const like = `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
  const where = sql`${orgFilter(c)} ${term ? sql`AND (o.name ILIKE ${like} OR o.slug ILIKE ${like})` : sql``}`;
  return paginatedQuery<OrgJson>({
    page: opts.page,
    pageSize: opts.pageSize,
    count: async () => {
      const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM organization o WHERE ${where}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
        SELECT ${orgSelect(c)} FROM organization o WHERE ${where}
        ORDER BY o.slug LIMIT ${limit} OFFSET ${offset}`);
      return rows.map(mapOrg);
    },
  });
}

/** The listing document plus member count and storage. */
export async function orgDetail(c: ApiCaller, a: OrgAccess): Promise<OrgJson & { memberCount: number; storageBytes: number }> {
  const { rows } = await db.execute(sql`
    SELECT ${orgSelect(c)},
      (SELECT count(*)::int FROM member m WHERE m.organization_id = o.id) AS member_count,
      COALESCE((
        SELECT sum(size)::bigint FROM (
          SELECT DISTINCT b.digest, b.size
          FROM blobs b
          JOIN repository_blobs rb ON rb.blob_digest = b.digest
          JOIN repositories r ON r.id = rb.repository_id
          WHERE r.organization_id = o.id
        ) t
      ), 0) AS storage_bytes
    FROM organization o WHERE o.id = ${a.org.id}`);
  const r = rows[0] ?? {};
  return { ...mapOrg(r), memberCount: Number(r.member_count ?? 0), storageBytes: Number(r.storage_bytes ?? 0) };
}

// --- Repositories -------------------------------------------------------------

export type RepoSort = "updated" | "pulls" | "name";

export async function listRepos(
  c: ApiCaller,
  organizationId: string,
  opts: { q?: string; visibility?: "public" | "private"; sort?: RepoSort; page: number; pageSize: number },
): Promise<{ rows: RepoListItem[]; state: PageState }> {
  const term = (opts.q ?? "").trim();
  const like = `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
  const conds = [sql`r.organization_id = ${organizationId}`, repoFilter(c)];
  if (term) conds.push(sql`(r.name ILIKE ${like} OR r.description ILIKE ${like})`);
  if (opts.visibility) conds.push(sql`r.visibility = ${opts.visibility}`);
  const where = sql.join(conds, sql` AND `);
  const order =
    opts.sort === "name" ? sql`r.name ASC` : opts.sort === "pulls" ? sql`r.pull_count DESC, r.updated_at DESC` : sql`r.updated_at DESC, r.name ASC`;
  return paginatedQuery<RepoListItem>({
    page: opts.page,
    pageSize: opts.pageSize ?? PAGE_SIZES.repositories,
    count: async () => {
      const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM repositories r JOIN organization o ON o.id = r.organization_id WHERE ${where}`);
      return Number(rows[0]?.n ?? 0);
    },
    rows: async (limit, offset) => {
      const { rows } = await db.execute(sql`
        SELECT ${repoListSelect}
        FROM repositories r JOIN organization o ON o.id = r.organization_id
        WHERE ${where}
        ORDER BY ${order}
        LIMIT ${limit} OFFSET ${offset}`);
      return rows.map(mapRepoRow);
    },
  });
}

/** Organization setting → the creator's own setting → private (the push path's rule). */
export async function defaultVisibility(organizationId: string, userId: string | null): Promise<"public" | "private"> {
  const org = await db.query.organizationSettings.findFirst({ where: eq(organizationSettings.organizationId, organizationId) });
  if (org?.defaultVisibility) return org.defaultVisibility;
  if (userId) {
    const me = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, userId) });
    if (me?.defaultVisibility) return me.defaultVisibility;
  }
  return "private";
}

/** One repository as a listing row (the same projection as the lists). */
export async function repoListItem(repositoryId: string): Promise<RepoListItem | null> {
  const { rows } = await db.execute(sql`
    SELECT ${repoListSelect}
    FROM repositories r JOIN organization o ON o.id = r.organization_id
    WHERE r.id = ${repositoryId}`);
  return rows[0] ? mapRepoRow(rows[0]) : null;
}

// --- Images -------------------------------------------------------------------

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
  platform?: { os?: string; architecture?: string; variant?: string };
  annotations?: Record<string, string>;
}

interface ManifestPayload {
  config?: Descriptor;
  layers?: Descriptor[];
  manifests?: Descriptor[];
  subject?: Descriptor;
  annotations?: Record<string, string>;
}

async function pushedByJson(pushedBy: string | null): Promise<{ type: string; id: string | null; label: string } | null> {
  if (!pushedBy) return null;
  const colon = pushedBy.indexOf(":");
  const kind = colon < 0 ? pushedBy : pushedBy.slice(0, colon);
  const id = colon < 0 ? null : pushedBy.slice(colon + 1);
  if (kind === "user" && id) {
    if (id === "system") return { type: "system", id: null, label: "system" };
    const u = await db.query.user.findFirst({ where: eq(userTable.id, id), columns: { name: true } });
    return { type: "user", id, label: u?.name ?? "deleted user" };
  }
  if (kind === "sa" && id?.startsWith("ci:")) {
    const identity = await db.query.ciIdentitiesTrusted.findFirst({ where: eq(ciIdentitiesTrusted.id, id.slice(3)), columns: { name: true } });
    return { type: "ci", id, label: identity ? `CI: ${identity.name}` : "deleted CI identity" };
  }
  if (kind === "sa" && id) {
    const sa = await db.query.serviceAccounts.findFirst({ where: eq(serviceAccounts.id, id), columns: { name: true } });
    return { type: "service-account", id, label: sa?.name ?? "deleted service account" };
  }
  if (kind === "proxy") return { type: "proxy", id, label: "proxy cache" };
  if (kind === "mirror") return { type: "mirror", id, label: "mirror" };
  return { type: kind, id, label: pushedBy };
}

/** The image document behind GET …/manifests/{digest} and GET …/tags/{tag}. */
export async function manifestDetail(a: RepoAccess, digest: string) {
  const result = await getManifestWithScan(a.repo.id, digest);
  if (!result) return null;
  const { manifest, scan } = result;
  let payload: ManifestPayload = {};
  try {
    payload = JSON.parse(manifest.payload) as ManifestPayload;
  } catch {
    // an unparsable manifest is described from its row alone
  }
  const isIndex = Array.isArray(payload.manifests);
  const path = imagePath(a.org.slug, a.repo.name);

  let config: ImageConfigView | null = (manifest.config as ImageConfigView | null) ?? null;
  if (!config && !isIndex && manifest.configDigest) {
    config = (await fetchBlobJson(path, manifest.configDigest)) as ImageConfigView | null;
  }

  const childDigests = isIndex ? (payload.manifests ?? []).map((m) => m.digest).filter((d): d is string => !!d) : [];
  const [tags, blocked, rules, parents, signedRow, pushedBy, deletable, childScans, indexBytes] = await Promise.all([
    tagsForDigest(a.repo.id, digest),
    manifestBlockReason(a.repo.id, digest),
    loadExceptionRules(a.org.id, a.repo.id),
    indexMemberships(a.repo.id, digest),
    db.query.manifestSignatures.findFirst({
      where: and(
        eq(manifestSignatures.repositoryId, a.repo.id),
        eq(manifestSignatures.manifestDigest, digest),
        eq(manifestSignatures.kind, "signature"),
        eq(manifestSignatures.status, "verified"),
      ),
      columns: { signatureDigest: true },
    }),
    pushedByJson(manifest.pushedBy),
    a.can.delete ? manifestDeleteBlocker(a.repo, digest) : Promise.resolve(null),
    childDigests.length ? db.query.vulnerabilityScans.findMany({ where: inArray(vulnerabilityScans.digest, childDigests) }) : Promise.resolve([]),
    childDigests.length
      ? db
          .execute(
            sql`SELECT COALESCE(sum(size), 0)::bigint AS n FROM (
                  SELECT DISTINCT b.digest, b.size FROM manifest_refs mr JOIN blobs b ON b.digest = mr.ref_digest
                  WHERE mr.repository_id = ${a.repo.id} AND mr.manifest_digest IN (${sql.join(
                    childDigests.map((d) => sql`${d}`),
                    sql`, `,
                  )})) t`,
          )
          .then((r) => Number(r.rows[0]?.n ?? 0))
      : Promise.resolve(0),
  ]);

  const layers = layersWithInstructions(payload.layers ?? [], config).map((l) => ({
    digest: l.digest,
    sizeBytes: l.size,
    mediaType: l.mediaType ?? null,
    command: l.command,
  }));
  const imageBytes = layers.reduce((sum, l) => sum + l.sizeBytes, 0) + (payload.config?.size ?? 0);

  const scanByChild = new Map(childScans.map((s) => [s.digest, s]));
  const variants = (payload.manifests ?? []).map((m) => {
    const platform = m.platform ? describePlatform(m.platform.os ?? null, m.platform.architecture ?? null, m.platform.variant ?? null) : null;
    const s = m.digest ? scanByChild.get(m.digest) : undefined;
    return {
      digest: m.digest ?? null,
      platform,
      mediaType: m.mediaType ?? null,
      manifestBytes: m.size ?? null,
      attestation: m.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" || isAttestationPlatform(platform),
      scan: s ? { status: s.status, summary: compactSummary(s.summary as SeveritySummary | null) } : null,
    };
  });

  let scanDoc: ReturnType<typeof scanJson> | { status: string | null; summary: Record<string, number> | null; effectiveSummary: null; scanner: null; scannerVersion: null; updatedAt: null; error: null; variantsScanned: number; variants: number } | null = null;
  if (isIndex) {
    const rollup = (await indexScanRollups(a.repo.id, [digest])).get(digest);
    if (rollup && (rollup.status || rollup.summary)) {
      scanDoc = {
        status: rollup.status,
        summary: compactSummary(rollup.summary),
        effectiveSummary: null,
        scanner: null,
        scannerVersion: null,
        updatedAt: null,
        error: null,
        variantsScanned: rollup.scanned,
        variants: rollup.variants,
      };
    }
  } else if (scan) {
    scanDoc = scanJson(scan, effectiveScanSummary(scan, rules, a.repo.id));
  }

  const platform = config ? describePlatform(config.os ?? null, config.architecture ?? null, config.variant ?? null) : null;
  const cfg = config?.config;
  const base = repoHref(a.org.slug, a.repo.name);
  const chart = !isIndex && isHelmConfig(payload.config?.mediaType) ? parseChartMeta(config) : null;
  return {
    digest,
    tags,
    mediaType: manifest.mediaType,
    artifactType: manifest.artifactType,
    kind: chart ? "chart" : "image",
    chart,
    helm: chart ? helmCommands(env.registryHost, imagePath(a.org.slug, a.repo.name), chart.version, chart.name) : null,
    isIndex,
    manifestBytes: manifest.size,
    sizeBytes: isIndex ? indexBytes : imageBytes,
    pushedAt: iso(manifest.createdAt),
    pushedBy,
    platform: chart ? null : platform,
    config: chart
      ? null
      : config
      ? {
          created: config.created ?? null,
          os: config.os ?? null,
          architecture: config.architecture ?? null,
          variant: config.variant ?? null,
          user: cfg?.User ?? null,
          workingDir: cfg?.WorkingDir ?? null,
          entrypoint: cfg?.Entrypoint ?? [],
          cmd: cfg?.Cmd ?? [],
          env: cfg?.Env ?? [],
          exposedPorts: Object.keys(cfg?.ExposedPorts ?? {}),
          labels: cfg?.Labels ?? {},
        }
      : null,
    annotations: payload.annotations ?? {},
    layers,
    variants,
    indexes: parents.map((p) => ({ digest: p.parentDigest, tags: p.parentTags, platform: p.platform, attestation: !!p.attestation })),
    subjectDigest: manifest.subjectDigest ?? payload.subject?.digest ?? null,
    scan: chart ? null : scanDoc,
    signed: !!signedRow,
    blocked,
    canDelete: deletable ? { ok: !deletable.reason, reason: deletable.reason } : { ok: false, reason: a.can.delete ? null : "You cannot delete images in this repository." },
    reference: imageReference(env.registryHost, a.org.slug, a.repo.name, digest),
    url: absolute(`${base}/tags/${encodeURIComponent(digest)}`),
  };
}

/** Members of an organization with their user, for the members endpoint. */
export async function orgMembers(organizationId: string) {
  return db
    .select({ userId: userTable.id, name: userTable.name, email: userTable.email, role: member.role, joinedAt: member.createdAt })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(eq(member.organizationId, organizationId))
    .orderBy(member.createdAt);
}
