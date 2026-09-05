// GET    /api/v1/orgs/{org} — one organization with member count and storage.
// PATCH  /api/v1/orgs/{org} — rename it (owners).
// DELETE /api/v1/orgs/{org} — delete it with everything in it (owners).
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization } from "@/db/schema";
import { loadOrg, requireOrgManager, type OrgAccess } from "@/lib/api/access";
import type { ApiCaller } from "@/lib/api/auth";
import { route } from "@/lib/api/handler";
import { orgDetail } from "@/lib/api/queries";
import { forbidden, json, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";
import { LIBRARY_SLUG } from "@/lib/library";

function requireOwner(c: ApiCaller, a: OrgAccess, what: string) {
  requireOrgManager(c, a, what);
  if (a.role !== "owner" && !(c.kind === "user" && c.caller.isAdmin)) throw forbidden(`Only organization owners can ${what}.`);
}

export const dynamic = "force-dynamic";

export const GET = route<{ org: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  return json(await orgDetail(caller, a));
});

export const PATCH = route<{ org: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOwner(caller, a, "rename the organization");
  const body = await readJson(req);
  const name = stringField(body, "name", 100);
  if (!name) throw unprocessable('"name" is required (renaming the slug is done in the app: Settings → Danger zone).', { field: "name" });
  await db.update(organization).set({ name }).where(eq(organization.id, a.org.id));
  await recordAudit({ action: "org.update", actor: caller.auditActor, headers: req.headers, organizationId: a.org.id, targetType: "organization", targetId: a.org.id, targetLabel: a.org.slug, details: { name, via: "api" } });
  revalidatePath(`/${a.org.slug}`, "layout");
  return json(await orgDetail(caller, await loadOrg(caller, params.org)));
});

export const DELETE = route<{ org: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOwner(caller, a, "delete the organization");
  if (a.org.slug === LIBRARY_SLUG) throw forbidden("The library organization cannot be deleted.");
  // Cascades: members, invitations, repositories → manifests, tags, links,
  // events, service accounts. Blob content is reclaimed by the next GC.
  await db.delete(organization).where(eq(organization.id, a.org.id));
  await recordAudit({ action: "org.delete", actor: caller.auditActor, headers: req.headers, organizationId: a.org.id, targetType: "organization", targetId: a.org.id, targetLabel: a.org.slug, details: { name: a.org.name, via: "api" } });
  revalidatePath("/", "layout");
  return json({ deleted: a.org.slug });
});
