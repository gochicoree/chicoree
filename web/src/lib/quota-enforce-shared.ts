// Pruning an over-limit scope down to its storage limit: pure planning over
// an in-memory picture of the repositories, shared by the `quota-enforce`
// job (lib/quota-enforce.ts) and its tests. No database access.
//
// Storage counts every distinct blob a live manifest in the scope references
// (layers and configs, shared blobs once), which is what the registry links
// in repository_blobs once garbage collection has run. Deleting oldest
// first: leftover untagged images, then tags by last push. Protected tags
// (tag rules) and the images they name are never touched.
import { tagFlags, type TagRuleLike } from "./tag-rules-shared";

export interface ScopeManifest {
  digest: string;
  pushedAt: Date | string;
  /** Referrers (signatures, SBOMs, attestations) point at their subject. */
  subjectDigest: string | null;
  /** Layer and config blobs with their sizes. */
  blobs: { digest: string; size: number }[];
  /** Child manifests of an index (platform variants, attestation entries). */
  children: string[];
}

export interface ScopeTag {
  name: string;
  digest: string;
  pushedAt: Date | string;
}

export interface ScopeRepository {
  id: string;
  /** "org/name" */
  path: string;
  manifests: ScopeManifest[];
  tags: ScopeTag[];
  rules: TagRuleLike[];
}

export interface PruneStep {
  repositoryId: string;
  repository: string;
  kind: "tag" | "manifest";
  /** Tag name or digest. */
  ref: string;
  reason: string;
}

export interface PrunePlan {
  /** In execution order. */
  steps: PruneStep[];
  /** Distinct blob bytes referenced before and after, over the whole scope. */
  beforeBytes: number;
  afterBytes: number;
  /** True when protected tags keep the scope above its limit even after everything else went. */
  unmet: boolean;
}

const time = (d: Date | string) => (typeof d === "string" ? new Date(d).getTime() : d.getTime());

/** Delete oldest first until the scope's blobs fit under `limitBytes`. */
export function planPruneToFit(repos: ScopeRepository[], limitBytes: number): PrunePlan {
  // Live manifests per repository, and how many live manifests reference each blob digest scope-wide.
  const live = new Map<string, Set<string>>(); // repoId → digests
  const blobSize = new Map<string, number>();
  const blobRefs = new Map<string, number>();
  const byRepo = new Map(repos.map((r) => [r.id, r]));
  const manifestOf = (repoId: string, digest: string) => byRepo.get(repoId)?.manifests.find((m) => m.digest === digest);

  for (const r of repos) {
    live.set(r.id, new Set(r.manifests.map((m) => m.digest)));
    for (const m of r.manifests) {
      for (const b of m.blobs) {
        blobSize.set(b.digest, b.size);
        blobRefs.set(b.digest, (blobRefs.get(b.digest) ?? 0) + 1);
      }
    }
  }
  const usage = () => {
    let sum = 0;
    for (const [digest, n] of blobRefs) if (n > 0) sum += blobSize.get(digest) ?? 0;
    return sum;
  };
  const beforeBytes = usage();
  const plan: PrunePlan = { steps: [], beforeBytes, afterBytes: beforeBytes, unmet: false };
  if (beforeBytes <= limitBytes) return plan;

  const tagsOf = (repoId: string, digest: string) => (byRepo.get(repoId)?.tags ?? []).filter((t) => t.digest === digest && !removedTags.get(repoId)?.has(t.name));
  const removedTags = new Map<string, Set<string>>();
  const isLive = (repoId: string, digest: string) => live.get(repoId)?.has(digest) ?? false;
  const liveParents = (repoId: string, digest: string) => (byRepo.get(repoId)?.manifests ?? []).filter((m) => isLive(repoId, m.digest) && m.children.includes(digest));
  const liveReferrers = (repoId: string, digest: string) => (byRepo.get(repoId)?.manifests ?? []).filter((m) => isLive(repoId, m.digest) && m.subjectDigest === digest);
  const isProtected = (repo: ScopeRepository, digest: string) => tagsOf(repo.id, digest).some((t) => tagFlags(repo.rules, t.name).protected);

  /** Drop a manifest and everything that only existed for it: referrers, and children no other live index needs. */
  function removeManifest(repo: ScopeRepository, digest: string, reason: string) {
    const m = manifestOf(repo.id, digest);
    if (!m || !isLive(repo.id, digest)) return;
    // Referrers first, so the registry never refuses the subject as "has referrers".
    for (const ref of liveReferrers(repo.id, digest)) removeManifest(repo, ref.digest, `attached to ${digest.slice(7, 19)}, which is removed`);
    live.get(repo.id)!.delete(digest);
    for (const b of m.blobs) blobRefs.set(b.digest, (blobRefs.get(b.digest) ?? 1) - 1);
    plan.steps.push({ repositoryId: repo.id, repository: repo.path, kind: "manifest", ref: digest, reason });
    for (const child of m.children) {
      if (!isLive(repo.id, child) || liveParents(repo.id, child).length > 0 || tagsOf(repo.id, child).length > 0) continue;
      removeManifest(repo, child, `variant of ${digest.slice(7, 19)}, which is removed`);
    }
  }

  // Phase 1: untagged leftovers, oldest first (never an index child or a referrer of something live).
  const leftovers: { repo: ScopeRepository; m: ScopeManifest }[] = [];
  for (const repo of repos) {
    for (const m of repo.manifests) {
      if (tagsOf(repo.id, m.digest).length > 0) continue;
      if (liveParents(repo.id, m.digest).length > 0) continue;
      if (m.subjectDigest && isLive(repo.id, m.subjectDigest)) continue;
      leftovers.push({ repo, m });
    }
  }
  leftovers.sort((a, b) => time(a.m.pushedAt) - time(b.m.pushedAt));
  for (const { repo, m } of leftovers) {
    if (usage() <= limitBytes) break;
    if (!isLive(repo.id, m.digest)) continue;
    removeManifest(repo, m.digest, `untagged since ${new Date(time(m.pushedAt)).toISOString().slice(0, 10)}, oldest first to fit the storage limit`);
  }

  // Phase 2: tags, oldest push first; the image goes with its last tag.
  const tags: { repo: ScopeRepository; t: ScopeTag }[] = [];
  for (const repo of repos) for (const t of repo.tags) tags.push({ repo, t });
  tags.sort((a, b) => time(a.t.pushedAt) - time(b.t.pushedAt) || a.t.name.localeCompare(b.t.name));
  for (const { repo, t } of tags) {
    if (usage() <= limitBytes) break;
    if (removedTags.get(repo.id)?.has(t.name)) continue;
    if (tagFlags(repo.rules, t.name).protected) continue;
    if (isProtected(repo, t.digest)) continue; // another, protected tag names the same image
    if (!removedTags.has(repo.id)) removedTags.set(repo.id, new Set());
    removedTags.get(repo.id)!.add(t.name);
    const when = new Date(time(t.pushedAt)).toISOString().slice(0, 10);
    plan.steps.push({ repositoryId: repo.id, repository: repo.path, kind: "tag", ref: t.name, reason: `pushed ${when}, oldest first to fit the storage limit` });
    if (tagsOf(repo.id, t.digest).length === 0 && liveParents(repo.id, t.digest).length === 0) {
      removeManifest(repo, t.digest, `its last tag ${t.name} is removed`);
    }
  }

  plan.afterBytes = usage();
  plan.unmet = plan.afterBytes > limitBytes;
  return plan;
}
