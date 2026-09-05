// DELETE /api/v1/orgs/{org}/ci-identities/{id} — stop trusting an identity (its tokens stop working at once).
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { ciIdentitiesTrusted } from "@/db/schema";
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json, notFound } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export const DELETE = route<{ org: string; id: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "remove CI identities");
  const row = await db.query.ciIdentitiesTrusted.findFirst({ where: and(eq(ciIdentitiesTrusted.id, params.id), eq(ciIdentitiesTrusted.organizationId, a.org.id)) });
  if (!row) throw notFound("No such CI identity.");
  await db.delete(ciIdentitiesTrusted).where(eq(ciIdentitiesTrusted.id, row.id));
  await recordAudit({ action: "ci.identity.remove", actor: caller.auditActor, headers: req.headers, organizationId: a.org.id, targetType: "ci_identity", targetId: row.id, targetLabel: row.name, details: { issuer: row.issuer, subject: row.subject, via: "api" } });
  revalidatePath(`/${a.org.slug}/service-accounts`);
  return json({ deleted: row.id, name: row.name });
});
