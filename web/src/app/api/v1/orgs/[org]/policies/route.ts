// GET / PATCH /api/v1/orgs/{org}/policies — default visibility, pull policy, signature policy, member keys.
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings } from "@/db/schema";
import { loadOrg, requireOrgManager, requireOrgMember } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { enumField, json, readJson, unprocessable } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";
import { LEVELS, refreshOrganizationBlocks } from "@/lib/pull-policy";
import { reverifyOrganization } from "@/lib/signatures";

export const dynamic = "force-dynamic";

async function policiesJson(organizationId: string) {
  const s = await db.query.organizationSettings.findFirst({ where: eq(organizationSettings.organizationId, organizationId) });
  return {
    defaultVisibility: s?.defaultVisibility ?? null,
    pullPolicy: { blockPullsAt: s?.blockPullsAt ?? null, blockUnrated: s?.blockUnrated ?? false },
    requireSignature: s?.requireSignature ?? false,
    trustMemberKeys: s?.trustMemberKeys ?? true,
  };
}

export const GET = route<{ org: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgMember(caller, a, "read the policies");
  return json(await policiesJson(a.org.id));
});

function boolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw unprocessable(`"${key}" must be true or false.`, { field: key });
  return v;
}

export const PATCH = route<{ org: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "change the policies");
  const body = await readJson(req);
  const set: Partial<typeof organizationSettings.$inferInsert> = {};
  const changes: Record<string, unknown> = {};

  if ("defaultVisibility" in body) {
    const v = body.defaultVisibility;
    if (v !== null && v !== "public" && v !== "private") throw unprocessable('"defaultVisibility" must be "public", "private" or null.', { field: "defaultVisibility" });
    set.defaultVisibility = v;
    changes.defaultVisibility = v;
  }
  if ("blockPullsAt" in body) {
    const v = body.blockPullsAt;
    if (v !== null && !(LEVELS as string[]).includes(String(v))) throw unprocessable(`"blockPullsAt" must be one of ${LEVELS.join(", ")} or null.`, { field: "blockPullsAt" });
    set.blockPullsAt = v as (typeof LEVELS)[number] | null;
    changes.blockPullsAt = v;
  }
  const blockUnrated = boolField(body, "blockUnrated");
  if (blockUnrated !== undefined) (set.blockUnrated = blockUnrated), (changes.blockUnrated = blockUnrated);
  const requireSignature = boolField(body, "requireSignature");
  if (requireSignature !== undefined) (set.requireSignature = requireSignature), (changes.requireSignature = requireSignature);
  const trustMemberKeys = boolField(body, "trustMemberKeys");
  if (trustMemberKeys !== undefined) (set.trustMemberKeys = trustMemberKeys), (changes.trustMemberKeys = trustMemberKeys);
  void enumField;
  if (Object.keys(set).length === 0) throw unprocessable("Send at least one of defaultVisibility, blockPullsAt, blockUnrated, requireSignature, trustMemberKeys.");

  await db
    .insert(organizationSettings)
    .values({ organizationId: a.org.id, ...set, updatedAt: new Date() })
    .onConflictDoUpdate({ target: organizationSettings.organizationId, set: { ...set, updatedAt: new Date() } });
  if ("blockPullsAt" in changes || "blockUnrated" in changes || "requireSignature" in changes) await refreshOrganizationBlocks(a.org.id);
  if ("trustMemberKeys" in changes) await reverifyOrganization(a.org.id);
  await recordAudit({
    action: "policy.update",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "organization",
    targetId: a.org.id,
    targetLabel: a.org.slug,
    details: { scope: "organization", ...changes, via: "api" },
  });
  revalidatePath(`/${a.org.slug}/settings`);
  revalidatePath(`/${a.org.slug}`, "layout");
  return json(await policiesJson(a.org.id));
});
