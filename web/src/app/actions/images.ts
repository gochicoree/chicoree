"use server";

// Move or copy a single image (one tag) into another repository, in this or
// any other organization. Nothing is re-uploaded: lib/image-move.ts links the
// layers with the OCI cross-repository blob mount and replays the manifests
// through registryd, so the destination gets the registry's own validation,
// quotas, events, webhooks and scans. A move deletes the source tag
// afterwards through lib/tag-admin.ts.
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, organizationProxies, repositories, tags as tagsTable } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { WRITER_ROLES } from "@/lib/org-roles";
import { checkRepoQuota, checkStorageQuota } from "@/lib/quota";
import { blobBytesNewToOrg } from "@/lib/storage-accounting";
import { checkQuotaWarnings } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { refreshRepositoryBlocks } from "@/lib/pull-policy";
import { imagePath, imageReference } from "@/lib/library";
import { env } from "@/lib/env";
import { repoHref } from "@/lib/proxy-shared";
import { repoNameProblem } from "@/lib/repo-names-shared";
import { effectiveTagRules, tagFlags } from "@/lib/tag-rules";
import { resolveDefaultVisibility } from "@/lib/visibility";
import { clearRepositoryRedirects } from "@/lib/redirects";
import { deleteTag } from "@/lib/tag-admin";
import { executeImageCopy, planImageCopy, tagDigest } from "@/lib/image-move";
import { tagNameProblem, type ImageMoveMode } from "@/lib/image-move-shared";

export interface MoveImageResult {
  error?: string;
  /** Repository page of the destination, for the redirect after success. */
  href?: string;
  /** The new `docker pull` reference, for the success toast. */
  pullReference?: string;
  /** What happened, for the toast text. */
  summary?: {
    mode: ImageMoveMode;
    destination: string;
    layersLinked: number;
    layersUploaded: number;
    manifests: number;
    artifacts: number;
    bytesAdded: number;
    /** Set when a move left the source manifest without any tag. */
    sourceUntagged: boolean;
    /** "latest" in the source repository followed the deleted tag. */
    latestMoved: string | null;
  };
}

function denied(what: string): MoveImageResult {
  return { error: `You need push access to ${what}.` };
}

async function isProxyOrg(organizationId: string): Promise<boolean> {
  return !!(await db.query.organizationProxies.findFirst({
    where: eq(organizationProxies.organizationId, organizationId),
    columns: { organizationId: true },
  }));
}

export interface DestinationOption {
  id: string;
  name: string;
  slug: string;
}

/** Repository names in an organization the caller may push to (the modal's picker). */
export async function listDestinationRepositories(organizationId: string): Promise<string[]> {
  await requireSession();
  const role = await getOrgRole(organizationId);
  if (!role || !WRITER_ROLES.includes(role)) return [];
  const rows = await db.query.repositories.findMany({
    where: eq(repositories.organizationId, organizationId),
    columns: { name: true },
    orderBy: (r, { asc }) => [asc(r.name)],
  });
  return rows.map((r) => r.name);
}

/**
 * Copy (or move) `reference` from one repository to another. `reference` is a
 * tag name or a raw digest; only a tag can be moved, since a move deletes it.
 */
