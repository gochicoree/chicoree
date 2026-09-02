import { notFound, redirect } from "next/navigation";
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

  return (
    <div>
      <PageHeader
        eyebrow={ctx.org.name}
        title="New repository"
        description="Start empty and push to it, or mirror a repository from another registry — the repository, the mirror and the first sync are set up together. Pushing to a new name also creates a repository automatically."
      />
      <RepositorySetup
        organizationId={ctx.org.id}
        orgSlug={slug}
        defaultVisibility={defaultVisibility}
        initialMode={mode === "mirror" ? "mirror" : "empty"}
      />
    </div>
  );
}
