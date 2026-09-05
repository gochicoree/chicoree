// GET    /api/v1/repos/{org}/{repo}/tags/{tag} — the image the tag points at.
// DELETE /api/v1/repos/{org}/{repo}/tags/{tag} — remove the tag through the registry.
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tags } from "@/db/schema";
import { loadRepo, requireDelete } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { manifestDetail } from "@/lib/api/queries";
import { ApiError, boolParam, iso, json, notFound } from "@/lib/api/respond";
import { absolute } from "@/lib/api/serialize";
import { recordAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { imageReference } from "@/lib/library";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";
import { deleteTag } from "@/lib/tag-admin";

export const dynamic = "force-dynamic";

type Params = { org: string; repo: string; tag: string };

export const GET = route<Params>(async (_req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const tagName = decodeURIComponent(params.tag);
  const row = await db.query.tags.findFirst({ where: and(eq(tags.repositoryId, a.repo.id), eq(tags.name, tagName)) });
  if (!row) throw notFound("No such tag.");
  const doc = await manifestDetail(a, row.manifestDigest);
  if (!doc) throw notFound("No such tag.");
  return json({
    tag: tagName,
    tagPushedAt: iso(row.updatedAt),
    ...doc,
    reference: imageReference(env.registryHost, a.org.slug, a.repo.name, tagName),
    url: absolute(`${repoHref(a.org.slug, a.repo.name)}/tags/${encodeURIComponent(tagName)}`),
  });
});

export const DELETE = route<Params>(async (req, { caller, params, url }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  requireDelete(caller, a, "delete tags here");
  const tagName = decodeURIComponent(params.tag);
  let outcome;
  try {
    outcome = await deleteTag(a.repo.id, tagName, caller.subject, { moveLatest: !boolParam(url, "keep_latest", false) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not delete the tag.";
    throw new ApiError(/does not exist/i.test(message) ? "not_found" : "conflict", message);
  }
  await recordAudit({
    action: "tag.delete",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "tag",
    targetId: `${a.repo.id}:${tagName}`,
    targetLabel: `${a.org.slug}/${a.repo.name}:${tagName}`,
    details: { outcome, via: "api" },
  });
  revalidatePath(repoHref(a.org.slug, a.repo.name));
  return json(outcome);
});
