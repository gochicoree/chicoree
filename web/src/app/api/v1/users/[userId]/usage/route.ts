// GET /api/v1/users/{userId}/usage — everything the account owns against its
// limits, with the month's traffic (instance administrators).
import { requireInstanceAdmin } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { monthParam, userUsageJson } from "@/lib/api/limits";
import { json } from "@/lib/api/respond";
import { userDetail } from "@/lib/api/users";

export const dynamic = "force-dynamic";

export const GET = route<{ userId: string }>(async (_req, { caller, params, url }) => {
  requireInstanceAdmin(caller, "read usage", { read: true });
  const u = await userDetail(params.userId);
  return json(await userUsageJson(u.id, monthParam(url)));
});
