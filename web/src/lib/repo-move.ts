// Moving a repository to another organization — the single source of truth
// for the rules, shared by the repository danger zone
// (app/actions/repo-tools.ts) and the administrator's bulk screen
// (app/actions/bulk-move.ts, /admin/organizations/move).
//
// A move is split in two halves so a caller can show a preview:
//   planRepositoryMove()          — every check, no writes at all
//   moveRepositoryToOrganization()— re-checks, then performs the move
// Both return the same shape; `ok` says whether the move may happen and
// `message` carries the human-readable reason when it may not.
//
// What a move does: re-homes the repository row, its repository-scoped tag
// rules and retention policies, leaves a `repository_redirects` row so the
// old `org/name` keeps serving pulls, refreshes the pull-policy blocks (the
// target organization's policy applies now), audits in both organizations
// and emits a `repository.transferred` webhook.
import { after } from "next/server";
import { repositoryBytesNewToOrg as bytesNewToOrg } from "@/lib/storage-accounting";
import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organization, organizationProxies, repositories, retentionPolicies, tagRules } from "@/db/schema";
import { getOrgRole } from "./session";
import { MANAGER_ROLES } from "./org-roles";
import { checkRepoQuota, checkStorageQuota } from "./quota";
import { checkQuotaWarnings } from "./notify";
import { recordAudit } from "./audit";
import { emitRepositoryEvent } from "./webhooks";
import { refreshRepositoryBlocks } from "./pull-policy";
import { imageReference } from "./library";
import { env } from "./env";
import { repoHref } from "./proxy-shared";
import { repoNameProblem } from "./repo-names-shared";
import { addRepositoryRedirect, clearRepositoryRedirects } from "./redirects";
import { MAX_BULK_MOVE, type MoveSkipCode } from "./repo-move-shared";

export { MAX_BULK_MOVE };
export type { MoveSkipCode };

/** Who is moving. Instance administrators manage every organization. */
export interface MoveActor {
  userId: string;
  userName?: string | null;
  isAdmin: boolean;
}

export interface MoveOrgRef {
  id: string;
  slug: string;
  name: string;
}

export interface MovePlan {
  repositoryId: string;
  /** Empty when the repository row is gone. */
  repositoryName: string;
  visibility: "public" | "private";
  source: MoveOrgRef | null;
  target: MoveOrgRef | null;
  /** The move may proceed. */
  ok: boolean;
  code: MoveSkipCode | null;
  /** Human-readable reason when `ok` is false. */
  message: string | null;
  /** Bytes of this repository's blobs the target does not hold yet. */
  bytesNew: number;
}

export interface MoveResult extends MovePlan {
  /** The move actually happened. */
  moved: boolean;
  /** Where the client should navigate afterwards. */
  href?: string;
  /** The new `docker pull` reference. */
  pullReference?: string;
}

export interface MoveInput {
  repositoryId: string;
  targetOrganizationId: string;
  actor: MoveActor;
  /**
   * Repositories moved earlier in the same batch. Their blobs are treated as
   * already present in the target, so a preview does not count a shared layer
   * twice, and their headcount is added to the target's repository quota.
   * Empty for a single move (and unused when actually performing one, where
   * the earlier moves are already committed).
   */
  batch?: BatchContext;
}

/** Accumulated effect of earlier entries of a preview run on the target. */
export interface BatchContext {
  /** Repository ids already planned to move into this target. */
  repositoryIds: string[];
  /** Names already claimed in the target by earlier entries. */
  names: Set<string>;
  pendingPublic: number;
  pendingPrivate: number;
  pendingBytes: number;
}

export function newBatchContext(): BatchContext {
  return { repositoryIds: [], names: new Set(), pendingPublic: 0, pendingPrivate: 0, pendingBytes: 0 };
}

function fail(plan: Omit<MovePlan, "ok" | "code" | "message">, code: MoveSkipCode, message: string): MovePlan {
  return { ...plan, ok: false, code, message };
}

async function isProxyOrg(organizationId: string): Promise<boolean> {
  return !!(await db.query.organizationProxies.findFirst({
    where: eq(organizationProxies.organizationId, organizationId),
    columns: { organizationId: true },
  }));
}

