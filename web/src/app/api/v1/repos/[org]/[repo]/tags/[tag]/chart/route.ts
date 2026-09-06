// GET /api/v1/repos/{org}/{repo}/tags/{tag}/chart — a Helm chart's Chart.yaml,
// values.yaml, README and file list, plus the helm commands. 404 when the tag
// is not a chart.
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { manifests, tags } from "@/db/schema";
import { loadRepo } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { iso, json, notFound } from "@/lib/api/respond";
import { env } from "@/lib/env";
import { readChartFiles } from "@/lib/helm";
import { helmCommands, isHelmConfig, parseChartMeta } from "@/lib/helm-shared";
import { imagePath } from "@/lib/library-shared";
import { decodeRepoParam } from "@/lib/proxy-shared";
import { fetchBlobJson } from "@/lib/registry-client";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string; repo: string; tag: string }>(async (_req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const tagName = decodeURIComponent(params.tag);
  const row = await db.query.tags.findFirst({ where: and(eq(tags.repositoryId, a.repo.id), eq(tags.name, tagName)) });
  if (!row) throw notFound("No such tag.");
  const manifest = await db.query.manifests.findFirst({ where: and(eq(manifests.repositoryId, a.repo.id), eq(manifests.digest, row.manifestDigest)) });
  if (!manifest) throw notFound("No such tag.");
  let payload: { config?: { mediaType?: string; digest?: string }; layers?: { digest?: string; mediaType?: string }[] } = {};
  try {
    payload = JSON.parse(manifest.payload);
  } catch {
    payload = {};
  }
  if (!isHelmConfig(payload.config?.mediaType)) throw notFound("This tag is not a Helm chart.");
  const path = `${a.org.slug}/${a.repo.name}`;
  let config: unknown = manifest.config ?? null;
  if (!config && manifest.configDigest) config = await fetchBlobJson(path, manifest.configDigest);
  const chart = parseChartMeta(config);
  if (!chart) throw notFound("The chart's Chart.yaml could not be read.");
  const files = await readChartFiles(path, payload.layers ?? []);
  return json({
    tag: tagName,
    digest: row.manifestDigest,
    pushedAt: iso(manifest.createdAt),
    chart,
    files: files ? { values: files.values, readme: files.readme, chartYaml: files.chartYaml, list: files.files, truncated: files.truncated } : null,
    commands: helmCommands(env.registryHost, imagePath(a.org.slug, a.repo.name), chart.version, chart.name),
  });
});
