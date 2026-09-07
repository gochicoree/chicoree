// GET /api/v1/repos/{org}/{repo}/artifacts/{digest}/packages — one page of the packages an SBOM artifact lists.
import { loadRepo } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json, notFound, paged, pageParams, requireDigest } from "@/lib/api/respond";
import { decodeRepoParam } from "@/lib/proxy-shared";
import { loadSbomPackages, pageSbomPackages } from "@/lib/sbom-packages";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string; repo: string; digest: string }>(async (_req, { caller, params, url }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const digest = requireDigest(params.digest);
  const blob = url.searchParams.get("blob");
  const list = await loadSbomPackages(a.repo, a.org.slug, digest, blob ? requireDigest(blob) : null);
  if (!list) throw notFound("No SBOM document under that digest; list the image's artifacts to find its SBOMs.");
  const { page, pageSize } = pageParams(url, { defaultSize: 100, max: 500 });
  const { items, state } = pageSbomPackages(list, url.searchParams.get("q") ?? "", page, pageSize);
  return json(paged(items, state));
});
