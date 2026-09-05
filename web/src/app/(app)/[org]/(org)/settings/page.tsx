import { LogoUploadCard } from "@/components/logo-upload";
import { PlanCard, showPlanCard } from "@/components/plan-card";
import { saveOrganizationLogo } from "@/app/actions/logos";
import { getInstanceSettings } from "@/lib/instance-settings";
import { getOrgLimitsRow } from "@/lib/limits";
import { getOrgLimits, getOrgUsage } from "@/lib/quota";
import { OrgGeneralForm } from "./org-settings";
import { orgSettingsContext } from "./context";

export default async function OrgGeneralSettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org, library } = await orgSettingsContext(params);
  const [usage, limits, limitsRow, settings] = await Promise.all([getOrgUsage(org.id), getOrgLimits(org.id), getOrgLimitsRow(org.id), getInstanceSettings()]);
  const label = limitsRow?.label ?? "";
  return (
    <div className="space-y-6">
      {showPlanCard(label, limits, settings.portal) && <PlanCard scope="organization" label={label} usage={usage} limits={limits} portal={settings.portal} organization={org.slug} />}
      <OrgGeneralForm organizationId={org.id} name={org.name} slug={org.slug} isLibrary={library} />
      <LogoUploadCard
        action={saveOrganizationLogo}
        kind="organization"
        name={org.name}
        fields={{ organizationId: org.id }}
        initial={org.logo}
        title="Organization picture"
        description="Shown wherever this organization appears."
      />
    </div>
  );
}
