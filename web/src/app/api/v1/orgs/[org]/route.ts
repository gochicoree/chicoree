// GET /api/v1/orgs/{org} — one organization with member count and storage.
import { loadOrg } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { orgDetail } from "@/lib/api/queries";
import { json } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  return json(await orgDetail(caller, a));
});
