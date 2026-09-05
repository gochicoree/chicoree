// PATCH / DELETE /api/v1/orgs/{org}/members/{userId} — change a member's role or remove them.
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { member, user as userTable } from "@/db/schema";
import { loadOrg, requireOrgManager, type OrgAccess } from "@/lib/api/access";
import type { ApiCaller } from "@/lib/api/auth";
import { route } from "@/lib/api/handler";
import { conflict, enumField, forbidden, iso, json, notFound, readJson } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";
import { reverifyAfterMembershipChange } from "@/lib/auth";
import { ORG_ROLE_NAMES, type OrgRole } from "@/lib/org-roles";

export const dynamic = "force-dynamic";

type Params = { org: string; userId: string };

/** Only owners (and instance administrators) hand out or take away the owner role. */
function requireOwnerFor(caller: ApiCaller, a: OrgAccess, what: string) {
  const isInstanceAdmin = caller.kind === "user" && caller.caller.isAdmin;
  if (a.role !== "owner" && !isInstanceAdmin) throw forbidden(`Only organization owners can ${what}.`);
}

async function ownerCount(organizationId: string): Promise<number> {
  return db.$count(member, and(eq(member.organizationId, organizationId), eq(member.role, "owner")));
}

async function target(a: OrgAccess, userId: string) {
  const row = await db
    .select({ id: member.id, role: member.role, userId: member.userId, email: userTable.email, name: userTable.name, joinedAt: member.createdAt })
    .from(member)
    .innerJoin(userTable, eq(userTable.id, member.userId))
    .where(and(eq(member.organizationId, a.org.id), eq(member.userId, userId)))
    .limit(1);
  if (!row[0]) throw notFound("No such member.");
  return row[0];
}

export const PATCH = route<Params>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "change member roles");
  const m = await target(a, params.userId);
  const body = await readJson(req);
  const role = enumField(body, "role", ORG_ROLE_NAMES);
  if (!role) throw conflict(`"role" is required: one of ${ORG_ROLE_NAMES.join(", ")}.`);
  if (role === "owner" || m.role === "owner") requireOwnerFor(caller, a, "change who owns the organization");
  if (m.role === "owner" && role !== "owner" && (await ownerCount(a.org.id)) <= 1) throw conflict("The organization needs at least one owner; make someone else an owner first.");
  if (m.role !== role) {
    await db.update(member).set({ role }).where(eq(member.id, m.id));
    await recordAudit({
      action: "org.member.role",
      actor: caller.auditActor,
      headers: req.headers,
      organizationId: a.org.id,
      targetType: "user",
      targetId: m.userId,
      targetLabel: m.email,
      details: { from: m.role, to: role, organization: a.org.slug, via: "api" },
    });
    reverifyAfterMembershipChange(a.org.id);
    revalidatePath(`/${a.org.slug}/members`);
  }
  return json({ userId: m.userId, name: m.name, email: m.email, role: role as OrgRole, joinedAt: iso(m.joinedAt) });
});

export const DELETE = route<Params>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "remove members");
  const m = await target(a, params.userId);
  if (m.role === "owner") {
    requireOwnerFor(caller, a, "remove an owner");
    if ((await ownerCount(a.org.id)) <= 1) throw conflict("The organization needs at least one owner; make someone else an owner first.");
  }
  await db.delete(member).where(eq(member.id, m.id));
  await recordAudit({
    action: "org.member.remove",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "user",
    targetId: m.userId,
    targetLabel: m.email,
    details: { role: m.role, organization: a.org.slug, via: "api" },
  });
  reverifyAfterMembershipChange(a.org.id);
  revalidatePath(`/${a.org.slug}/members`);
  return json({ removed: m.userId, email: m.email });
});
