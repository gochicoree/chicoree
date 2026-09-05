import { UsageMeter } from "@/components/admin/usage-meter";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PortalButton } from "@/components/portal-button";
import type { Limits, Usage } from "@/lib/quota";
import type { PortalSettings } from "@/lib/quota-shared";

/** Whether the card has anything to say: a label, a portal, or at least one limit. */
export function showPlanCard(label: string, limits: Limits, portal: PortalSettings): boolean {
  return !!label || !!portal.url || Object.values(limits).some((v) => v !== null);
}

/**
 * Usage against limits for an account or an organization, with the label an
 * administrator gave the limits row (a plan name, say) and the Manage button
 * for the account portal when one is configured.
 */
export function PlanCard({
  scope,
  label,
  usage,
  limits,
  portal,
  organization,
}: {
  scope: "user" | "organization";
  label: string;
  usage: Usage;
  limits: Limits;
  portal: PortalSettings;
  /** Slug, passed to the portal when the card sits on an organization's settings. */
  organization?: string;
}) {
  return (
    <Card>
      <CardHeader
        eyebrow="Plan"
        title={label || (scope === "user" ? "Your usage" : "Usage")}
        description={scope === "user" ? "Across the organizations you own that have no limits of their own." : "Limits set for this organization; where it has none, the owners' account limits apply."}
        action={portal.url ? <PortalButton url={portal.url} label={portal.label} organization={organization} /> : undefined}
      />
      <CardBody>
        <div className="grid gap-3 sm:grid-cols-3">
          {scope === "user" ? (
            <UsageMeter label="Organizations" used={usage.organizations} limit={limits.maxOrganizations} />
          ) : (
            <UsageMeter label="Members" used={usage.members} limit={limits.maxMembers} />
          )}
          <UsageMeter label="Private repositories" used={usage.privateRepos} limit={limits.maxPrivateRepos} />
          <UsageMeter label="Storage" used={usage.storageBytes} limit={limits.maxStorageBytes} bytes />
        </div>
      </CardBody>
    </Card>
  );
}
