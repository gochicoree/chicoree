import { notFound, redirect } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { WRITER_ROLES } from "@/lib/org-roles";
import { PageHeader } from "@/components/page-header";
import { NewRepositoryForm } from "./new-repository-form";
import { resolveDefaultVisibility } from "@/lib/visibility";

export default async function NewRepositoryPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  if (!ctx.role || !WRITER_ROLES.includes(ctx.role)) redirect(`/${slug}`);
  const defaultVisibility = await resolveDefaultVisibility(ctx.org.id);

  return (
    <div>
      <PageHeader
        eyebrow={ctx.org.name}
        title="New repository"
        description="You can also skip this: pushing to a new name creates the repository automatically (private by default)."
      />
      <NewRepositoryForm organizationId={ctx.org.id} orgSlug={slug} defaultVisibility={defaultVisibility} />
    </div>
  );
}
