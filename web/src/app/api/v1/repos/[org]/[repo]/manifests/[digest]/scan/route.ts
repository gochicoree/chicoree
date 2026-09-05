// GET  /api/v1/repos/{org}/{repo}/manifests/{digest}/scan — the scan gate: current result, judged against a threshold, optionally waited for.
// POST /api/v1/repos/{org}/{repo}/manifests/{digest}/scan — queue a vulnerability scan (instance administrators), optionally wait for it.
import { revalidatePath } from "next/cache";
import { loadRepo, requireInstanceAdmin } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { ApiError, json, requireDigest } from "@/lib/api/respond";
import { gateOptions, scanGate } from "@/lib/api/scan-gate";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";
import { queueRescan } from "@/lib/rescan";

export const dynamic = "force-dynamic";

type Params = { org: string; repo: string; digest: string };

export const GET = route<Params>(async (_req, { caller, params, url }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  return json(await scanGate(a, requireDigest(params.digest), gateOptions(url)));
});

export const POST = route<Params>(async (req, { caller, params, url }) => {
  requireInstanceAdmin(caller, "queue scans");
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const digest = requireDigest(params.digest);
  const opts = gateOptions(url);
  const result = await queueRescan(a.repo, a.org.slug, digest, { actor: caller.auditActor, headers: req.headers, via: "api" });
  if (!result.queued) throw new ApiError("conflict", result.message, { queued: false });
  revalidatePath(repoHref(a.org.slug, a.repo.name));
  if (opts.waitSeconds === 0) return json({ queued: true, message: result.message }, { status: 202 });
  const gate = await scanGate(a, digest, opts);
  return json({ queued: true, message: result.message, ...gate }, { status: 200 });
});