/** Does the actor manage the organization? Instance admins manage all of them. */
async function manages(organizationId: string, actor: MoveActor): Promise<boolean> {
  if (actor.isAdmin) return true;
  const role = await getOrgRole(organizationId);
  return !!role && MANAGER_ROLES.includes(role);
}

/**
 * Every check a move performs, without writing anything. The messages match
 * the ones the single-repository transfer has always shown.
 */
export async function planRepositoryMove({ repositoryId, targetOrganizationId, actor, batch }: MoveInput): Promise<MovePlan> {
  const base = {
    repositoryId,
    repositoryName: "",
    visibility: "private" as "public" | "private",
    source: null as MoveOrgRef | null,
    target: null as MoveOrgRef | null,
    bytesNew: 0,
  };

  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return fail(base, "repository-missing", "Repository not found.");
  base.repositoryName = repo.name;
  base.visibility = repo.visibility;

  if (!(await manages(repo.organizationId, actor))) {
    return fail(base, "denied", "You don't have permission to do that in this organization.");
  }
  const [source, target] = await Promise.all([
    db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) }),
    db.query.organization.findFirst({ where: eq(organization.id, targetOrganizationId) }),
  ]);
  if (!source || !target) return fail(base, "organization-missing", "Organization not found.");
  base.source = { id: source.id, slug: source.slug, name: source.name };
  base.target = { id: target.id, slug: target.slug, name: target.name };

  if (target.id === source.id) return fail(base, "same-organization", "The repository is already in that organization.");
  if (!(await manages(target.id, actor))) {
    return fail(base, "target-denied", `You need to be an owner or admin of ${target.name} to move a repository there.`);
  }
  if (await isProxyOrg(source.id)) return fail(base, "source-proxy", "Repositories in a proxy cache cannot be moved.");
  if (await isProxyOrg(target.id)) return fail(base, "target-proxy", `${target.name} is a proxy cache; only its upstream fills it.`);

  const problem = repoNameProblem(repo.name, false);
  if (problem) return fail(base, "invalid-name", `The name ${repo.name} is not valid in ${target.slug}: ${problem}`);

  const taken = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, target.id), eq(repositories.name, repo.name)),
    columns: { id: true },
  });
  if (taken || batch?.names.has(repo.name)) {
    return fail(base, "name-taken", `${target.slug} already has a repository named ${repo.name}; rename one of them first.`);
  }

  const pending = repo.visibility === "public" ? (batch?.pendingPublic ?? 0) : (batch?.pendingPrivate ?? 0);
  const quota = await checkRepoQuota(target.id, repo.visibility, target.name, pending);
  if (quota) return fail(base, "repository-quota", quota);

  base.bytesNew = await bytesNewToOrg(repo.id, target.id, batch?.repositoryIds ?? []);
  const storage = await checkStorageQuota(target.id, base.bytesNew + (batch?.pendingBytes ?? 0));
  if (storage) return fail(base, "storage-quota", `${target.name}: ${storage}`);

  return { ...base, ok: true, code: null, message: null };
}

/** Fold an accepted plan into the batch context so the next plan sees it. */
export function applyToBatch(batch: BatchContext, plan: MovePlan): void {
  if (!plan.ok) return;
  batch.repositoryIds.push(plan.repositoryId);
  batch.names.add(plan.repositoryName);
  batch.pendingBytes += plan.bytesNew;
  if (plan.visibility === "public") batch.pendingPublic += 1;
  else batch.pendingPrivate += 1;
}

/**
 * Preview a whole run: the plans in order, with the batch effects (shared
 * layers, name claims, quota headroom) accounted for. Writes nothing.
 */
export async function planBulkMove(
  repositoryIds: string[],
  targetOrganizationId: string,
  actor: MoveActor,
): Promise<MovePlan[]> {
  const batch = newBatchContext();
  const plans: MovePlan[] = [];
  for (const id of repositoryIds) {
    const plan = await planRepositoryMove({ repositoryId: id, targetOrganizationId, actor, batch });
    applyToBatch(batch, plan);
    plans.push(plan);
  }
  return plans;
}

