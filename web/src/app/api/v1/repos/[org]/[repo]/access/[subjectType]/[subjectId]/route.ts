// PUT / DELETE /api/v1/repos/{org}/{repo}/access/{user|team}/{id} — grant a permission to a person or a team, or remove it.
import { revalidatePath } from "next/cache";
import { loadRepo, requireManage } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { enumField, json, notFound, readJson, unprocessable } from "@/lib/api/respond";
import { removeRepoGrant, setRepoGrant } from "@/lib/repo-access";
import { repoHref } from "@/lib/proxy-shared";
import { grantJson } from "../../route";

export const dynamic = "force-dynamic";
type Params = { org: string; repo: string; subjectType: string; subjectId: string };

function subject(params: Params): "user" | "team" {
  if (params.subjectType !== "user" && params.subjectType !== "team") throw notFound("The subject is /access/user/{userId} or /access/team/{teamId}.");
  return params.subjectType;
}

export const PUT = route<Params>(async (req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, params.repo);
  requireManage(caller, a, "change access");
  const body = await readJson(req);
  const permission = enumField(body, "permission", ["pull", "push", "admin"] as const);
  if (!permission) throw unprocessable('"permission" must be pull, push or admin.', { field: "permission" });
  const res = await setRepoGrant({
    repositoryId: a.repo.id,
    organizationId: a.org.id,
    subjectType: subject(params),
    subjectId: (params.subjectId ?? ""),
    permission,
    actor: caller.auditActor,
    actorUserId: caller.kind === "user" ? caller.user.id : null,
    via: "api",
  });
  if (res.error !== undefined) throw unprocessable(res.error);
  revalidatePath(`${repoHref(a.org.slug, a.repo.name)}/settings/access`);
  return json(res.grant ? grantJson(res.grant) : { ok: true });
});

export const DELETE = route<Params>(async (_req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, params.repo);
  requireManage(caller, a, "change access");
  const res = await removeRepoGrant({ repositoryId: a.repo.id, organizationId: a.org.id, subjectType: subject(params), subjectId: (params.subjectId ?? ""), actor: caller.auditActor, via: "api" });
  if (res.error !== undefined) throw notFound(res.error);
  revalidatePath(`${repoHref(a.org.slug, a.repo.name)}/settings/access`);
  return json({ deleted: true });
});
