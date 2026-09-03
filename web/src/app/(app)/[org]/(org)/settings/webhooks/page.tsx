import { listWebhookRows, maxWebhooks } from "@/lib/webhooks";
import { WebhooksManager } from "@/components/webhooks-manager";
import { orgSettingsContext } from "../context";

export default async function OrgWebhooksPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await orgSettingsContext(params);
  const scope = { kind: "organization", organizationId: org.id } as const;
  const rows = await listWebhookRows(scope);
  return <WebhooksManager scope={scope} hooks={rows} max={maxWebhooks(scope)} />;
}
