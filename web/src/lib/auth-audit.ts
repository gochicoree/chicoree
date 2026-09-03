// Audit instrumentation for better-auth: request hooks (sign-in failures,
// sign-out, admin actions, passwords, passkeys) plus database and
// organization hooks (sign-up, sign-in, 2FA, membership). Everything here is
// best effort — recordAudit never throws and nothing blocks the auth flow.
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user as userTable } from "@/db/schema";
import { recordAudit, sessionActor, type AuditActor } from "./audit";

interface SessionLike {
  user: { id: string; email?: string | null; name?: string | null; role?: string | null };
  session: { id?: string; impersonatedBy?: string | null };
}

interface HookCtx {
  path: string;
  body?: unknown;
  params?: Record<string, string> | undefined;
  headers?: Headers;
  context: {
    returned?: unknown;
    session?: SessionLike | null;
    newSession?: SessionLike | null;
    auditResetUserId?: string;
    internalAdapter: {
      findVerificationValue(identifier: string): Promise<{ value: string } | null>;
      findUserByEmail(email: string): Promise<{ user: { id: string; email: string } } | null>;
    };
  };
}

const str = (body: unknown, key: string): string => {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" ? v : "";
};

const SIGN_IN_METHODS: Record<string, string> = {
  "/sign-in/email": "password",
  "/sign-in/ldap": "ldap",
  "/sign-in/email-otp": "email-otp",
  "/sign-in/magic-link": "magic-link",
  "/magic-link/verify": "magic-link",
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-otp": "email-otp-2fa",
  "/two-factor/verify-backup-code": "backup-code",
  "/passkey/verify-authentication": "passkey",
  "/verify-email": "email-verification",
  "/sign-up/email": "password",
  "/callback/:id": "oauth",
  "/oauth2/callback/:providerId": "oauth",
};

function methodFor(ctx: { path?: string; params?: Record<string, string> } | null | undefined): string {
  if (!ctx?.path) return "unknown";
  const base = SIGN_IN_METHODS[ctx.path] ?? ctx.path;
  const provider = ctx.params?.id ?? ctx.params?.providerId;
  return base === "oauth" && provider ? `oauth:${provider}` : base;
}

function errorDetails(err: unknown): Record<string, unknown> {
  const e = err as { statusCode?: number; status?: number | string; body?: { code?: string; message?: string }; message?: string };
  return {
    status: e.statusCode ?? e.status,
    code: e.body?.code,
    reason: e.body?.message ?? e.message,
  };
}

async function userLabel(userId: string): Promise<string> {
  const u = await db.query.user.findFirst({ where: eq(userTable.id, userId), columns: { email: true } });
  return u?.email ?? "";
}

// --- request hooks ---------------------------------------------------------

