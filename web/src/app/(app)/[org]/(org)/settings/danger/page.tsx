import { redirect } from "next/navigation";
import { OrgDeleteForm } from "../org-settings";
import { orgSettingsContext } from "../context";

export default async function OrgDangerPage({ params }: { params: Promise<{ org: string }> }) {
  const { org, canDelete, base } = await orgSettingsContext(params);
  if (!canDelete) redirect(base);
  return <OrgDeleteForm organizationId={org.id} slug={org.slug} />;
}
