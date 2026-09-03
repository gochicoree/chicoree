import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings } from "@/db/schema";
import { DefaultVisibilityForm } from "@/components/default-visibility-form";
import { PullPolicyForm } from "@/components/pull-policy-form";
import { orgSettingsContext } from "../context";

export default async function OrgPoliciesPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await orgSettingsContext(params);
  const settings = await db.query.organizationSettings.findFirst({
    where: eq(organizationSettings.organizationId, org.id),
  });
  return (
    <div className="space-y-6">
      <DefaultVisibilityForm scope="organization" organizationId={org.id} value={settings?.defaultVisibility ?? null} />
      <PullPolicyForm
        scope="organization"
        organizationId={org.id}
        level={settings?.blockPullsAt ?? null}
        unrated={settings?.blockUnrated ?? false}
      />
    </div>
  );
}
