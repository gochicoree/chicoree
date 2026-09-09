import { notFound, redirect } from "next/navigation";
import { mirroringMode } from "@/lib/access-shared";
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
  const mirroring = mirroringMode((await getInstanceSettings()).access);
  const description =
    mirroring === "off"
      ? "Pushing to a new name also creates a repository."
      : mirroring === "credentials"
        ? "Start empty, or import a repository from another registry with your own account there. Pushing to a new name also creates a repository."
        : "Start empty, or import a repository from another registry. Pushing to a new name also creates a repository.";

  return (
    <div>
      <PageHeader eyebrow={ctx.org.name} title="New repository" description={description} />
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
