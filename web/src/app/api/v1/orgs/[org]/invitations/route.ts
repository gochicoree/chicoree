// GET / POST /api/v1/orgs/{org}/invitations — pending invitations; invite by email.
import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { invitation, member, user as userTable } from "@/db/schema";
import { loadOrg, requireOrgManager } from "@/lib/api/access";
import { requireUser } from "@/lib/api/auth";
import { route } from "@/lib/api/handler";
import { conflict, enumField, forbidden, iso, json, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";
import { getBranding } from "@/lib/branding";
import { sendInvitationMail } from "@/lib/invitation-mail";
import { ORG_ROLE_NAMES } from "@/lib/org-roles";
import { checkMemberQuota } from "@/lib/quota";

export const dynamic = "force-dynamic";

const INVITATION_TTL_MS = 48 * 3600 * 1000;

function invitationJson(i: typeof invitation.$inferSelect) {
  return { id: i.id, email: i.email, role: i.role ?? "member", status: i.status, expiresAt: iso(i.expiresAt), createdAt: iso(i.createdAt), inviterId: i.inviterId };
}

export const GET = route<{ org: string }>(async (_req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "list invitations");
  const rows = await db.query.invitation.findMany({ where: and(eq(invitation.organizationId, a.org.id), eq(invitation.status, "pending")), orderBy: (t, { desc }) => [desc(t.createdAt)] });
  return json({ items: rows.map(invitationJson), total: rows.length });
});

export const POST = route<{ org: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "invite members");
  const c = requireUser(caller);
  const body = await readJson(req);
  const email = (stringField(body, "email", 254) ?? "").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw unprocessable('"email" must be an email address.', { field: "email" });
  const role = enumField(body, "role", ORG_ROLE_NAMES) ?? "member";
  if (role === "owner" && a.role !== "owner" && !c.caller.isAdmin) throw forbidden("Only organization owners can invite owners.");
  const full = await checkMemberQuota(a.org.id, { includePending: true, orgLabel: a.org.name });
  if (full) throw forbidden(full);

  const existingUser = await db.query.user.findFirst({ where: eq(userTable.email, email), columns: { id: true } });
  if (existingUser) {
    const already = await db.query.member.findFirst({ where: and(eq(member.organizationId, a.org.id), eq(member.userId, existingUser.id)), columns: { id: true } });
    if (already) throw conflict(`${email} is already a member.`);
  }
  const pending = await db.query.invitation.findFirst({ where: and(eq(invitation.organizationId, a.org.id), eq(invitation.email, email), eq(invitation.status, "pending")) });
  if (pending && pending.expiresAt.getTime() > Date.now()) throw conflict(`${email} already has a pending invitation (${pending.id}).`);

  const [row] = await db
    .insert(invitation)
    .values({ id: randomUUID(), organizationId: a.org.id, email, role, status: "pending", expiresAt: new Date(Date.now() + INVITATION_TTL_MS), inviterId: c.user.id })
    .returning();
  const branding = await getBranding();
  let emailSent = true;
  try {
    await sendInvitationMail({ invitationId: row.id, email, organizationName: a.org.name, inviterName: c.user.name, inviterEmail: c.user.email, brand: branding.instanceName });
  } catch (err) {
    console.error("invitation mail failed:", err);
    emailSent = false;
  }
  await recordAudit({
    action: "org.invitation.create",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "invitation",
    targetId: row.id,
    targetLabel: email,
    details: { role, organization: a.org.slug, emailSent, via: "api" },
  });
  revalidatePath(`/${a.org.slug}/members`);
  return json({ ...invitationJson(row), emailSent, acceptUrl: `${process.env.APP_URL ?? ""}/accept-invitation/${row.id}` }, { status: 201 });
});
