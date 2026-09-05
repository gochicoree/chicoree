// DELETE /api/v1/orgs/{org}/invitations/{id} — cancel a pending invitation.
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { invitation } from "@/db/schema";
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json, notFound } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const DELETE = route<{ org: string; id: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "cancel invitations");
  const row = await db.query.invitation.findFirst({ where: and(eq(invitation.id, params.id), eq(invitation.organizationId, a.org.id)) });
  if (!row || row.status !== "pending") throw notFound("No such pending invitation.");
  await db.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, row.id));
  await recordAudit({
    action: "org.invitation.cancel",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "invitation",
    targetId: row.id,
    targetLabel: row.email,
    details: { organization: a.org.slug, via: "api" },
  });
  revalidatePath(`/${a.org.slug}/members`);
  return json({ canceled: row.id, email: row.email });
});