/** Runs before every auth request; captures state the after hook can no longer see. */
export const auditBeforeHook = createAuthMiddleware(async (raw) => {
  const ctx = raw as unknown as HookCtx;
  try {
    if (ctx.path === "/reset-password") {
      // The token is consumed by the handler; resolve the user now.
      const token = str(ctx.body, "token") || str((raw as { query?: unknown }).query, "token");
      if (token) {
        const v = await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`);
        if (v?.value) ctx.context.auditResetUserId = v.value;
      }
    }
  } catch (err) {
    console.error("[audit] before hook failed:", err);
  }
});

/** Runs after every auth request; records outcomes by route. */
export const auditAfterHook = createAuthMiddleware(async (raw) => {
  const ctx = raw as unknown as HookCtx;
  try {
    const returned = ctx.context.returned;
    const failed = isAPIError(returned);
    const path = ctx.path;
    const body = ctx.body;
    const headers = ctx.headers;
    const session = ctx.context.session ?? null;
    const actor: AuditActor | undefined = session ? sessionActor(session) : undefined;

    // Failed sign-ins (successful ones are recorded when the session is created).
    if (failed && (path in SIGN_IN_METHODS || path.startsWith("/two-factor/verify"))) {
      const label = str(body, "email") || str(body, "username");
      await recordAudit({
        action: "auth.sign_in.failed",
        actor: { type: "user", id: null, label },
        targetType: label ? "email" : null,
        targetLabel: label || null,
        details: { method: methodFor(ctx), ...errorDetails(returned) },
        headers,
      });
      return;
    }
    if (failed) return;

    switch (path) {
      case "/admin/set-role":
        await recordAudit({ action: "admin.user.role", actor, targetType: "user", targetId: str(body, "userId"), targetLabel: await userLabel(str(body, "userId")), details: { role: (body as { role?: unknown })?.role }, headers });
        break;
      case "/admin/ban-user":
        await recordAudit({ action: "admin.user.ban", actor, targetType: "user", targetId: str(body, "userId"), targetLabel: await userLabel(str(body, "userId")), details: { reason: str(body, "banReason") || undefined, expiresIn: (body as { banExpiresIn?: unknown })?.banExpiresIn }, headers });
        break;
      case "/admin/unban-user":
        await recordAudit({ action: "admin.user.unban", actor, targetType: "user", targetId: str(body, "userId"), targetLabel: await userLabel(str(body, "userId")), headers });
        break;
      case "/admin/remove-user":
        await recordAudit({ action: "admin.user.delete", actor, targetType: "user", targetId: str(body, "userId"), headers });
        break;
      case "/admin/create-user":
        await recordAudit({ action: "admin.user.create", actor, targetType: "user", targetId: (returned as { user?: { id?: string } })?.user?.id ?? null, targetLabel: str(body, "email"), details: { role: (body as { role?: unknown })?.role }, headers });
        break;
      case "/admin/update-user":
        await recordAudit({ action: "admin.user.update", actor, targetType: "user", targetId: str(body, "userId"), targetLabel: await userLabel(str(body, "userId")), details: { fields: Object.keys((body as { data?: object })?.data ?? {}) }, headers });
        break;
      case "/admin/set-user-password":
        await recordAudit({ action: "admin.user.password", actor, targetType: "user", targetId: str(body, "userId"), targetLabel: await userLabel(str(body, "userId")), headers });
        break;
      case "/admin/revoke-user-sessions":
      case "/admin/revoke-user-session":
        await recordAudit({ action: "admin.user.revoke_sessions", actor, targetType: "user", targetId: str(body, "userId"), targetLabel: await userLabel(str(body, "userId")), headers });
        break;
      case "/admin/impersonate-user":
        await recordAudit({ action: "admin.impersonate.start", actor, targetType: "user", targetId: str(body, "userId"), targetLabel: await userLabel(str(body, "userId")), headers });
        break;
      case "/admin/stop-impersonating": {
        const admin = ctx.context.newSession ?? null;
        const impersonated = session?.session.impersonatedBy ? session.user : null;
        await recordAudit({
          action: "admin.impersonate.stop",
          actor: admin ? sessionActor(admin) : { type: "user", id: session?.session.impersonatedBy ?? null, label: "" },
          targetType: impersonated ? "user" : null,
          targetId: impersonated?.id ?? null,
          targetLabel: impersonated?.email ?? null,
          headers,
        });
        break;
      }
      case "/change-password":
        await recordAudit({ action: "auth.password.change", actor, details: { via: "change-password", revokeOtherSessions: !!(body as { revokeOtherSessions?: unknown })?.revokeOtherSessions }, headers });
        break;
      case "/set-password":
        await recordAudit({ action: "auth.password.change", actor, details: { via: "set-password" }, headers });
        break;
      case "/reset-password": {
        const id = ctx.context.auditResetUserId;
        await recordAudit({ action: "auth.password.reset", actor: { type: "user", id: id ?? null, label: id ? await userLabel(id) : "" }, details: { via: "reset-link" }, headers });
        break;
      }
      case "/email-otp/reset-password": {
        const email = str(body, "email").toLowerCase();
        const u = email ? await ctx.context.internalAdapter.findUserByEmail(email) : null;
        await recordAudit({ action: "auth.password.reset", actor: { type: "user", id: u?.user.id ?? null, label: email }, details: { via: "email-otp" }, headers });
        break;
      }
      case "/passkey/verify-registration":
        await recordAudit({ action: "auth.passkey.add", actor, targetType: "passkey", targetId: (returned as { id?: string })?.id ?? null, targetLabel: str(body, "name") || null, headers });
        break;
      case "/passkey/delete-passkey":
        await recordAudit({ action: "auth.passkey.remove", actor, targetType: "passkey", targetId: str(body, "id"), headers });
        break;
      case "/update-user":
        await recordAudit({ action: "user.profile.update", actor, details: { fields: Object.keys((body as object) ?? {}) }, headers });
        break;
      case "/delete-user":
        await recordAudit({ action: "auth.account.delete", actor, details: { requested: true }, headers });
        break;
      case "/revoke-session":
      case "/revoke-sessions":
      case "/revoke-other-sessions":
        await recordAudit({ action: "auth.session.revoke", actor, details: { scope: path.slice(1) }, headers });
        break;
      case "/link-social":
        await recordAudit({ action: "auth.account.link", actor, details: { provider: str(body, "provider") }, headers });
        break;
      case "/unlink-account":
        await recordAudit({ action: "auth.account.unlink", actor, details: { provider: str(body, "providerId") }, headers });
        break;
      case "/two-factor/generate-backup-codes":
        await recordAudit({ action: "auth.2fa.backup_codes", actor, headers });
        break;
      default:
        break;
    }
  } catch (err) {
    console.error("[audit] after hook failed:", err);
  }
});

// --- database hooks --------------------------------------------------------

type DbHookCtx = { path?: string; params?: Record<string, string>; headers?: Headers } | null | undefined;

/** user.create.after: every new account, whichever door it came through. */
export async function auditUserCreated(user: { id: string; email: string; name?: string | null; role?: string | null }, context: unknown): Promise<void> {
  const ctx = context as DbHookCtx;
  await recordAudit({
    action: "auth.sign_up",
    actor: { type: "user", id: user.id, label: user.email },
    targetType: "user",
    targetId: user.id,
    targetLabel: user.email,
    details: { via: ctx?.path ? methodFor(ctx) : "ldap-docker", role: user.role ?? undefined },
    headers: ctx?.headers ?? null,
  });
}

/** session.create.after: a completed sign-in (impersonation is logged by the admin route). */
export async function auditSessionCreated(session: { userId: string; impersonatedBy?: string | null }, context: unknown): Promise<void> {
  const ctx = context as DbHookCtx;
  if (session.impersonatedBy || ctx?.path === "/admin/stop-impersonating") return;
  await recordAudit({
    action: "auth.sign_in",
    actor: { type: "user", id: session.userId, label: await userLabel(session.userId) },
    details: { method: methodFor(ctx) },
    headers: ctx?.headers ?? null,
  });
}

/** session.delete.before: an explicit sign-out (revocations are logged by their routes). */
export async function auditSessionDeleted(session: { userId: string; impersonatedBy?: string | null }, context: unknown): Promise<void> {
  const ctx = context as DbHookCtx;
  if (ctx?.path !== "/sign-out") return;
  await recordAudit({
    action: "auth.sign_out",
    actor: { type: "user", id: session.userId, label: await userLabel(session.userId), impersonatorId: session.impersonatedBy ?? null },
    headers: ctx?.headers ?? null,
  });
}

/** user.update.before: the two-factor flag flipping is the moment 2FA is (dis)armed. */
export async function auditUserUpdate(data: Record<string, unknown>, context: unknown): Promise<void> {
  if (typeof data.twoFactorEnabled !== "boolean") return;
  const ctx = context as DbHookCtx;
  await recordAudit({
    action: data.twoFactorEnabled ? "auth.2fa.enable" : "auth.2fa.disable",
    details: { via: ctx?.path },
    headers: ctx?.headers ?? null,
  });
}

// --- organization hooks ----------------------------------------------------

type Org = { id: string; slug: string; name: string };
type UserRef = { id: string; email: string };

const orgTarget = (o: Org) => ({ organizationId: o.id, targetType: "organization", targetId: o.id, targetLabel: o.slug });

export const auditOrganizationHooks = {
  afterCreateOrganization: async ({ organization, user }: { organization: Org; user: UserRef }) => {
    await recordAudit({ action: "org.create", actor: { type: "user", id: user.id, label: user.email }, ...orgTarget(organization), details: { name: organization.name } });
  },
  afterUpdateOrganization: async ({ organization, user }: { organization: Org | null; user: UserRef }) => {
    if (!organization) return;
    await recordAudit({ action: "org.update", actor: { type: "user", id: user.id, label: user.email }, ...orgTarget(organization), details: { name: organization.name } });
  },
  afterDeleteOrganization: async ({ organization, user }: { organization: Org; user: UserRef }) => {
    await recordAudit({ action: "org.delete", actor: { type: "user", id: user.id, label: user.email }, ...orgTarget(organization), details: { name: organization.name } });
  },
  afterAddMember: async ({ member, user, organization }: { member: { role: string; userId: string }; user: UserRef; organization: Org }) => {
    await recordAudit({ action: "org.member.add", organizationId: organization.id, targetType: "user", targetId: user.id, targetLabel: user.email, details: { role: member.role, organization: organization.slug } });
  },
  afterRemoveMember: async ({ member, user, organization }: { member: { role: string }; user: UserRef; organization: Org }) => {
    await recordAudit({ action: "org.member.remove", organizationId: organization.id, targetType: "user", targetId: user.id, targetLabel: user.email, details: { role: member.role, organization: organization.slug } });
  },
  afterUpdateMemberRole: async ({ member, previousRole, user, organization }: { member: { role: string }; previousRole: string; user: UserRef; organization: Org }) => {
    await recordAudit({ action: "org.member.role", organizationId: organization.id, targetType: "user", targetId: user.id, targetLabel: user.email, details: { from: previousRole, to: member.role, organization: organization.slug } });
  },
  afterCreateInvitation: async ({ invitation, inviter, organization }: { invitation: { id: string; email: string; role?: string | null }; inviter: UserRef; organization: Org }) => {
    await recordAudit({ action: "org.invitation.create", actor: { type: "user", id: inviter.id, label: inviter.email }, organizationId: organization.id, targetType: "invitation", targetId: invitation.id, targetLabel: invitation.email, details: { role: invitation.role, organization: organization.slug } });
  },
  afterAcceptInvitation: async ({ invitation, member, user, organization }: { invitation: { id: string; email: string }; member: { role: string }; user: UserRef; organization: Org }) => {
    await recordAudit({ action: "org.invitation.accept", actor: { type: "user", id: user.id, label: user.email }, organizationId: organization.id, targetType: "invitation", targetId: invitation.id, targetLabel: invitation.email, details: { role: member.role, organization: organization.slug } });
  },
  afterRejectInvitation: async ({ invitation, user, organization }: { invitation: { id: string; email: string }; user: UserRef; organization: Org }) => {
    await recordAudit({ action: "org.invitation.reject", actor: { type: "user", id: user.id, label: user.email }, organizationId: organization.id, targetType: "invitation", targetId: invitation.id, targetLabel: invitation.email, details: { organization: organization.slug } });
  },
  afterCancelInvitation: async ({ invitation, cancelledBy, organization }: { invitation: { id: string; email: string }; cancelledBy: UserRef; organization: Org }) => {
    await recordAudit({ action: "org.invitation.cancel", actor: { type: "user", id: cancelledBy.id, label: cancelledBy.email }, organizationId: organization.id, targetType: "invitation", targetId: invitation.id, targetLabel: invitation.email, details: { organization: organization.slug } });
  },
};
