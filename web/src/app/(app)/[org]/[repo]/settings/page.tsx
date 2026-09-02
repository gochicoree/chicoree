import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { mirrorRuns, mirrors, repositoryWebhooks, webhookDeliveries } from "@/db/schema";
import { getOrgContext } from "@/lib/session";
import { getRepoByPath } from "@/lib/data";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { MAX_WEBHOOKS_PER_REPO } from "@/lib/webhooks";
import { RepoSettingsForm } from "./repo-settings-form";
import { WebhooksManager, type WebhookRow } from "./webhooks-manager";
import { MirrorManager, type MirrorView } from "./mirror-manager";

export default async function RepoSettingsPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org: orgSlug, repo: repoName } = await params;
  const found = await getRepoByPath(orgSlug, repoName);
  if (!found) notFound();
  const ctx = await getOrgContext(orgSlug);
  if (!ctx?.role || !MANAGER_ROLES.includes(ctx.role)) redirect(`/${orgSlug}/${repoName}`);

  const hooks = await db.query.repositoryWebhooks.findMany({
    where: eq(repositoryWebhooks.repositoryId, found.repo.id),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  const hookRows: WebhookRow[] = await Promise.all(
    hooks.map(async (h) => {
      const deliveries = await db.query.webhookDeliveries.findMany({
        where: eq(webhookDeliveries.webhookId, h.id),
        orderBy: [desc(webhookDeliveries.createdAt)],
        limit: 10,
      });
      return {
        id: h.id,
        name: h.name,
        url: h.url,
        method: h.method,
        headers: h.headers,
        authType: h.authType,
        authHeaderName: h.authHeaderName,
        hasAuthSecret: !!h.authSecret,
        hasSigningSecret: !!h.signingSecret,
        events: h.events,
        enabled: h.enabled,
        lastStatus: h.lastStatus,
        lastDeliveredAt: h.lastDeliveredAt?.toISOString() ?? null,
        lastError: h.lastError,
        deliveries: deliveries.map((d) => ({
          id: d.id,
          event: d.event,
          ok: d.ok,
          statusCode: d.statusCode,
          attempts: d.attempts,
          durationMs: d.durationMs,
          error: d.error,
          createdAt: d.createdAt.toISOString(),
        })),
      };
    }),
  );

  const mirror = await db.query.mirrors.findFirst({ where: eq(mirrors.repositoryId, found.repo.id) });
  let mirrorView: MirrorView | null = null;
  if (mirror) {
    const runs = await db.query.mirrorRuns.findMany({
      where: eq(mirrorRuns.mirrorId, mirror.id),
      orderBy: [desc(mirrorRuns.startedAt)],
      limit: 3,
    });
    mirrorView = {
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

  return (
    <div>
      <Link href={`/${orgSlug}/${repoName}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> {orgSlug}/{repoName}
      </Link>
      <RepoSettingsForm
        repositoryId={found.repo.id}
        name={found.repo.name}
        description={found.repo.description}
        visibility={found.repo.visibility}
      >
        <WebhooksManager repositoryId={found.repo.id} hooks={hookRows} max={MAX_WEBHOOKS_PER_REPO} />
        <div id="mirror">
          <MirrorManager repositoryId={found.repo.id} mirror={mirrorView} />
        </div>
      </RepoSettingsForm>
    </div>
  );
}
