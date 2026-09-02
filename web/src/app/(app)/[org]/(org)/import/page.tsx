import { notFound, redirect } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { WRITER_ROLES } from "@/lib/org-roles";
import { PageHeader } from "@/components/page-header";
import { ImportForm } from "./import-form";

export default async function ImportPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  if (!ctx.role || !WRITER_ROLES.includes(ctx.role)) redirect(`/${slug}`);

  return (
    <div>
      <PageHeader
        eyebrow={ctx.org.name}
        title="Import from another registry"
        description="Copies matching tags from a source repository into a new repository here, relabelling them on the way. The mirror stays configured so you can re-sync later."
      />
      <ImportForm organizationId={ctx.org.id} orgSlug={slug} />
    </div>
  );
}
