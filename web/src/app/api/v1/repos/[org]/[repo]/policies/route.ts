// GET / PATCH /api/v1/repos/{org}/{repo}/policies — the repository's pull and signature policy overrides and what applies.
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings, repositories } from "@/db/schema";
import { loadRepo, requireManage } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json, readJson, unprocessable } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";
import { effectivePolicy, effectiveSignaturePolicy, LEVELS, refreshRepositoryBlocks, type Level } from "@/lib/pull-policy";

export const dynamic = "force-dynamic";

type Params = { org: string; repo: string };

async function policiesJson(repositoryId: string, organizationId: string) {
  const [repo, org] = await Promise.all([
    db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) }),
    db.query.organizationSettings.findFirst({ where: eq(organizationSettings.organizationId, organizationId) }),
  ]);
  const r = repo!;
  const pull = effectivePolicy(org, r);
  return {
    blockPullsAt: r.blockPullsAt ?? "inherit",
    blockUnrated: r.blockUnrated,
    requireSignature: r.requireSignature ?? "inherit",
    effective: { pullPolicy: { level: pull.level, unrated: pull.unrated }, requireSignature: effectiveSignaturePolicy(org, r) },
  };
}

export const GET = route<Params>(async (_req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  return json(await policiesJson(a.repo.id, a.org.id));
});

export const PATCH = route<Params>(async (req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  requireManage(caller, a, "change the policies");
  const body = await readJson(req);
  const set: Partial<typeof repositories.$inferInsert> = {};
  const changes: Record<string, unknown> = {};
  if ("blockPullsAt" in body) {
    const v = body.blockPullsAt;
    if (!(v === null || v === "inherit" || v === "off" || (LEVELS as string[]).includes(String(v)))) {
      throw unprocessable(`"blockPullsAt" must be "inherit", "off" or one of ${LEVELS.join(", ")}.`, { field: "blockPullsAt" });
    }
    set.blockPullsAt = v === "inherit" || v === null ? null : (v as "off" | Level);
    changes.blockPullsAt = set.blockPullsAt ?? "inherit";
  }
  if ("blockUnrated" in body) {
    const v = body.blockUnrated;
    if (v !== null && typeof v !== "boolean") throw unprocessable('"blockUnrated" must be true, false or null (inherit).', { field: "blockUnrated" });
    set.blockUnrated = v;
    changes.blockUnrated = v;
  }
  if ("requireSignature" in body) {
    const v = body.requireSignature;
    if (!(v === null || v === "inherit" || typeof v === "boolean")) throw unprocessable('"requireSignature" must be true, false or "inherit".', { field: "requireSignature" });
    set.requireSignature = v === "inherit" || v === null ? null : v;
    changes.requireSignature = set.requireSignature ?? "inherit";
  }
  if (Object.keys(set).length === 0) throw unprocessable("Send at least one of blockPullsAt, blockUnrated, requireSignature.");
  await db.update(repositories).set({ ...set, updatedAt: new Date() }).where(eq(repositories.id, a.repo.id));
  const { blocked } = await refreshRepositoryBlocks(a.repo.id);
  await recordAudit({
    action: "policy.update",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "repository",
    targetId: a.repo.id,
    targetLabel: `${a.org.slug}/${a.repo.name}`,
    details: { scope: "repository", ...changes, blocked, via: "api" },
  });
  revalidatePath(`${repoHref(a.org.slug, a.repo.name)}/settings`);
  revalidatePath(repoHref(a.org.slug, a.repo.name));
  return json({ ...(await policiesJson(a.repo.id, a.org.id)), blocked });
});
