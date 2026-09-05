// POST /api/v1/repos/{org}/{repo}/manifests/{digest}/scan — queue a
// vulnerability scan of one image (instance administrators).
import { revalidatePath } from "next/cache";
import { loadRepo, requireInstanceAdmin } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { ApiError, json, requireDigest } from "@/lib/api/respond";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";
import { queueRescan } from "@/lib/rescan";

export const dynamic = "force-dynamic";

export const POST = route<{ org: string; repo: string; digest: string }>(async (req, { caller, params }) => {
  requireInstanceAdmin(caller, "queue scans");
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const digest = requireDigest(params.digest);
  const result = await queueRescan(a.repo, a.org.slug, digest, { actor: caller.auditActor, headers: req.headers, via: "api" });
  if (!result.queued) throw new ApiError("conflict", result.message, { queued: false });
  revalidatePath(repoHref(a.org.slug, a.repo.name));
  return json(result, { status: 202 });
});
