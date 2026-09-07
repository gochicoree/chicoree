import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { mirrorRuns, mirrors } from "@/db/schema";
import { PAGE_SIZES, pageParam, paginatedQuery } from "@/lib/paginate-shared";
import { Card, CardHeader } from "@/components/ui/card";
import { getInstanceSettings } from "@/lib/instance-settings";
import { MirrorManager, type MirrorView } from "../mirror-manager";
import { repoSettingsContext } from "../context";

export default async function RepoMirrorPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; repo: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { repo, base } = await repoSettingsContext(params);
  const query = await searchParams;
  const mirror = await db.query.mirrors.findFirst({ where: eq(mirrors.repositoryId, repo.id) });
  const mirroring = (await getInstanceSettings()).access.mirroring;
  if (!mirroring && !mirror) {
    return (
      <Card>
        <CardHeader eyebrow="Mirror" title="Mirroring is switched off on this registry" description="Repositories here cannot mirror or import from other registries." />
      </Card>
    );
  }
  let view: MirrorView | null = null;
  if (mirror) {
    let running = false;
    const { rows: runs, state } = await paginatedQuery<typeof mirrorRuns.$inferSelect>({
      page: pageParam(query, "runs"),
      pageSize: PAGE_SIZES.mirrorRuns,
      // One count query, which also reports whether a run is in flight (the
      // manager polls while one is) regardless of the page being shown.
      count: async () => {
        const { rows } = await db.execute(sql`
          SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'running')::int AS running
          FROM mirror_runs WHERE mirror_id = ${mirror.id}`);
        running = Number(rows[0]?.running ?? 0) > 0;
        return Number(rows[0]?.n ?? 0);
      },
      rows: (limit, offset) =>
        db.query.mirrorRuns.findMany({
          where: eq(mirrorRuns.mirrorId, mirror.id),
          orderBy: [desc(mirrorRuns.startedAt)],
          limit,
          offset,
        }),
    });
    view = {
      id: mirror.id,
      source: mirror.source,
      hasAuth: !!mirror.sourceAuth,
      selector: mirror.selector,
      relabel: mirror.relabel,
      overwrite: mirror.overwrite,
      enabled: mirror.enabled,
      lastRunAt: mirror.lastRunAt?.toISOString() ?? null,
      lastStatus: mirror.lastStatus,
      lastError: mirror.lastError,
      running,
      runsState: state,
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        matched: r.matched,
        imported: r.imported,
        skipped: r.skipped,
        failed: r.failed,
        error: r.error,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        log: r.log,
      })),
    };
  }
  return <MirrorManager repositoryId={repo.id} mirror={view} basePath={`${base}/mirror`} params={query} disabled={!mirroring} />;
}
