// GET    /api/v1/repos/{org}/{repo}/manifests/{digest} — the image document.
// DELETE /api/v1/repos/{org}/{repo}/manifests/{digest} — delete by digest, tags included.
import { revalidatePath } from "next/cache";
import { loadRepo, requireDelete } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { manifestDetail } from "@/lib/api/queries";
import { ApiError, json, notFound, requireDigest } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";
import { deleteManifestByDigest } from "@/lib/manifests";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";

export const dynamic = "force-dynamic";

type Params = { org: string; repo: string; digest: string };

export const GET = route<Params>(async (_req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const doc = await manifestDetail(a, requireDigest(params.digest));
  if (!doc) throw notFound("No such image in this repository.");
  return json(doc);
});

export const DELETE = route<Params>(async (req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  requireDelete(caller, a);
  const digest = requireDigest(params.digest);
  let outcome;
  try {
    outcome = await deleteManifestByDigest(a.repo.id, digest, caller.subject);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not delete the image.";
    throw new ApiError(/does not exist/i.test(message) ? "not_found" : "conflict", message);
  }
  await recordAudit({
    action: "image.delete",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "manifest",
    targetId: digest,
    targetLabel: `${a.org.slug}/${a.repo.name}@${digest.slice(0, 19)}`,
    details: { tags: outcome.tags, via: "api" },
  });
  revalidatePath(repoHref(a.org.slug, a.repo.name), "layout");
  return json(outcome);
});
