// Tag removal through the registry (so events, pull counts and garbage
// collection stay consistent), with "latest" following the newest remaining
// image when the deleted tag was the one it pointed at.
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { manifests, organization, repositories, tags as tagsTable } from "@/db/schema";
import { tagNameProblem } from "./image-move-shared";
import { env } from "./env";
import { imagePath } from "./library";
import { pickNewest } from "./mirror";
import { fetchBlobJson, fetchManifestRaw, registryErrorMessage } from "./registry-client";
import { signRegistryToken } from "./registry-jwt";
import { effectiveTagRules, protectedReason, tagFlags } from "./tag-rules";

export interface DeleteTagOutcome {
  deleted: string;
  /** What happened to "latest": it followed another tag, was removed with the last image, or was untouched. */
  latest: "moved" | "removed" | "unchanged";
  latestTarget?: string;
}

export interface RetagOutcome {
  tag: string;
  digest: string;
  /** What the tag pointed at before, null when it is new. */
  previousDigest: string | null;
  /** False when the tag already pointed at the digest (nothing was pushed). */
  changed: boolean;
}

/**
 * Point `tagName` at a manifest that already exists in the repository, by
 * pushing the stored manifest bytes under the tag (so events, webhooks and
 * scans follow as for any push). Immutable tags are refused when they would
 * move; a tag that already names the digest is left alone. Throws with a
 * user-facing message.
 */
export async function retag(repositoryId: string, tagName: string, digest: string, subject: string): Promise<RetagOutcome> {
  const problem = tagNameProblem(tagName);
  if (problem) throw new Error(problem);
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) throw new Error("Repository not found.");
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) throw new Error("Organization not found.");
  const manifest = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)),
    columns: { payload: true, mediaType: true },
  });
  if (!manifest) throw new Error("This image does not exist in the repository.");

  const [existing, rules] = await Promise.all([
    db.query.tags.findFirst({ where: and(eq(tagsTable.repositoryId, repo.id), eq(tagsTable.name, tagName)) }),
    effectiveTagRules(repo.organizationId, repo.id),
  ]);
  if (existing?.manifestDigest === digest) return { tag: tagName, digest, previousDigest: digest, changed: false };
  const flags = tagFlags(rules, tagName);
  if (existing && flags.immutable) {
    throw new Error(`Tag "${tagName}" is immutable (rule "${flags.immutable.pattern}") and already points at ${existing.manifestDigest.slice(0, 19)}.`);
  }

  const path = imagePath(org.slug, repo.name);
  const { token } = await signRegistryToken(subject, [{ type: "repository", name: path, actions: ["pull", "push"] }], 300);
  const res = await fetch(`${env.registryInternalUrl}/v2/${path}/manifests/${encodeURIComponent(tagName)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": manifest.mediaType },
    body: manifest.payload,
    cache: "no-store",
  });
  if (res.status === 403) throw new Error(`The registry refused: ${await registryErrorMessage(res)}`);
  if (res.status !== 201) throw new Error(`The registry refused the tag (HTTP ${res.status}): ${await registryErrorMessage(res)}`);
  return { tag: tagName, digest, previousDigest: existing?.manifestDigest ?? null, changed: true };
}

async function registryDelete(path: string, reference: string, token: string): Promise<Response> {
  return fetch(`${env.registryInternalUrl}/v2/${path}/manifests/${reference}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
}

/** Build date of an image from its config blob (first child for indexes). */
async function imageCreatedAt(path: string, digest: string): Promise<Date | null> {
  const raw = await fetchManifestRaw(path, digest);
  if (!raw) return null;
  let manifest = JSON.parse(raw.payload) as { config?: { digest?: string }; manifests?: { digest?: string }[] };
  if (Array.isArray(manifest.manifests)) {
    const child = manifest.manifests.find((m) => m.digest)?.digest;
    if (!child) return null;
    const childRaw = await fetchManifestRaw(path, child);
    if (!childRaw) return null;
    manifest = JSON.parse(childRaw.payload);
  }
  if (!manifest.config?.digest) return null;
  const config = (await fetchBlobJson(path, manifest.config.digest)) as { created?: string } | null;
  const created = config?.created ? new Date(config.created) : null;
  return created && !Number.isNaN(created.getTime()) ? created : null;
}

