import { notFound, redirect } from "next/navigation";
import { getInstanceSettings } from "@/lib/instance-settings";
import { getOrgContext } from "@/lib/session";
import { WRITER_ROLES } from "@/lib/org-roles";
import { PageHeader } from "@/components/page-header";
import { RepositorySetup } from "./repository-setup";
import { resolveDefaultVisibility } from "@/lib/visibility";

export default async function NewRepositoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ mode?: string }>;
}) {
  const { org: slug } = await params;
  const { mode } = await searchParams;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  if (!ctx.role || !WRITER_ROLES.includes(ctx.role)) redirect(`/${slug}`);
  const defaultVisibility = await resolveDefaultVisibility(ctx.org.id);
  const mirroring = (await getInstanceSettings()).access.mirroring;

  return (
    <div>
      <PageHeader
        eyebrow={ctx.org.name}
        title="New repository"
        description={mirroring ? "Start empty, or mirror a repository from another registry. Pushing to a new name also creates a repository." : "Pushing to a new name also creates a repository."}
      />
      <RepositorySetup
        organizationId={ctx.org.id}
        orgSlug={slug}
        defaultVisibility={defaultVisibility}
        initialMode={mode === "mirror" ? "mirror" : "empty"}
        mirroring={mirroring}
      />
    </div>
  );
}
