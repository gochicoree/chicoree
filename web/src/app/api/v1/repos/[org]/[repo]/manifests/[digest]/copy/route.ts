// POST /api/v1/repos/{org}/{repo}/manifests/{digest}/copy — copy an image addressed by digest into another repository.
import { loadRepo } from "@/lib/api/access";
import { copyImage } from "@/lib/api/copy";
import { route } from "@/lib/api/handler";
import { json, readJson, requireDigest, stringField, unprocessable } from "@/lib/api/respond";
import { decodeRepoParam } from "@/lib/proxy-shared";

export const dynamic = "force-dynamic";

export const POST = route<{ org: string; repo: string; digest: string }>(async (req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const digest = requireDigest(params.digest);
  const body = await readJson(req);
  const repository = stringField(body, "repository", 255);
  if (!repository) throw unprocessable('"repository" is required.');
  const tag = stringField(body, "tag", 128);
  if (!tag) throw unprocessable('"tag" is required when copying by digest.');
  const result = await copyImage(
    caller,
    a,
    digest,
    null,
    { organization: stringField(body, "organization", 100), repository, tag, includeArtifacts: body.includeArtifacts === undefined ? true : body.includeArtifacts !== false },
    req.headers,
  );
  return json(result, { status: 201 });
});