/**
 * Delete a tag as `subject` (a "user:<id>" registry subject). The caller has
 * already checked the access model; protected tags (tag rules) are refused
 * here and by the registry. Throws with a user-facing message.
 *
 * `moveLatest` (default true) re-points "latest" at the newest remaining
 * image when it named the deleted one; retention passes false so a policy
 * never changes what "latest" means.
 */
export async function deleteTag(
  repositoryId: string,
  tagName: string,
  subject: string,
  opts: { moveLatest?: boolean } = {},
): Promise<DeleteTagOutcome> {
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) throw new Error("Repository not found.");
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) throw new Error("Organization not found.");
  const path = imagePath(org.slug, repo.name);

  const [target, latest, rules] = await Promise.all([
    db.query.tags.findFirst({ where: and(eq(tagsTable.repositoryId, repo.id), eq(tagsTable.name, tagName)) }),
    db.query.tags.findFirst({ where: and(eq(tagsTable.repositoryId, repo.id), eq(tagsTable.name, "latest")) }),
    effectiveTagRules(repo.organizationId, repo.id),
  ]);
  if (!target) throw new Error(`Tag "${tagName}" does not exist.`);
  const blocked = protectedReason(rules, tagName);
  if (blocked) throw new Error(blocked);

  const { token } = await signRegistryToken(
    subject,
    [{ type: "repository", name: path, actions: ["pull", "push", "delete"] }],
    300,
  );

  const res = await registryDelete(path, tagName, token);
  if (res.status === 404) throw new Error(`Tag "${tagName}" does not exist.`);
  if (res.status === 403) throw new Error(`The registry refused: ${await registryErrorMessage(res)}`);
  if (res.status !== 202) throw new Error(`The registry refused to delete the tag (HTTP ${res.status}).`);

  // "latest" only needs attention when it pointed at the image we just untagged.
  if (opts.moveLatest === false || tagName === "latest" || !latest || latest.manifestDigest !== target.manifestDigest) {
    return { deleted: tagName, latest: "unchanged" };
  }
  // A locked "latest" stays where it is: immutable means it may not be
  // re-pointed, protected means it may not be removed.
  const latestFlags = tagFlags(rules, "latest");
  if (latestFlags.immutable || latestFlags.protected) {
    return { deleted: tagName, latest: "unchanged" };
  }

  const remaining = await db.query.tags.findMany({
    where: and(eq(tagsTable.repositoryId, repo.id), notInArray(tagsTable.name, [tagName, "latest"])),
  });
  if (remaining.length === 0) {
    const gone = await registryDelete(path, "latest", token);
    if (gone.status === 403) {
      throw new Error(`Deleted ${tagName}, but "latest" stays: ${await registryErrorMessage(gone)}`);
    }
    if (gone.status !== 202 && gone.status !== 404) {
      throw new Error(`Deleted ${tagName}, but "latest" could not be removed (HTTP ${gone.status}).`);
    }
    return { deleted: tagName, latest: "removed" };
  }

  const pick = await pickNewest(
    remaining.map((t) => ({ targetTag: t.name, digest: t.manifestDigest })),
    (digest) => imageCreatedAt(path, digest),
  );
  if (!pick) return { deleted: tagName, latest: "unchanged" };
  if (pick.digest === latest.manifestDigest) {
    // Another tag still names the same image; latest keeps pointing at it.
    return { deleted: tagName, latest: "unchanged" };
  }
  const manifest = await fetchManifestRaw(path, pick.digest);
  if (!manifest) throw new Error(`Deleted ${tagName}, but the image for "${pick.targetTag}" could not be read to move latest.`);
  const put = await fetch(`${env.registryInternalUrl}/v2/${path}/manifests/latest`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": manifest.mediaType },
    body: manifest.payload,
    cache: "no-store",
  });
  if (put.status !== 201) throw new Error(`Deleted ${tagName}, but moving latest failed (HTTP ${put.status}).`);
  return { deleted: tagName, latest: "moved", latestTarget: pick.targetTag };
}
