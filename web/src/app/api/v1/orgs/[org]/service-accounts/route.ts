// GET / POST /api/v1/orgs/{org}/service-accounts — the organization's service accounts (owners and admins).
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { repositories, serviceAccounts } from "@/db/schema";
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { requireUser } from "@/lib/api/auth";
import { route } from "@/lib/api/handler";
import { conflict, enumField, iso, json, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { serviceAccountJson, serviceAccountRows, SA_NAME_RE, expiryFromBody } from "@/lib/api/service-accounts";
import { recordAudit } from "@/lib/audit";
import { generateSecret, SA_PREFIX } from "@/lib/secrets";

export const dynamic = "force-dynamic";

const PERMISSIONS = ["pull", "push", "admin"] as const;

export const GET = route<{ org: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "list service accounts");
  const items = await serviceAccountRows(a.org.id);
  return json({ items, total: items.length });
});

export const POST = route<{ org: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "create service accounts");
  const c = requireUser(caller);
  const body = await readJson(req);
  const name = stringField(body, "name", 64) ?? "";
  if (!SA_NAME_RE.test(name)) throw unprocessable("Service account names use lowercase letters, digits and single ._- separators (up to 64 characters).", { field: "name" });
  const description = stringField(body, "description", 500) ?? "";
  const permission = enumField(body, "permission", PERMISSIONS) ?? "pull";
  const expiry = await expiryFromBody(body);

  let repositoryIds: string[] | null = null;
  if (body.repositories !== undefined && body.repositories !== null) {
    if (!Array.isArray(body.repositories) || !body.repositories.every((r) => typeof r === "string")) throw unprocessable('"repositories" must be an array of repository names.', { field: "repositories" });
    const names = [...new Set(body.repositories as string[])];
    if (names.length) {
      const rows = await db.query.repositories.findMany({ where: and(eq(repositories.organizationId, a.org.id), inArray(repositories.name, names)), columns: { id: true, name: true } });
      const missing = names.filter((n) => !rows.some((r) => r.name === n));
      if (missing.length) throw unprocessable(`Unknown repositories: ${missing.join(", ")}.`, { field: "repositories" });
      repositoryIds = rows.map((r) => r.id);
    }
  }
  const existing = await db.query.serviceAccounts.findFirst({ where: and(eq(serviceAccounts.organizationId, a.org.id), eq(serviceAccounts.name, name)), columns: { id: true } });
  if (existing) throw conflict(`A service account named ${name} already exists.`);

  const { secret, hash, display } = generateSecret(SA_PREFIX);
  const [created] = await db
    .insert(serviceAccounts)
    .values({ organizationId: a.org.id, name, description, permission, tokenHash: hash, tokenPrefix: display, repositoryIds, createdBy: c.user.id, expiresAt: expiry })
    .returning();
  await recordAudit({
    action: "sa.create",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "service_account",
    targetId: created.id,
    targetLabel: name,
    details: { permission, expiresAt: iso(expiry), repositories: repositoryIds?.length ?? null, via: "api" },
  });
  revalidatePath(`/${a.org.slug}/service-accounts`);
  const [row] = await serviceAccountRows(a.org.id, created.id);
  return json({ ...serviceAccountJson(row), secret }, { status: 201 });
});
