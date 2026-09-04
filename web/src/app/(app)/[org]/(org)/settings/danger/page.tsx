import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { listOrganizationRedirects } from "@/lib/redirects";
import { OrgDeleteForm } from "../org-settings";
import { OrgRenameForm } from "../org-rename-form";
import { orgSettingsContext } from "../context";

export default async function OrgDangerPage({ params }: { params: Promise<{ org: string }> }) {
  const { org, canDelete, base } = await orgSettingsContext(params);
  if (!canDelete) redirect(base);
  const former = await listOrganizationRedirects(org.id);
  return (
    <div className="space-y-6">
      <OrgRenameForm organizationId={org.id} slug={org.slug} registryHost={env.registryHost} formerSlugs={former.map((f) => f.oldSlug)} />
      <OrgDeleteForm organizationId={org.id} slug={org.slug} />
    </div>
  );
}
