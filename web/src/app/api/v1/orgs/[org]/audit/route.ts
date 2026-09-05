// GET /api/v1/orgs/{org}/audit — the organization's audit log (owners and admins).
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json, paged, pageParams } from "@/lib/api/respond";
import { auditJson } from "@/lib/api/serialize";
import { queryAudit } from "@/lib/audit-query";
import { auditFilterFromParams } from "@/lib/audit-shared";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string }>(async (_req, { caller, params, url }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "read the audit log");
  const { page, pageSize } = pageParams(url);
  const filter = { ...auditFilterFromParams(url.searchParams), organizationId: a.org.id, page };
  const { rows, state } = await queryAudit({ filter, organizationId: a.org.id, limit: pageSize });
  return json(paged(rows.map(auditJson), state));
});
