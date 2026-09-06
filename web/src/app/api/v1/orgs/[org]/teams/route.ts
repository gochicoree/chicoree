// GET /api/v1/orgs/{org}/teams — the organization's teams (members only).
// POST — create a team (owner / admin).
import { loadOrg, requireOrgManager, requireOrgMember } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { iso, json, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { createTeam, listTeams } from "@/lib/repo-access";
import { revalidatePath } from "next/cache";

export const dynamic = "force-dynamic";

export function teamJson(t: { id: string; slug: string; name: string; description: string; memberCount: number; createdAt: Date }) {
  return { id: t.id, slug: t.slug, name: t.name, description: t.description, memberCount: t.memberCount, createdAt: iso(t.createdAt) };
}

export const GET = route<{ org: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgMember(caller, a, "list the teams");
  const rows = await listTeams(a.org.id);
  return json({ items: rows.map(teamJson), total: rows.length });
});

export const POST = route<{ org: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "create teams");
  const body = await readJson(req);
  const name = stringField(body, "name", 64);
  if (!name) throw unprocessable('"name" is required.', { field: "name" });
  const res = await createTeam({
    organizationId: a.org.id,
    name,
    slug: stringField(body, "slug", 64),
    description: stringField(body, "description", 200),
    actor: caller.auditActor,
    actorUserId: caller.kind === "user" ? caller.user.id : null,
    via: "api",
  });
  if (res.error !== undefined) throw unprocessable(res.error);
  revalidatePath(`/${a.org.slug}/teams`);
  const rows = await listTeams(a.org.id);
  return json(teamJson(rows.find((t) => t.id === res.team.id)!), { status: 201 });
});