/**
 * Move a repository to another organization. The caller must manage both
 * (instance admins manage everything); the target's repository and storage
 * quotas apply as for a new push there.
 */
export async function moveRepositoryToOrganization(input: MoveInput): Promise<MoveResult> {
  const plan = await planRepositoryMove(input);
  if (!plan.ok || !plan.source || !plan.target) return { ...plan, moved: false };
  const { source, target } = plan;
  const { actor } = input;
  const name = plan.repositoryName;

  await db.transaction(async (tx) => {
    await tx.update(repositories).set({ organizationId: target.id, updatedAt: new Date() }).where(eq(repositories.id, plan.repositoryId));
    // Repository-scoped rules and policies belong to the repository and move
    // with it (their organization column must follow the row).
    await tx.update(tagRules).set({ organizationId: target.id }).where(eq(tagRules.repositoryId, plan.repositoryId));
    await tx.update(retentionPolicies).set({ organizationId: target.id }).where(eq(retentionPolicies.repositoryId, plan.repositoryId));
    await clearRepositoryRedirects(target.id, target.slug, name, tx);
    await addRepositoryRedirect(source.slug, name, plan.repositoryId, actor.userId, tx);
  });

  const details = {
    from: `${source.slug}/${name}`,
    to: `${target.slug}/${name}`,
    fromOrganizationId: source.id,
    toOrganizationId: target.id,
    visibility: plan.visibility,
    bytesAdded: plan.bytesNew,
  };
  await recordAudit({ action: "repo.transfer", organizationId: source.id, targetType: "repository", targetId: plan.repositoryId, targetLabel: `${target.slug}/${name}`, details });
  await recordAudit({ action: "repo.transfer", organizationId: target.id, targetType: "repository", targetId: plan.repositoryId, targetLabel: `${target.slug}/${name}`, details });
  after(async () => {
    // The pull policy is the target organization's now.
    await refreshRepositoryBlocks(plan.repositoryId).catch((err) => console.error("pull policy refresh after transfer failed:", err));
    await checkQuotaWarnings(target.id).catch((err) => console.error("quota warning check failed:", err));
    await emitRepositoryEvent(plan.repositoryId, "repository.transferred", {
      previous: { organization: source.slug, name, path: `${source.slug}/${name}` },
      actor: { type: "user", id: actor.userId, name: actor.userName ?? null },
    }).catch((err) => console.error("repository.transferred webhook failed:", err));
  });
  revalidatePath(`/${source.slug}`);
  revalidatePath(`/${target.slug}`);
  revalidatePath(repoHref(source.slug, name));
  revalidatePath(repoHref(target.slug, name));

  return {
    ...plan,
    moved: true,
    href: repoHref(target.slug, name),
    pullReference: imageReference(env.registryHost, target.slug, name),
  };
}

// --- Data for the administrator's bulk screen -------------------------------

export interface MovableRepo {
  id: string;
  name: string;
  organizationId: string;
  orgSlug: string;
  orgName: string;
  visibility: "public" | "private";
  sizeBytes: number;
  tagCount: number;
  /** In a proxy-cache organization: it can never be moved. */
  proxy: boolean;
}

/** Every repository on the instance, for the administrator's bulk move screen. */
export async function listAllRepositories(): Promise<MovableRepo[]> {
  const { rows } = await db.execute(sql`
    SELECT r.id, r.name, r.visibility, r.organization_id, o.slug AS org_slug, o.name AS org_name,
      (SELECT count(*)::int FROM tags t WHERE t.repository_id = r.id) AS tag_count,
      COALESCE((SELECT sum(b.size)::bigint FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest
        WHERE rb.repository_id = r.id), 0) AS size_bytes,
      EXISTS (SELECT 1 FROM organization_proxies p WHERE p.organization_id = r.organization_id) AS is_proxy
    FROM repositories r JOIN organization o ON o.id = r.organization_id
    ORDER BY o.slug, r.name`);
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    organizationId: r.organization_id as string,
    orgSlug: r.org_slug as string,
    orgName: r.org_name as string,
    visibility: r.visibility as "public" | "private",
    sizeBytes: Number(r.size_bytes),
    tagCount: Number(r.tag_count),
    proxy: !!r.is_proxy,
  }));
}
