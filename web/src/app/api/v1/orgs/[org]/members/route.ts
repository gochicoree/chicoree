// GET /api/v1/orgs/{org}/members — members and their roles (members only).
import { loadOrg, requireOrgMember } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { orgMembers } from "@/lib/api/queries";
import { iso, json } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgMember(caller, a, "list the members");
  const rows = await orgMembers(a.org.id);
  return json({
    items: rows.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role, joinedAt: iso(m.joinedAt) })),
    total: rows.length,
  });
});
