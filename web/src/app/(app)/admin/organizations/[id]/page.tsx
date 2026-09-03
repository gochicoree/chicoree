import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationLimits } from "@/db/schema";
import { getAdminOrgDetail } from "@/lib/admin-data";
import { UsageMeter } from "@/components/admin/usage-meter";
import { LimitsForm } from "@/components/admin/limits-form";

export default async function AdminOrganizationOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getAdminOrgDetail(id);
  if (!detail) notFound();
  const { org, usage, limits } = detail;
  const limitsRow = await db.query.organizationLimits.findFirst({ where: eq(organizationLimits.organizationId, org.id) });

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <UsageMeter label="Public repositories" used={usage.publicRepos} limit={limits.maxPublicRepos} />
        <UsageMeter label="Private repositories" used={usage.privateRepos} limit={limits.maxPrivateRepos} />
        <UsageMeter label="Storage" used={usage.storageBytes} limit={limits.maxStorageBytes} bytes />
      </div>
      <LimitsForm scope="organization" targetId={org.id} limits={limits} note={limitsRow?.note ?? ""} />
    </div>
  );
}
