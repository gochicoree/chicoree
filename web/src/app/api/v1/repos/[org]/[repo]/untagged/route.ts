// GET /api/v1/repos/{org}/{repo}/untagged — manifests no tag points at.
import { loadRepo } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { boolParam, json, paged, pageParams } from "@/lib/api/respond";
import { untaggedJson } from "@/lib/api/serialize";
import { untaggedManifestsPage } from "@/lib/manifests";
import { decodeRepoParam } from "@/lib/proxy-shared";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string; repo: string }>(async (_req, { caller, params, url }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const { page, pageSize } = pageParams(url);
  const { rows, state } = await untaggedManifestsPage(a.repo.id, { page, pageSize, hideArtifacts: !boolParam(url, "include_artifacts", false) });
  return json(paged(rows.map(untaggedJson), state));
});
