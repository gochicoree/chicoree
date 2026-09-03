import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization } from "@/db/schema";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DeleteOrganization } from "../org-controls";

export default async function AdminOrganizationDanger({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await db.query.organization.findFirst({ where: eq(organization.id, id) });
  if (!org) notFound();

  return (
    <Card className="border-danger/30">
      <CardHeader
        eyebrow="Danger"
        title="Delete this organization"
        description="Removes members, repositories, images and service accounts. Blob content is reclaimed by the next garbage collection."
        action={<Badge tone="danger">irreversible</Badge>}
      />
      <DeleteOrganization organizationId={org.id} slug={org.slug} />
    </Card>
  );
}
