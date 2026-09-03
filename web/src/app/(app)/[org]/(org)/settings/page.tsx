import { OrgGeneralForm } from "./org-settings";
import { orgSettingsContext } from "./context";

export default async function OrgGeneralSettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org, library } = await orgSettingsContext(params);
  return <OrgGeneralForm organizationId={org.id} name={org.name} slug={org.slug} isLibrary={library} />;
}
