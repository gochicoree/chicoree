import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { repositoryWebhooks, webhookDeliveries } from "@/db/schema";
import { MAX_WEBHOOKS_PER_REPO } from "@/lib/webhooks";
import { WebhooksManager, type WebhookRow } from "../webhooks-manager";
import { repoSettingsContext } from "../context";

export default async function RepoWebhooksPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  const hooks = await db.query.repositoryWebhooks.findMany({
    where: eq(repositoryWebhooks.repositoryId, repo.id),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  const rows: WebhookRow[] = await Promise.all(
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
  return <WebhooksManager repositoryId={repo.id} hooks={rows} max={MAX_WEBHOOKS_PER_REPO} />;
}
