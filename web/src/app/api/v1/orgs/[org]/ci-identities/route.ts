// GET / POST /api/v1/orgs/{org}/ci-identities — trusted CI identities for keyless authentication (owners and admins).
import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { ciIdentitiesTrusted, repositories } from "@/db/schema";
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { iso, json, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";
import { listCiIdentities, validateCiIdentity, type CiIdentityRow } from "@/lib/ci-auth";

export const dynamic = "force-dynamic";

export function ciIdentityJson(r: CiIdentityRow & { repositoryNames: string[] | null }) {
  return {
    id: r.id,
    name: r.name,
    issuer: r.issuer,
    subject: r.subject,
    permission: r.permission,
    repositories: r.repositoryNames,
    createdAt: iso(r.createdAt),
    lastUsedAt: iso(r.lastUsedAt),
    lastSubject: r.lastSubject,
  };
}

export const GET = route<{ org: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "list CI identities");
  const items = (await listCiIdentities(a.org.id)).map(ciIdentityJson);
  return json({ items, total: items.length });
});

export const POST = route<{ org: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "add CI identities");
  const body = await readJson(req);
  let values;
  try {
    values = validateCiIdentity({
      name: stringField(body, "name", 64) ?? "",
      issuer: stringField(body, "issuer", 500) ?? "",
      subject: stringField(body, "subject", 500) ?? "",
      permission: stringField(body, "permission", 10) ?? "push",
    });
  } catch (err) {
    throw unprocessable(err instanceof Error ? err.message : "Invalid identity.");
  }
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
  const [created] = await db
    .insert(ciIdentitiesTrusted)
    .values({ organizationId: a.org.id, ...values, repositoryIds, createdBy: caller.kind === "user" ? caller.user.id : null })
    .returning();
  await recordAudit({
    action: "ci.identity.add",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "ci_identity",
    targetId: created.id,
    targetLabel: values.name,
    details: { issuer: values.issuer, subject: values.subject, permission: values.permission, repositories: repositoryIds?.length ?? null, via: "api" },
  });
  revalidatePath(`/${a.org.slug}/service-accounts`);
  const row = (await listCiIdentities(a.org.id)).find((r) => r.id === created.id)!;
  return json(ciIdentityJson(row), { status: 201 });
});
