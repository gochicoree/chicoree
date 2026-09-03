import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { auditOrganizations, queryAudit } from "@/lib/audit-query";
import { auditFilterFromParams, auditFilterQuery } from "@/lib/audit-shared";
import { PageHeader } from "@/components/page-header";
import { AuditFilters } from "@/components/audit/audit-filters";
import { AuditTable } from "@/components/audit/audit-table";
import { AdminNav } from "../admin-nav";

export const metadata: Metadata = { title: "Audit log" };

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const filter = auditFilterFromParams(await searchParams);
  const [{ rows, total }, organizations] = await Promise.all([queryAudit({ filter }), auditOrganizations()]);

  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Who did what: sign-ins, organization and repository changes, credentials, settings and administrative actions."
      />
      <AdminNav />
      <AuditFilters
        filter={filter}
        basePath="/admin/audit"
        organizations={organizations}
        exportHref={`/api/admin/audit.csv${auditFilterQuery(filter)}`}
      />
      <AuditTable rows={rows} total={total} filter={filter} basePath="/admin/audit" />
    </>
  );
}
