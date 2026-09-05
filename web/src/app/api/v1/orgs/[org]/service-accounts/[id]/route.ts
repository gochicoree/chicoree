// GET / DELETE /api/v1/orgs/{org}/service-accounts/{id}
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { serviceAccounts } from "@/db/schema";
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json, notFound } from "@/lib/api/respond";
import { serviceAccountJson, serviceAccountRows } from "@/lib/api/service-accounts";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

type Params = { org: string; id: string };

export const GET = route<Params>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "read service accounts");
  const [row] = await serviceAccountRows(a.org.id, params.id);
  if (!row) throw notFound("No such service account.");
  return json(serviceAccountJson(row));
});

export const DELETE = route<Params>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "delete service accounts");
  const sa = await db.query.serviceAccounts.findFirst({ where: and(eq(serviceAccounts.id, params.id), eq(serviceAccounts.organizationId, a.org.id)) });
  if (!sa) throw notFound("No such service account.");
  await db.delete(serviceAccounts).where(eq(serviceAccounts.id, sa.id));
  await recordAudit({ action: "sa.delete", actor: caller.auditActor, headers: req.headers, organizationId: a.org.id, targetType: "service_account", targetId: sa.id, targetLabel: sa.name, details: { via: "api" } });
  revalidatePath(`/${a.org.slug}/service-accounts`);
  return json({ deleted: sa.id, name: sa.name });
});
