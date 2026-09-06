// PUT / DELETE /api/v1/orgs/{org}/teams/{team}/members/{userId} — add a member of the organization to the team, or remove them.
import { revalidatePath } from "next/cache";
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json, notFound, unprocessable } from "@/lib/api/respond";
import { addTeamMember, removeTeamMember } from "@/lib/repo-access";
import { teamDetail } from "../../route";

export const dynamic = "force-dynamic";
type Params = { org: string; team: string; userId: string };

export const PUT = route<Params>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "change teams");
  const { team } = await teamDetail(a.org.id, (params.team ?? ""));
  const res = await addTeamMember({ organizationId: a.org.id, teamId: team.id, userId: (params.userId ?? ""), actor: caller.auditActor, actorUserId: caller.kind === "user" ? caller.user.id : null, via: "api" });
  if (res.error !== undefined) throw unprocessable(res.error);
  revalidatePath(`/${a.org.slug}/teams`);
  return json((await teamDetail(a.org.id, team.id)).body);
});

export const DELETE = route<Params>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "change teams");
  const { team } = await teamDetail(a.org.id, (params.team ?? ""));
  const res = await removeTeamMember({ organizationId: a.org.id, teamId: team.id, userId: (params.userId ?? ""), actor: caller.auditActor, via: "api" });
  if (res.error !== undefined) throw notFound(res.error);
  revalidatePath(`/${a.org.slug}/teams`);
  return json((await teamDetail(a.org.id, team.id)).body);
});