export async function moveImage(formData: FormData): Promise<MoveImageResult> {
  const sourceRepositoryId = String(formData.get("sourceRepositoryId") ?? "");
  const reference = String(formData.get("reference") ?? "").trim();
  const destinationOrganizationId = String(formData.get("destinationOrganizationId") ?? "");
  const destinationRepositoryName = String(formData.get("destinationRepository") ?? "").trim();
  const destinationTag = String(formData.get("destinationTag") ?? "").trim();
  const mode: ImageMoveMode = formData.get("mode") === "move" ? "move" : "copy";

  const session = await requireSession();

  // --- Source -------------------------------------------------------------
  const sourceRepo = await db.query.repositories.findFirst({ where: eq(repositories.id, sourceRepositoryId) });
  if (!sourceRepo) return { error: "Repository not found." };
  const sourceOrg = await db.query.organization.findFirst({ where: eq(organization.id, sourceRepo.organizationId) });
  if (!sourceOrg) return { error: "Organization not found." };
  const sourceRole = await getOrgRole(sourceOrg.id);
  if (!sourceRole || !WRITER_ROLES.includes(sourceRole)) return denied(`${sourceOrg.slug}/${sourceRepo.name}`);
  if (await isProxyOrg(sourceOrg.id)) {
    return { error: `${sourceOrg.name} is a proxy cache; its images are filled from the upstream and cannot be moved.` };
  }

  const isDigestRef = reference.startsWith("sha256:");
  const sourceTag = isDigestRef ? null : reference;
  const digest = isDigestRef ? reference : await tagDigest(sourceRepo.id, reference);
  if (!digest) return { error: `Tag "${reference}" does not exist in ${sourceOrg.slug}/${sourceRepo.name}.` };
  if (mode === "move" && !sourceTag) return { error: "An image addressed by digest can only be copied, not moved." };

  // A protected source tag may be copied, never moved away.
  if (mode === "move" && sourceTag) {
    const sourceRules = await effectiveTagRules(sourceOrg.id, sourceRepo.id);
    const sourceFlags = tagFlags(sourceRules, sourceTag);
    if (sourceFlags.protected) {
      return {
        error: `"${sourceTag}" is protected by rule "${sourceFlags.protected.pattern}" and cannot be moved away. Copy it instead.`,
      };
    }
  }

  // --- Destination --------------------------------------------------------
  const destOrg = await db.query.organization.findFirst({ where: eq(organization.id, destinationOrganizationId) });
  if (!destOrg) return { error: "Destination organization not found." };
  const destRole = await getOrgRole(destOrg.id);
  if (!destRole || !WRITER_ROLES.includes(destRole)) return denied(destOrg.name);
  if (await isProxyOrg(destOrg.id)) {
    return { error: `${destOrg.name} is a proxy cache; only its upstream fills it.` };
  }
  const nameProblem = repoNameProblem(destinationRepositoryName, false);
  if (nameProblem) return { error: `Destination repository: ${nameProblem}` };
  const tagProblem = tagNameProblem(destinationTag);
  if (tagProblem) return { error: tagProblem };

  let destRepo = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, destOrg.id), eq(repositories.name, destinationRepositoryName)),
  });
  if (destRepo && destRepo.id === sourceRepo.id && destinationTag === sourceTag) {
    return { error: "The destination is the image's current place; pick another repository or tag." };
  }

  // An immutable destination tag may not be re-pointed at another image.
  if (destRepo) {
    const destRules = await effectiveTagRules(destOrg.id, destRepo.id);
    const destFlags = tagFlags(destRules, destinationTag);
    if (destFlags.immutable) {
      const current = await tagDigest(destRepo.id, destinationTag);
      if (current && current !== digest) {
        return {
          error: `${destOrg.slug}/${destRepo.name} already has an immutable tag "${destinationTag}" (rule "${destFlags.immutable.pattern}") pointing at ${current.slice(0, 19)}; pick another tag.`,
        };
      }
    }
  }

  // --- What has to travel -------------------------------------------------
  let plan;
  try {
    plan = await planImageCopy(sourceRepo.id, digest);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The image could not be read." };
  }
  const bytesAdded = await blobBytesNewToOrg(plan.blobs, destOrg.id);

  // --- Quotas, then create the repository if it is new --------------------
  const created = !destRepo;
  if (!destRepo) {
    const visibility = await resolveDefaultVisibility(destOrg.id);
    const repoQuota = await checkRepoQuota(destOrg.id, visibility, destOrg.name);
    if (repoQuota) return { error: repoQuota };
    const storage = await checkStorageQuota(destOrg.id, bytesAdded);
    if (storage) return { error: `${destOrg.name}: ${storage}` };
    const [row] = await db
      .insert(repositories)
      .values({ organizationId: destOrg.id, name: destinationRepositoryName, visibility })
      .returning();
    destRepo = row;
    // Old names of renamed / transferred repositories can be reused: the redirect ends here.
    await clearRepositoryRedirects(destOrg.id, destOrg.slug, destinationRepositoryName);
    await recordAudit({
      action: "repo.create",
      organizationId: destOrg.id,
      targetType: "repository",
      targetId: destRepo.id,
      targetLabel: `${destOrg.slug}/${destinationRepositoryName}`,
      details: { visibility, via: mode === "move" ? "image.move" : "image.copy" },
    });
  } else {
    const storage = await checkStorageQuota(destOrg.id, bytesAdded);
    if (storage) return { error: `${destOrg.name}: ${storage}` };
  }

  // --- Do it --------------------------------------------------------------
  const sourcePath = imagePath(sourceOrg.slug, sourceRepo.name);
  const destinationPath = imagePath(destOrg.slug, destRepo.name);
  let outcome;
  try {
    outcome = await executeImageCopy(plan, {
      sourcePath,
      destinationPath,
      destinationTag,
      subject: `user:${session.user.id}`,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The registry refused the image." };
  }

  // --- A move drops the source tag ---------------------------------------
  let latestMoved: string | null = null;
  let sourceUntagged = false;
  if (mode === "move" && sourceTag) {
    try {
      const removal = await deleteTag(sourceRepo.id, sourceTag, `user:${session.user.id}`);
      latestMoved = removal.latest === "moved" ? (removal.latestTarget ?? null) : null;
    } catch (err) {
      return {
        error: `Copied to ${destinationPath}:${destinationTag}, but the source tag could not be removed: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      };
    }
    // Nothing points at the source manifest any more: retention and prune deal with it.
    sourceUntagged = !(await db.query.tags.findFirst({
      where: and(eq(tagsTable.repositoryId, sourceRepo.id), eq(tagsTable.manifestDigest, digest)),
      columns: { name: true },
    }));
  }

  // --- Bookkeeping --------------------------------------------------------
  const details = {
    mode,
    from: `${sourcePath}${sourceTag ? `:${sourceTag}` : `@${digest}`}`,
    to: `${destinationPath}:${destinationTag}`,
    digest,
    fromOrganizationId: sourceOrg.id,
    toOrganizationId: destOrg.id,
    manifests: outcome.manifestsPushed,
    artifacts: outcome.artifactsCopied,
    layersLinked: outcome.mounted,
    layersUploaded: outcome.uploaded,
    bytesAdded,
    repositoryCreated: created,
  };
  const action = mode === "move" ? "image.move" : "image.copy";
  await recordAudit({
    action,
    organizationId: sourceOrg.id,
    targetType: "manifest",
    targetId: digest,
    targetLabel: `${destinationPath}:${destinationTag}`,
    details,
  });
  if (destOrg.id !== sourceOrg.id) {
    await recordAudit({
      action,
      organizationId: destOrg.id,
      targetType: "manifest",
      targetId: digest,
      targetLabel: `${destinationPath}:${destinationTag}`,
      details,
    });
  }

  const destRepoId = destRepo.id;
  after(async () => {
    // The destination's pull policy and signature policy are its own.
    await refreshRepositoryBlocks(destRepoId).catch((err) => console.error("pull policy refresh after image copy failed:", err));
    await checkQuotaWarnings(destOrg.id).catch((err) => console.error("quota warning check failed:", err));
  });

  revalidatePath(repoHref(sourceOrg.slug, sourceRepo.name));
  revalidatePath(repoHref(destOrg.slug, destRepo.name));
  revalidatePath(`/${destOrg.slug}`);
  return {
    href: repoHref(destOrg.slug, destRepo.name),
    pullReference: imageReference(env.registryHost, destOrg.slug, destRepo.name, destinationTag),
    summary: {
      mode,
      destination: `${destinationPath}:${destinationTag}`,
      layersLinked: outcome.mounted,
      layersUploaded: outcome.uploaded,
      manifests: outcome.manifestsPushed,
      artifacts: outcome.artifactsCopied,
      bytesAdded,
      sourceUntagged,
      latestMoved,
    },
  };
}
