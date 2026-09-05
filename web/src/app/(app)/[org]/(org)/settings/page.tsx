import { LogoUploadCard } from "@/components/logo-upload";
import { saveOrganizationLogo } from "@/app/actions/logos";
import { OrgGeneralForm } from "./org-settings";
import { orgSettingsContext } from "./context";

export default async function OrgGeneralSettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org, library } = await orgSettingsContext(params);
  return (
    <div className="space-y-6">
      <OrgGeneralForm organizationId={org.id} name={org.name} slug={org.slug} isLibrary={library} />
      <LogoUploadCard
        action={saveOrganizationLogo}
        kind="organization"
        name={org.name}
        fields={{ organizationId: org.id }}
        initial={org.logo}
        title="Organization picture"
        description="Shown wherever this organization appears: the sidebar, the organization list, search results and its own page."
      />
    </div>
  );
}
