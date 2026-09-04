import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { queryAudit } from "@/lib/audit-query";
import { auditFilterFromParams, auditFilterQuery } from "@/lib/audit-shared";
import { AuditFilters } from "@/components/audit/audit-filters";
import { AuditTable } from "@/components/audit/audit-table";

export const metadata: Metadata = { title: "Audit log" };

/** Organization-scoped audit log for owners and admins (instance admins too). */
export default async function OrgAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  if (ctx.role !== "owner" && ctx.role !== "admin") redirect(`/${slug}`);

  const filter = { ...auditFilterFromParams(await searchParams), organizationId: ctx.org.id };
  const { rows, total, state } = await queryAudit({ filter, organizationId: ctx.org.id });
  const basePath = `/${slug}/audit`;

  return (
    <>
      <AuditFilters filter={filter} basePath={basePath} exportHref={`/api/admin/audit.csv${auditFilterQuery(filter)}`} />
      <AuditTable rows={rows} total={total} state={state} filter={filter} basePath={basePath} showOrganization={false} title={`${ctx.org.name} activity`} />
    </>
  );
}
