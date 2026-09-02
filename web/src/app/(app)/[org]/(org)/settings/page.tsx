import { notFound, redirect } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { OrgSettings } from "./org-settings";
import { DefaultVisibilityForm } from "@/components/default-visibility-form";
import { PullPolicyForm } from "@/components/pull-policy-form";
import { isLibrary } from "@/lib/library";
import { db } from "@/db";
import { organizationSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

export default async function OrgSettingsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  if (ctx.role !== "owner" && ctx.role !== "admin") redirect(`/${slug}`);

  const settings = await db.query.organizationSettings.findFirst({
    where: eq(organizationSettings.organizationId, ctx.org.id),
  });

  return (
    <OrgSettings
      organizationId={ctx.org.id}
      name={ctx.org.name}
      slug={ctx.org.slug}
      isOwner={ctx.role === "owner" && !isLibrary(ctx.org.slug)}
      isLibrary={isLibrary(ctx.org.slug)}
    >
      <DefaultVisibilityForm scope="organization" organizationId={ctx.org.id} value={settings?.defaultVisibility ?? null} />
      <PullPolicyForm
        scope="organization"
        organizationId={ctx.org.id}
        level={settings?.blockPullsAt ?? null}
        unrated={settings?.blockUnrated ?? false}
      />
    </OrgSettings>
  );
}
