import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  admin,
  emailOTP,
  genericOAuth,
  magicLink,
  oneTimeToken,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { nextCookies } from "better-auth/next-js";
import { count, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { organization as organizationTable, user as userTable } from "@/db/schema";
import { env } from "./env";
import { buttonHtml, codeHtml, mailLayout, sendMail } from "./email";
import { sendInvitationMail } from "./invitation-mail";
import { orgAccessControl, orgRoles } from "./org-roles";
import { checkMemberQuota, checkOrgCreationQuota } from "./quota";
import { applyDefaultOrgLimits, applyDefaultUserLimits } from "./limits";
import { ensureLibraryOrg, LIBRARY_SLUG } from "./library";
import { ldap } from "./auth-ldap";
import { enforceLocalSignIn } from "./auth-access";
import { bindingsFor, parseGroupBindings } from "./group-bindings";
import { needsGoogleGroupsApi, syncOAuthGroups } from "./oauth-groups";
import { getInstanceSettings, settingsVersion, type EffectiveSettings } from "./instance-settings";
import { auditAfterHook, auditBefore, auditOrganizationHooks, auditSessionCreated, auditSessionDeleted, auditUserCreated, auditUserUpdate } from "./auth-audit";
import { canCreateOrganization, enforceSignUpPolicy, INVITATION_HEADER, ORG_CREATION_DENIED } from "./signup-policy";
import { clearOrganizationRedirect } from "./redirects";

/**
 * Fire-and-forget re-verification of an organization's signatures after a
 * membership change; loaded lazily so the auth module does not pull the
 * supply-chain code (and its dependencies) into every request.
 */
export function reverifyAfterMembershipChange(organizationId: string): void {
  void (async () => {
    const { listMemberKeys, orgTrustsMemberKeys, reverifyOrganization } = await import("./signatures");
    if (!(await orgTrustsMemberKeys(organizationId))) return;
    if ((await listMemberKeys(organizationId)).length === 0) return;
    await reverifyOrganization(organizationId);
  })().catch((err) => console.error("re-verification after a membership change failed:", err));
}

/**
 * Account deletion must not orphan an organization or the instance: the
 * only owner of an organization transfers it or deletes it first, and the
 * last administrator stays. Memberships, tokens, keys and sessions go with
 * the account (foreign keys cascade).
 */
async function refuseDeletionOfLastOwner(user: { id: string; role?: string | null }): Promise<void> {
  const { rows } = await db.execute(sql`
    SELECT o.name
    FROM member m JOIN organization o ON o.id = m.organization_id
    WHERE m.user_id = ${user.id} AND m.role = 'owner'
      AND NOT EXISTS (SELECT 1 FROM member x WHERE x.organization_id = m.organization_id AND x.role = 'owner' AND x.user_id <> ${user.id})
    ORDER BY o.name`);
  const sole = rows.map((r) => String(r.name));
  if (sole.length > 0) {
    throw new APIError("BAD_REQUEST", {
      message: `You are the only owner of ${sole.join(", ")}. Transfer ownership or delete ${sole.length === 1 ? "it" : "them"} first.`,
    });
  }
  if (user.role === "admin") {
    const [{ value: admins }] = await db.select({ value: count() }).from(userTable).where(eq(userTable.role, "admin"));
    if (admins <= 1) throw new APIError("BAD_REQUEST", { message: "The last administrator cannot delete their account. Make someone else an administrator first." });
  }
}

// Org slugs become both URL paths and image namespaces; these collide with
// app routes or registry internals.
export const RESERVED_SLUGS = new Set([
  "dashboard", "settings", "admin", "explore", "orgs", "api", "sign-in", "sign-up",
  "two-factor", "email-otp", "forgot-password", "reset-password", "verify-email",
  "accept-invitation", "v2", "internal", "_next", "favicon.ico", "assets", "static",
  LIBRARY_SLUG,
]);

/**
 * Build a better-auth instance from the effective settings. Providers can be
 * (re)configured in the admin panel, so the instance is rebuilt whenever the
 * stored settings change (see getAuth).
 */
function buildAuth(settings: EffectiveSettings) {
  const bindings = parseGroupBindings(settings.bindings);
  // Extra scopes are requested only when the group bindings actually need
  // the provider's group information, so plain sign-in stays minimal.
  const socialProviders: Record<string, { clientId: string; clientSecret: string; scope?: string[] }> = {};
  if (settings.github.enabled && settings.github.clientId) {
    socialProviders.github = {
      clientId: settings.github.clientId,
      clientSecret: settings.github.clientSecret,
      scope: bindingsFor("github", bindings).length > 0 ? ["read:org"] : undefined,
    };
  }
  if (settings.google.enabled && settings.google.clientId) {
    socialProviders.google = {
      clientId: settings.google.clientId,
      clientSecret: settings.google.clientSecret,
      scope: needsGoogleGroupsApi(bindings) ? ["https://www.googleapis.com/auth/cloud-identity.groups.readonly"] : undefined,
    };
  }
  const oidc = settings.oidc.enabled && settings.oidc.issuer ? settings.oidc : null;
  // Instance name from the branding settings: email subjects, TOTP issuer.
  const brand = settings.branding.instanceName || "Chicorée";
  const mailConfigured = !!settings.smtp.host;

  return betterAuth({
  appName: `${brand} Registry`,
  hooks: {
    before: createAuthMiddleware(async (raw) => {
      await enforceLocalSignIn(raw as { path?: string; headers?: Headers | null; body?: unknown });
      await auditBefore(raw);
    }),
    after: auditAfterHook,
  },
  baseURL: env.appUrl,
  secret: env.authSecret,
  database: drizzleAdapter(db, { provider: "pg" }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    // With a mail server, an address must be confirmed before a password
    // sign-in works (the attempt re-sends the link). Without one nobody
    // could confirm anything, so the check is off — administrators mark
    // addresses verified by hand.
    requireEmailVerification: mailConfigured,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: `Reset your ${brand} password`,
        text: `Reset your password: ${url}`,
        html: mailLayout(
          "Reset your password",
          `<p>Someone (hopefully you) asked to reset the password for ${user.email}.</p><p>${buttonHtml(url, "Choose a new password")}</p>`,
          brand,
        ),
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: `Verify your email for ${brand}`,
        text: `Verify your email: ${url}`,
        html: mailLayout(
          "Verify your email",
          `<p>Confirm that ${user.email} belongs to you to finish setting up your account.</p><p>${buttonHtml(url, "Verify email")}</p>`,
          brand,
        ),
      });
    },
  },

  socialProviders,

  user: {
    deleteUser: {
      enabled: true,
      // With a mail server the deletion is confirmed from the inbox; without
      // one better-auth asks for the password (or a fresh session) instead.
      sendDeleteAccountVerification: mailConfigured
        ? async ({ user, url }) => {
            await sendMail({
              to: user.email,
              subject: `Confirm deleting your ${brand} account`,
              text: `Delete the account ${user.email}: ${url}\n\nIf you did not ask for this, ignore this email.`,
              html: mailLayout(
                "Delete your account",
                `<p>Someone (hopefully you) asked to delete the ${brand} account for ${user.email}, with its access tokens, signing keys and memberships.</p><p>${buttonHtml(url, "Delete my account")}</p><p>If you did not ask for this, ignore this email — nothing happens without the link.</p>`,
                brand,
              ),
            });
          }
        : undefined,
      beforeDelete: async (user) => {
        await refuseDeletionOfLastOwner(user);
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        // The very first account on a fresh install becomes the instance
        // administrator; everyone after that is a regular user. That first
        // account is also marked verified: it is created by whoever installs
        // the registry, usually before any mail server exists.
        before: async (user, context) => {
          const [{ value: existing }] = await db.select({ value: count() }).from(userTable);
          // Sign-up mode and domain list (Administration → Auth providers → Access).
          await enforceSignUpPolicy(user, settings.access, { isFirstUser: existing === 0, invitationId: context?.headers?.get(INVITATION_HEADER) });
          return { data: { ...user, role: existing === 0 ? "admin" : "user", ...(existing === 0 ? { emailVerified: true } : {}) } };
        },
        // Administrators own the "library" organization (top-level images).
        after: async (user, context) => {
          if (user.role === "admin") await ensureLibraryOrg(user.id);
          // Everyone else starts with the instance's default limits (Administration → Limits).
          else await applyDefaultUserLimits(user.id, settings.quotas);
          await auditUserCreated(user, context);
        },
      },
      update: {
        before: async (user, context) => {
          await auditUserUpdate(user, context);
        },
      },
    },
    session: {
      create: {
        after: async (session, context) => {
          await auditSessionCreated(session, context);
        },
      },
      delete: {
        before: async (session, context) => {
          await auditSessionDeleted(session, context);
        },
      },
    },
    // Social logins create the account row once and refresh its tokens on
    // every later sign-in; both moments are when group bindings get applied.
    account: {
      create: {
        after: async (account) => {
          await syncOAuthGroups(account);
        },
      },
      update: {
        after: async (account) => {
          await syncOAuthGroups(account);
        },
      },
    },
  },

  plugins: [
    organization({
      ac: orgAccessControl,
      roles: orgRoles,
      sendInvitationEmail: async (data) => {
        await sendInvitationMail({
          invitationId: data.id,
          email: data.email,
          organizationName: data.organization.name,
          inviterName: data.inviter.user.name,
          inviterEmail: data.inviter.user.email,
          brand,
        });
      },
      // Org slugs double as registry namespaces (<slug>/<repo>), so they must
      // be valid OCI path components.
      organizationHooks: {
        ...auditOrganizationHooks,
        afterCreateOrganization: async (data) => {
          await auditOrganizationHooks.afterCreateOrganization(data);
          await applyDefaultOrgLimits(data.organization.id, settings.quotas);
        },
        // Member limit (Administration → Organizations → Limits). An open
        // invitation holds a seat: inviting counts pending invitations,
        // accepting one or adding a member directly counts members only.
        beforeCreateInvitation: async ({ invitation, organization }) => {
          const full = await checkMemberQuota(organization.id, { includePending: true, orgLabel: organization.name });
          if (full) throw new APIError("FORBIDDEN", { message: full });
          return { data: invitation };
        },
        beforeAcceptInvitation: async ({ organization }) => {
          const full = await checkMemberQuota(organization.id, { orgLabel: organization.name });
          if (full) throw new APIError("FORBIDDEN", { message: full });
        },
        beforeAddMember: async ({ member, organization }) => {
          const full = await checkMemberQuota(organization.id, { orgLabel: organization.name });
          if (full) throw new APIError("FORBIDDEN", { message: full });
          return { data: member };
        },
        // Members' personal signing keys count only while they may push:
        // a removal or role change re-verifies the organization's signatures
        // (in the background — it can touch every repository).
        afterRemoveMember: async (data) => {
          await auditOrganizationHooks.afterRemoveMember(data);
          reverifyAfterMembershipChange(data.organization.id);
        },
        afterUpdateMemberRole: async (data) => {
          await auditOrganizationHooks.afterUpdateMemberRole(data);
          reverifyAfterMembershipChange(data.organization.id);
        },
        beforeCreateOrganization: async ({ organization, user }) => {
          if (!canCreateOrganization(settings.access, user.role)) {
            throw new APIError("FORBIDDEN", { message: ORG_CREATION_DENIED });
          }
          const slug = organization.slug ?? "";
          if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(slug)) {
            throw new APIError("BAD_REQUEST", {
              message:
                "Organization slug must be lowercase letters, digits and single ._- separators (it becomes the image namespace)",
            });
          }
          if (RESERVED_SLUGS.has(slug)) {
            throw new APIError("BAD_REQUEST", { message: `"${slug}" is reserved; pick a different slug` });
          }
          if (user.role !== "admin") {
            const quota = await checkOrgCreationQuota(user.id);
            if (quota) throw new APIError("FORBIDDEN", { message: quota });
          }
          // A former slug of a renamed organization can be reused; the
          // redirect ends here (lib/redirects.ts).
          await clearOrganizationRedirect(slug);
          return { data: organization };
        },
        beforeDeleteOrganization: async ({ organization }) => {
          if (organization.slug === LIBRARY_SLUG) {
            throw new APIError("FORBIDDEN", { message: "The library organization cannot be deleted" });
          }
        },
        // `organization` here is the update payload; look the target up by id.
        beforeUpdateOrganization: async ({ organization: updates, member }) => {
          if (updates.slug && updates.slug !== LIBRARY_SLUG) {
            const current = await db.query.organization.findFirst({
              where: eq(organizationTable.id, member.organizationId),
            });
            if (current?.slug === LIBRARY_SLUG) {
              throw new APIError("FORBIDDEN", { message: "The library organization cannot be renamed" });
            }
          }
          return { data: updates };
        },
      },
    }),
    // Hands a signed-in user over to the account portal (Administration →
    // Limits): the Manage button fetches a short-lived token, the portal
    // verifies it server-side against /api/auth/one-time-token/verify.
    // Browsers may only ask for tokens while a portal is configured (the
    // plugin list must stay a fixed tuple for better-auth's type inference).
    oneTimeToken({ expiresIn: 3, disableClientRequest: !settings.portal.url }),
    twoFactor({
      issuer: `${brand} Registry`,
      otpOptions: {
        sendOTP: async ({ user, otp }) => {
          await sendMail({
            to: user.email,
            subject: `${otp} is your ${brand} verification code`,
            text: `Your verification code is ${otp}`,
            html: mailLayout("Your verification code", `<p>Enter this code to finish signing in.</p>${codeHtml(otp)}`, brand),
          });
        },
      },
    }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendMail({
          to: email,
          subject: `Your ${brand} sign-in link`,
          text: `Sign in: ${url}`,
          html: mailLayout(
            `Sign in to ${brand}`,
            `<p>Use the button below to sign in as ${email}. The link is valid for a few minutes.</p><p>${buttonHtml(url, "Sign in")}</p>`,
            brand,
          ),
        });
      },
    }),
    emailOTP({
      sendVerificationOTP: async ({ email, otp }) => {
        await sendMail({
          to: email,
          subject: `${otp} is your ${brand} code`,
          text: `Your code is ${otp}`,
          html: mailLayout("Your one-time code", `<p>Enter this code to continue.</p>${codeHtml(otp)}`, brand),
        });
      },
    }),
    passkey({
      rpID: env.passkeyRpId,
      rpName: env.passkeyRpName,
      origin: env.appUrl,
    }),
    admin(),
    ldap(),
    ...(oidc
      ? [
          genericOAuth({
            config: [
              {
                providerId: "oidc",
                clientId: oidc.clientId,
                clientSecret: oidc.clientSecret,
                discoveryUrl: `${oidc.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
                scopes: oidc.scopes.split(/[\s,]+/).filter(Boolean),
              },
            ],
          }),
        ]
      : []),
    nextCookies(), // must stay last
  ],
  });
}

export type Auth = ReturnType<typeof buildAuth>;
export type Session = Auth["$Infer"]["Session"];

let cached: { version: number; auth: Auth } | null = null;

/**
 * The auth instance for the current settings. One cheap query per call
 * checks whether the admin saved new settings; the instance is rebuilt
 * only then. Sessions survive rebuilds (same secret and database).
 */
export async function getAuth(): Promise<Auth> {
  const version = await settingsVersion();
  if (cached && cached.version === version) return cached.auth;
  const settings = await getInstanceSettings();
  cached = { version, auth: buildAuth(settings) };
  return cached.auth;
}
