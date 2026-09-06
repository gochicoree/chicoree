// GET /api/v1/orgs/{org}/teams/{team}/members — who is in the team (members of the organization only).
import { loadOrg, requireOrgMember } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json } from "@/lib/api/respond";
import { teamDetail } from "../route";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string; team: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgMember(caller, a, "see the teams");
  const { body } = await teamDetail(a.org.id, (params.team ?? ""));
  return json({ items: body.members, total: body.members.length });
});
