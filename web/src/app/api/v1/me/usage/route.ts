// GET /api/v1/me/usage — the caller's own usage across the organizations
// they own, against their account limits, with the month's traffic.
import { route } from "@/lib/api/handler";
import { monthParam, requireUserCaller, userUsageJson } from "@/lib/api/limits";
import { json } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, { caller, url }) => {
  const c = requireUserCaller(caller, "read their usage");
  return json(await userUsageJson(c.user.id, monthParam(url)));
});
