// /api/v1/repos/{org}/{repo} — read (GET), update (PATCH) and delete (DELETE) a repository.
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repositories } from "@/db/schema";
import { loadRepo, requireManage, type RepoAccess } from "@/lib/api/access";
import type { ApiCaller } from "@/lib/api/auth";
import { route } from "@/lib/api/handler";
import { repoListItem } from "@/lib/api/queries";
import { enumField, iso, json, notFound, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { repoJson } from "@/lib/api/serialize";
import { recordAudit } from "@/lib/audit";
import { checkQuotaWarnings } from "@/lib/notify";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";
import { checkRepoQuota } from "@/lib/quota";
import { repositoryStorage } from "@/lib/shared-layers";
import { repoStarState } from "@/lib/stars";

export const dynamic = "force-dynamic";

type Params = { org: string; repo: string };

/** The listing document plus README, storage figures and the caller's star. */
async function repoDetail(caller: ApiCaller, a: RepoAccess) {
  const [item, storage, star] = await Promise.all([
    repoListItem(a.repo.id),
    repositoryStorage(a.repo.id),
    repoStarState(a.repo.id, caller.kind === "user" ? caller.user.id : null),
  ]);
  if (!item) throw notFound("No such repository.");
  return {
    ...repoJson(item, a.org.slug),
    createdAt: iso(a.repo.createdAt),
    readme: a.repo.readme ?? null,
    storage: {
      logicalBytes: storage.logicalBytes,
      physicalBytes: storage.physicalBytes,
      sharedBytes: storage.sharedBytes,
      sharedWithRepositories: storage.sharedWithRepos,
    },
    starred: star.starred,
  };
}

export const GET = route<Params>(async (_req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  return json(await repoDetail(caller, a));
});

export const PATCH = route<Params>(async (req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  requireManage(caller, a);
  const body = await readJson(req);
  const description = stringField(body, "description", 1000);
  const visibility = enumField(body, "visibility", ["public", "private"] as const);
  if (description === undefined && visibility === undefined) throw unprocessable('Send "description" and/or "visibility".');

  const nextVisibility = visibility ?? a.repo.visibility;
  const visibilityChanged = nextVisibility !== a.repo.visibility;
  if (visibilityChanged) {
    const quota = await checkRepoQuota(a.org.id, nextVisibility, a.org.name);
    if (quota) throw unprocessable(quota);
  }
  await db
    .update(repositories)
    .set({ description: description ?? a.repo.description, visibility: nextVisibility, updatedAt: new Date() })
    .where(eq(repositories.id, a.repo.id));
  if (visibilityChanged) after(() => checkQuotaWarnings(a.org.id).catch((err) => console.error("quota warning check failed:", err)));
  await recordAudit({
    action: visibilityChanged ? "repo.visibility" : "repo.update",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "repository",
    targetId: a.repo.id,
    targetLabel: `${a.org.slug}/${a.repo.name}`,
    details: visibilityChanged
      ? { from: a.repo.visibility, to: nextVisibility, via: "api" }
      : { description: description !== undefined && description !== a.repo.description, via: "api" },
  });
  revalidatePath(repoHref(a.org.slug, a.repo.name));
  const fresh = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  return json(await repoDetail(caller, fresh));
});

export const DELETE = route<Params>(async (req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  requireManage(caller, a, "delete this repository");
  // Cascades remove manifests, tags, links and events; orphaned blob content
  // is reclaimed by the next garbage-collection pass.
  await db.delete(repositories).where(eq(repositories.id, a.repo.id));
  await recordAudit({
    action: "repo.delete",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "repository",
    targetId: a.repo.id,
    targetLabel: `${a.org.slug}/${a.repo.name}`,
    details: { visibility: a.repo.visibility, via: "api" },
  });
  revalidatePath(`/${a.org.slug}`);
  return json({ deleted: `${a.org.slug}/${a.repo.name}` });
});
