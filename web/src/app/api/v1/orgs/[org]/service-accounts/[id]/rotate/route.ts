// POST /api/v1/orgs/{org}/service-accounts/{id}/rotate — a fresh secret, same account.
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { serviceAccounts } from "@/db/schema";
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { iso, json, notFound, unprocessable } from "@/lib/api/respond";
import { serviceAccountJson, serviceAccountRows } from "@/lib/api/service-accounts";
import { recordAudit } from "@/lib/audit";
import { getInstanceSettings } from "@/lib/instance-settings";
import { generateSecret, SA_PREFIX } from "@/lib/secrets";
import { replacementExpiry } from "@/lib/token-policy-shared";

export const dynamic = "force-dynamic";

export const POST = route<{ org: string; id: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "rotate service accounts");
  const sa = await db.query.serviceAccounts.findFirst({ where: and(eq(serviceAccounts.id, params.id), eq(serviceAccounts.organizationId, a.org.id)) });
  if (!sa) throw notFound("No such service account.");
  const { access } = await getInstanceSettings();
  const expiry = replacementExpiry(sa.createdAt, sa.expiresAt, { maxTokenLifetimeDays: access.maxTokenLifetimeDays, requireTokenExpiry: access.requireTokenExpiry });
  if ("error" in expiry) throw unprocessable(expiry.error);
  const { secret, hash, display } = generateSecret(SA_PREFIX);
  await db
    .update(serviceAccounts)
    .set({ tokenHash: hash, tokenPrefix: display, expiresAt: expiry.expiresAt, lastUsedAt: null, lastUsedIp: null })
    .where(eq(serviceAccounts.id, sa.id));
  await recordAudit({ action: "sa.rotate", actor: caller.auditActor, headers: req.headers, organizationId: a.org.id, targetType: "service_account", targetId: sa.id, targetLabel: sa.name, details: { expiresAt: iso(expiry.expiresAt), via: "api" } });
  revalidatePath(`/${a.org.slug}/service-accounts`);
  const [row] = await serviceAccountRows(a.org.id, sa.id);
  return json({ ...serviceAccountJson(row), secret });
});
