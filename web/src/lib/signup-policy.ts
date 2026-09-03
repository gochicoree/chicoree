// Sign-up controls, enforced where accounts come into existence: better-auth's
// user.create.before hook (email sign-up, social/OIDC first login, magic link
// and email-code sign-up, LDAP provisioning in the browser and at the docker
// token endpoint) and the organization creation hook.
import { APIError } from "better-auth/api";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { invitation } from "@/db/schema";
import { describeDomains, emailDomainAllowed, type AccessSettings } from "./access-shared";

export { INVITATION_HEADER } from "./access-shared";

export interface PendingInvitation {
  id: string;
  email: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: string | null;
}

/** A pending, unexpired invitation by id (null when unknown, used or expired). */
export async function findPendingInvitation(id: string): Promise<PendingInvitation | null> {
  if (!id || id.length > 100) return null;
  const { rows } = await db.execute(sql`
    SELECT i.id, i.email, i.organization_id, i.role, o.name AS organization_name, o.slug AS organization_slug
    FROM invitation i JOIN organization o ON o.id = i.organization_id
    WHERE i.id = ${id} AND i.status = 'pending' AND i.expires_at > now()`);
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    email: String(r.email),
    organizationId: String(r.organization_id),
    organizationName: String(r.organization_name),
    organizationSlug: String(r.organization_slug),
    role: (r.role as string | null) ?? null,
  };
}

/** No accounts yet: the sign-up mode does not apply to the first (administrator) account. */
export async function isFreshInstall(): Promise<boolean> {
  const { rows } = await db.execute(sql`SELECT count(*)::int AS n FROM "user"`);
  return Number(rows[0]?.n ?? 0) === 0;
}

async function hasPendingInvitationFor(email: string): Promise<boolean> {
  const row = await db.query.invitation.findFirst({
    where: and(eq(invitation.email, email), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())),
    columns: { id: true },
  });
  return !!row;
}

/** Message users see when sign-up is not possible for them. */
export function signUpClosedMessage(access: AccessSettings): string {
  if (access.signUpMode === "closed") return "This registry does not accept new accounts. Ask an administrator for access.";
  if (access.signUpMode === "invite") return "Accounts on this registry are created by invitation only. Open the invitation link you received to continue.";
  return "";
}

export function domainRestrictionMessage(access: AccessSettings): string {
  if (access.allowedEmailDomains.length === 0) return "";
  return `Only email addresses at ${describeDomains(access.allowedEmailDomains)} can register.`;
}

/**
 * Throws an APIError when the account may not be created. `isFirstUser`
 * exempts a fresh install from the sign-up mode (someone has to become the
 * administrator); the domain list applies regardless.
 */
export async function enforceSignUpPolicy(
  user: { email?: string | null },
  access: AccessSettings,
  opts: { isFirstUser: boolean; invitationId?: string | null },
): Promise<void> {
  const email = (user.email ?? "").toLowerCase();
  if (!emailDomainAllowed(email, access.allowedEmailDomains)) {
    throw new APIError("FORBIDDEN", { message: domainRestrictionMessage(access) });
  }
  if (opts.isFirstUser) return;
  if (access.signUpMode === "closed") {
    throw new APIError("FORBIDDEN", { message: signUpClosedMessage(access) });
  }
  if (access.signUpMode === "invite") {
    if (opts.invitationId) {
      const inv = await findPendingInvitation(opts.invitationId);
      if (inv && inv.email.toLowerCase() === email) return;
      throw new APIError("FORBIDDEN", {
        message: inv
          ? `That invitation was sent to ${inv.email}; sign up with that address.`
          : "This invitation is no longer valid. Ask for a new one.",
      });
    }
    if (await hasPendingInvitationFor(email)) return;
    throw new APIError("FORBIDDEN", { message: signUpClosedMessage(access) });
  }
}

/** Whether a user may create organizations under the current policy. */
export function canCreateOrganization(access: AccessSettings, role: string | null | undefined): boolean {
  return access.allowOrganizationCreation !== "admins" || role === "admin";
}

export const ORG_CREATION_DENIED = "Only administrators can create organizations on this registry.";
