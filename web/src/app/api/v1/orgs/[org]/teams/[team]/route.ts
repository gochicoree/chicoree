// GET / PATCH / DELETE /api/v1/orgs/{org}/teams/{team} — one team (by slug or id) with its members.
import { revalidatePath } from "next/cache";
import { loadOrg, requireOrgManager, requireOrgMember } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { iso, json, notFound, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { deleteTeam, findTeam, listTeamMembers, listTeams, updateTeam } from "@/lib/repo-access";
import { teamJson } from "../route";

export const dynamic = "force-dynamic";
type Params = { org: string; team: string };

export async function teamDetail(organizationId: string, idOrSlug: string) {
  const team = await findTeam(organizationId, idOrSlug);
  if (!team) throw notFound("No such team.");
  const [row, members] = await Promise.all([listTeams(organizationId).then((rows) => rows.find((t) => t.id === team.id)!), listTeamMembers(team.id)]);
  return {
    team,
    body: { ...teamJson(row), members: members.map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role, addedAt: iso(m.addedAt) })) },
  };
}

export const GET = route<Params>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgMember(caller, a, "see the teams");
  return json((await teamDetail(a.org.id, (params.team ?? ""))).body);
});

export const PATCH = route<Params>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "change teams");
  const { team } = await teamDetail(a.org.id, (params.team ?? ""));
  const body = await readJson(req);
  const res = await updateTeam({
    organizationId: a.org.id,
    teamId: team.id,
    name: stringField(body, "name", 64),
    slug: stringField(body, "slug", 64),
    description: stringField(body, "description", 200),
    actor: caller.auditActor,
    via: "api",
  });
  if (res.error !== undefined) throw unprocessable(res.error);
  revalidatePath(`/${a.org.slug}/teams`);
  return json((await teamDetail(a.org.id, res.team.id)).body);
});

export const DELETE = route<Params>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "delete teams");
  const { team } = await teamDetail(a.org.id, (params.team ?? ""));
  const res = await deleteTeam({ organizationId: a.org.id, teamId: team.id, actor: caller.auditActor, via: "api" });
  if (res.error !== undefined) throw notFound(res.error);
  revalidatePath(`/${a.org.slug}/teams`);
  return json({ deleted: true, team: team.slug });
});
