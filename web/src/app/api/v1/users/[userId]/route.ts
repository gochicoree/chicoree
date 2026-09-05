// GET /api/v1/users/{userId} — one account with membership counts (instance administrators).
import { requireInstanceAdmin } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json } from "@/lib/api/respond";
import { userDetail } from "@/lib/api/users";

export const dynamic = "force-dynamic";

export const GET = route<{ userId: string }>(async (_req, { caller, params }) => {
  requireInstanceAdmin(caller, "read users", { read: true });
  return json(await userDetail(params.userId));
});
