import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { mirrorRuns, mirrors } from "@/db/schema";
import { MirrorManager, type MirrorView } from "../mirror-manager";
import { repoSettingsContext } from "../context";

export default async function RepoMirrorPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  const mirror = await db.query.mirrors.findFirst({ where: eq(mirrors.repositoryId, repo.id) });
  let view: MirrorView | null = null;
  if (mirror) {
    const runs = await db.query.mirrorRuns.findMany({
      where: eq(mirrorRuns.mirrorId, mirror.id),
      orderBy: [desc(mirrorRuns.startedAt)],
      limit: 3,
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
  return <MirrorManager repositoryId={repo.id} mirror={view} />;
}
