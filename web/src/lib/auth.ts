import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  admin,
  emailOTP,
  genericOAuth,
  magicLink,
  organization,
  twoFactor,
} from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { nextCookies } from "better-auth/next-js";
import { count, eq } from "drizzle-orm";
import { db } from "@/db";
import { organization as organizationTable, user as userTable } from "@/db/schema";
import { env } from "./env";
import { buttonHtml, codeHtml, mailLayout, sendMail } from "./email";
import { orgAccessControl, orgRoles } from "./org-roles";
import { checkOrgCreationQuota } from "./quota";
import { ensureLibraryOrg, LIBRARY_SLUG } from "./library";
import { ldap } from "./auth-ldap";
import { bindingsFor, parseGroupBindings } from "./group-bindings";
import { needsGoogleGroupsApi, syncOAuthGroups } from "./oauth-groups";
import { getInstanceSettings, settingsVersion, type EffectiveSettings } from "./instance-settings";

// Org slugs become both URL paths and image namespaces; these collide with
// app routes or registry internals.
const RESERVED_SLUGS = new Set([
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

  return betterAuth({
  appName: "Chicorée Registry",
  baseURL: env.appUrl,
  secret: env.authSecret,
  database: drizzleAdapter(db, { provider: "pg" }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    sendResetPassword: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: "Reset your Chicorée password",
        text: `Reset your password: ${url}`,
        html: mailLayout(
          "Reset your password",
          `<p>Someone (hopefully you) asked to reset the password for ${user.email}.</p><p>${buttonHtml(url, "Choose a new password")}</p>`,
        ),
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: "Verify your email for Chicorée",
        text: `Verify your email: ${url}`,
        html: mailLayout(
          "Verify your email",
          `<p>Confirm that ${user.email} belongs to you to finish setting up your account.</p><p>${buttonHtml(url, "Verify email")}</p>`,
        ),
      });
    },
  },

  socialProviders,

  databaseHooks: {
    user: {
      create: {
        // The very first account on a fresh install becomes the instance
        // administrator; everyone after that is a regular user.
        before: async (user) => {
          const [{ value: existing }] = await db.select({ value: count() }).from(userTable);
          return { data: { ...user, role: existing === 0 ? "admin" : "user" } };
        },
        // Administrators own the "library" organization (top-level images).
        after: async (user) => {
          if (user.role === "admin") await ensureLibraryOrg(user.id);
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
        const url = `${env.appUrl}/accept-invitation/${data.id}`;
        await sendMail({
          to: data.email,
          subject: `Join ${data.organization.name} on Chicorée`,
          text: `${data.inviter.user.name} invited you to the ${data.organization.name} organization: ${url}`,
          html: mailLayout(
            `Join ${data.organization.name}`,
            `<p>${data.inviter.user.name} (${data.inviter.user.email}) invited you to the <strong>${data.organization.name}</strong> organization.</p><p>${buttonHtml(url, "Accept invitation")}</p>`,
          ),
        });
      },
      // Org slugs double as registry namespaces (<slug>/<repo>), so they must
      // be valid OCI path components.
      organizationHooks: {
        beforeCreateOrganization: async ({ organization, user }) => {
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
    twoFactor({
      issuer: "Chicorée Registry",
      otpOptions: {
        sendOTP: async ({ user, otp }) => {
          await sendMail({
            to: user.email,
            subject: `${otp} is your Chicorée verification code`,
            text: `Your verification code is ${otp}`,
            html: mailLayout("Your verification code", `<p>Enter this code to finish signing in.</p>${codeHtml(otp)}`),
          });
        },
      },
    }),
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendMail({
          to: email,
          subject: "Your Chicorée sign-in link",
          text: `Sign in: ${url}`,
          html: mailLayout(
            "Sign in to Chicorée",
            `<p>Use the button below to sign in as ${email}. The link is valid for a few minutes.</p><p>${buttonHtml(url, "Sign in")}</p>`,
          ),
        });
      },
    }),
    emailOTP({
      sendVerificationOTP: async ({ email, otp }) => {
        await sendMail({
          to: email,
          subject: `${otp} is your Chicorée code`,
          text: `Your code is ${otp}`,
          html: mailLayout("Your one-time code", `<p>Enter this code to continue.</p>${codeHtml(otp)}`),
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
