import { listWebhookRows, maxWebhooks } from "@/lib/webhooks";
import { WebhooksManager } from "@/components/webhooks-manager";
import { repoSettingsContext } from "../context";

export default async function RepoWebhooksPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  const scope = { kind: "repository", repositoryId: repo.id } as const;
  const rows = await listWebhookRows(scope);
  return <WebhooksManager scope={scope} hooks={rows} max={maxWebhooks(scope)} />;
}
