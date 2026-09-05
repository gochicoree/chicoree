// POST /api/v1/repos/{org}/{repo}/tags/{tag}/copy — copy (promote) the tagged image into another repository.
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tags } from "@/db/schema";
import { loadRepo } from "@/lib/api/access";
import { copyImage } from "@/lib/api/copy";
import { route } from "@/lib/api/handler";
import { json, notFound, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { decodeRepoParam } from "@/lib/proxy-shared";

export const dynamic = "force-dynamic";

export const POST = route<{ org: string; repo: string; tag: string }>(async (req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const tagName = decodeURIComponent(params.tag);
  const row = await db.query.tags.findFirst({ where: and(eq(tags.repositoryId, a.repo.id), eq(tags.name, tagName)) });
  if (!row) throw notFound("No such tag.");
  const body = await readJson(req);
  const repository = stringField(body, "repository", 255);
  if (!repository) throw unprocessable('"repository" is required.');
  const result = await copyImage(
    caller,
    a,
    row.manifestDigest,
    tagName,
    {
      organization: stringField(body, "organization", 100),
      repository,
      tag: stringField(body, "tag", 128),
      includeArtifacts: body.includeArtifacts === undefined ? true : body.includeArtifacts !== false,
    },
    req.headers,
  );
  return json(result, { status: 201 });
});
