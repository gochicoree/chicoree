// Copy (promote) an image into another repository through the API: the
// same rules as the "Move image" dialog — writer rights on both sides, no
// proxy caches, tag rules, quotas, the destination created on demand —
// with API errors instead of form messages.
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { repositories } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { executeImageCopy, planImageCopy, tagDigest } from "@/lib/image-move";
import { tagNameProblem } from "@/lib/image-move-shared";
import { imagePath } from "@/lib/library";
import { checkQuotaWarnings } from "@/lib/notify";
import { checkRepoQuota, checkStorageQuota } from "@/lib/quota";
import { clearRepositoryRedirects } from "@/lib/redirects";
import { repoNameProblem } from "@/lib/repo-names-shared";
import { blobBytesNewToOrg } from "@/lib/storage-accounting";
import { effectiveTagRules, tagFlags } from "@/lib/tag-rules";
import { after } from "next/server";
import { loadOrg, loadRepo, requireOrgWriter, requireWrite, type RepoAccess } from "./access";
import type { ApiCaller } from "./auth";
import { defaultVisibility } from "./queries";
import { conflict, notFound, unprocessable } from "./respond";

export interface CopyRequest {
  /** Destination organization slug; defaults to the source organization. */
  organization?: string;
  repository: string;
  /** Destination tag; defaults to the source tag (required when copying by digest). */
  tag?: string;
  includeArtifacts?: boolean;
}

export async function copyImage(
  c: ApiCaller,
  source: RepoAccess,
  digest: string,
  sourceTag: string | null,
  req: CopyRequest,
  headers: Headers,
) {
  requireWrite(c, source, "copy images from here");
  const destSlug = (req.organization ?? source.org.slug).trim();
  const destName = req.repository.trim();
  const destTag = (req.tag ?? sourceTag ?? "").trim();
  if (!destTag) throw unprocessable('"tag" is required when the source is addressed by digest.');
  const tagProblem = tagNameProblem(destTag);
  if (tagProblem) throw unprocessable(tagProblem, { field: "tag" });

  const dest = await loadOrg(c, destSlug);
  if (dest.proxy) throw unprocessable(`${dest.org.name} is a proxy cache; only its upstream fills it.`);
  const nameProblem = repoNameProblem(destName, false);
  if (nameProblem) throw unprocessable(`Destination repository: ${nameProblem}`, { field: "repository" });

  let destRepo = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, dest.org.id), eq(repositories.name, destName)),
  });
  if (destRepo) {
    const access = await loadRepo(c, dest.org.slug, destRepo.name);
    requireWrite(c, access, `push to ${dest.org.slug}/${destRepo.name}`);
  } else {
    requireOrgWriter(c, dest, `create repositories in ${dest.org.slug}`);
  }
  if (destRepo && destRepo.id === source.repo.id && destTag === sourceTag) {
    throw conflict("The destination is the image's current place; pick another repository or tag.");
  }

  // An immutable destination tag may not be re-pointed at another image.
  if (destRepo) {
    const flags = tagFlags(await effectiveTagRules(dest.org.id, destRepo.id), destTag);
    if (flags.immutable) {
      const current = await tagDigest(destRepo.id, destTag);
      if (current && current !== digest) {
        throw conflict(`${dest.org.slug}/${destRepo.name} already has an immutable tag "${destTag}" (rule "${flags.immutable.pattern}") pointing at ${current.slice(0, 19)}.`);
      }
    }
  }

  let plan;
  try {
    plan = await planImageCopy(source.repo.id, digest, { includeArtifacts: req.includeArtifacts !== false });
  } catch (err) {
    throw notFound(err instanceof Error ? err.message : "The image could not be read.");
  }
  const bytesAdded = await blobBytesNewToOrg(plan.blobs, dest.org.id);

  const created = !destRepo;
  if (!destRepo) {
    const visibility = await defaultVisibility(dest.org.id, c.kind === "user" ? c.user.id : null);
    const repoQuota = await checkRepoQuota(dest.org.id, visibility, dest.org.name);
    if (repoQuota) throw unprocessable(repoQuota);
    const storage = await checkStorageQuota(dest.org.id, bytesAdded);
    if (storage) throw unprocessable(`${dest.org.name}: ${storage}`);
    const [row] = await db.insert(repositories).values({ organizationId: dest.org.id, name: destName, visibility }).returning();
    destRepo = row;
    await clearRepositoryRedirects(dest.org.id, dest.org.slug, destName);
    await recordAudit({
      action: "repo.create",
      actor: c.auditActor,
      headers,
      organizationId: dest.org.id,
      targetType: "repository",
      targetId: destRepo.id,
      targetLabel: `${dest.org.slug}/${destName}`,
      details: { visibility, via: "api", reason: "image.copy" },
    });
  } else {
    const storage = await checkStorageQuota(dest.org.id, bytesAdded);
    if (storage) throw unprocessable(`${dest.org.name}: ${storage}`);
  }

  const sourcePath = imagePath(source.org.slug, source.repo.name);
  const destinationPath = imagePath(dest.org.slug, destRepo.name);
  let outcome;
  try {
    outcome = await executeImageCopy(plan, { sourcePath, destinationPath, destinationTag: destTag, subject: c.subject });
  } catch (err) {
    throw conflict(err instanceof Error ? err.message : "The registry refused the image.");
  }
  const from = `${sourcePath}${sourceTag ? `:${sourceTag}` : `@${digest}`}`;
  const to = `${destinationPath}:${destTag}`;
  await recordAudit({
    action: "image.copy",
    actor: c.auditActor,
    headers,
    organizationId: source.org.id,
    targetType: "manifest",
    targetId: digest,
    targetLabel: from,
    details: { to, digest, toOrganizationId: dest.org.id, ...outcome, via: "api" },
  });
  after(() => checkQuotaWarnings(dest.org.id).catch((err) => console.error("quota warning check failed:", err)));
  return {
    from,
    to,
    digest,
    destination: { organization: dest.org.slug, repository: destRepo.name, tag: destTag, created },
    blobsMounted: outcome.mounted,
    blobsUploaded: outcome.uploaded,
    manifestsPushed: outcome.manifestsPushed,
    artifactsCopied: outcome.artifactsCopied,
  };
}
