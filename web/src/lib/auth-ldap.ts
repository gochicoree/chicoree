// better-auth plugin exposing POST /api/auth/sign-in/ldap, plus the
// find-or-create logic shared with the docker token endpoint.
import { randomBytes } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { db } from "@/db";
import { twoFactor as twoFactorTable } from "@/db/schema";
import { authenticateLdap, LdapError, syncLdapBindings, type LdapIdentity } from "./ldap";

export const LDAP_PROVIDER_ID = "ldap";

/** Local user row with the plugin-added columns this code cares about. */
export interface LocalUser {
  id: string;
  email: string;
  name: string;
  role?: string | null;
  banned?: boolean | null;
  banExpires?: Date | null;
  twoFactorEnabled?: boolean | null;
}

/** The slice of better-auth's internal adapter the provisioning needs. */
export interface UserStore {
  findUserByEmail(
    email: string,
    options?: { includeAccounts?: boolean },
  ): Promise<{ user: LocalUser; accounts: { providerId: string }[] } | null>;
  createUser(user: { email: string; name: string; emailVerified: boolean }): Promise<LocalUser>;
  linkAccount(account: { userId: string; providerId: string; accountId: string; issuer: string }): Promise<unknown>;
  findUserById(id: string): Promise<LocalUser | null>;
}

/**
 * Find or create the local account for a directory identity, link the LDAP
 * account row, and apply group bindings. Returns the fresh user row.
 */
export async function provisionLdapUser(store: UserStore, identity: LdapIdentity): Promise<LocalUser> {
  const found = await store.findUserByEmail(identity.email, { includeAccounts: true });
  const user =
    found?.user ?? (await store.createUser({ email: identity.email, name: identity.name, emailVerified: true }));
  if (!found?.accounts.some((a) => a.providerId === LDAP_PROVIDER_ID)) {
    await store.linkAccount({
      userId: user.id,
      providerId: LDAP_PROVIDER_ID,
      accountId: identity.dn,
      issuer: createLocalAccountIssuer(LDAP_PROVIDER_ID),
    });
  }
  await syncLdapBindings(user.id, identity.groups);
  return (await store.findUserById(user.id)) ?? user;
}

export function isBanned(user: LocalUser): boolean {
  if (!user.banned) return false;
  return !user.banExpires || new Date(user.banExpires).getTime() > Date.now();
}

export function ldap(): BetterAuthPlugin {
  return {
    id: "ldap",
    endpoints: {
      signInLdap: createAuthEndpoint(
        "/sign-in/ldap",
        {
          method: "POST",
          body: z.object({
            username: z.string().min(1).max(256),
            password: z.string().min(1).max(1024),
            callbackURL: z.string().optional(),
            rememberMe: z.boolean().optional(),
          }),
        },
        async (ctx) => {
          let identity: LdapIdentity;
          try {
            identity = await authenticateLdap(ctx.body.username, ctx.body.password);
          } catch (e) {
            if (e instanceof LdapError) {
              throw new APIError(e.invalidCredentials ? "UNAUTHORIZED" : "BAD_REQUEST", { message: e.message });
            }
            ctx.context.logger.error("LDAP sign-in failed", e);
            throw new APIError("SERVICE_UNAVAILABLE", { message: "The directory server could not be reached" });
          }

          const user = await provisionLdapUser(ctx.context.internalAdapter as unknown as UserStore, identity);
          if (isBanned(user)) throw new APIError("FORBIDDEN", { message: "This account is suspended" });

          // The two-factor plugin only intercepts its own sign-in routes, so
          // raise the same challenge it would: a pending-2FA cookie backed by
          // verification rows that /two-factor/verify-* consume.
          if (user.twoFactorEnabled) {
            const maxAge = 600;
            const cookie = ctx.context.createAuthCookie("two_factor", { maxAge });
            const identifier = `2fa-${randomBytes(15).toString("base64url")}`;
            const expiresAt = new Date(Date.now() + maxAge * 1000);
            await ctx.context.internalAdapter.createVerificationValue({ value: user.id, identifier, expiresAt });
            await ctx.context.internalAdapter.createVerificationValue({
              value: "0",
              identifier: `2fa-attempts-${identifier}`,
              expiresAt,
            });
            await ctx.setSignedCookie(cookie.name, identifier, ctx.context.secret, cookie.attributes);
            const totp = await db.query.twoFactor.findFirst({ where: eq(twoFactorTable.userId, user.id) });
            return ctx.json({
              twoFactorRedirect: true,
              twoFactorMethods: [...(totp && totp.verified !== false ? ["totp"] : []), "otp"],
            });
          }

          const dontRemember = ctx.body.rememberMe === false;
          const session = await ctx.context.internalAdapter.createSession(user.id, dontRemember);
          if (!session) throw new APIError("UNAUTHORIZED", { message: "Failed to create session" });
          await setSessionCookie(ctx, { session, user: user as never }, dontRemember);
          if (ctx.body.callbackURL) ctx.setHeader("Location", ctx.body.callbackURL);
          return ctx.json({
            redirect: !!ctx.body.callbackURL,
            token: session.token,
            url: ctx.body.callbackURL,
            user: { id: user.id, email: user.email, name: user.name },
          });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
