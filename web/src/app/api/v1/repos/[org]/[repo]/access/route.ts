// GET /api/v1/repos/{org}/{repo}/access — the grants on this repository and what the caller may do here.
import { loadRepo, requireManage } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { iso, json } from "@/lib/api/respond";
import { listRepoGrants } from "@/lib/repo-access";

export const dynamic = "force-dynamic";

export function grantJson(g: { id: string; subjectType: "user" | "team"; subjectId: string; label: string; detail: string; permission: string; createdAt: Date }) {
  return { id: g.id, subjectType: g.subjectType, subjectId: g.subjectId, name: g.label, detail: g.detail, permission: g.permission, createdAt: iso(g.createdAt) };
}

export const GET = route<{ org: string; repo: string }>(async (_req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, params.repo);
  requireManage(caller, a, "see who has access");
  const grants = await listRepoGrants(a.repo.id);
  return json({ items: grants.map(grantJson), total: grants.length, you: { role: a.role, manage: a.can.manage, write: a.can.write, delete: a.can.delete } });
});
