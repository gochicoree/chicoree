// GET /api/v1/orgs/{org}/usage — repositories, storage and members against the
// organization's limits, plus the month's traffic.
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { monthParam, orgUsageJson } from "@/lib/api/limits";
import { json } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string }>(async (_req, { caller, params, url }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "read the usage");
  return json(await orgUsageJson(a.org, monthParam(url)));
});
