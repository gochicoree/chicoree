// GET /api/v1/users/{userId}/organizations — the account's memberships (instance administrators).
import { requireInstanceAdmin } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json } from "@/lib/api/respond";
import { userDetail, userOrganizations } from "@/lib/api/users";

export const dynamic = "force-dynamic";

export const GET = route<{ userId: string }>(async (_req, { caller, params }) => {
  requireInstanceAdmin(caller, "read users", { read: true });
  const u = await userDetail(params.userId);
  const items = await userOrganizations(u.id);
  return json({ user: u.id, items, total: items.length });
});
