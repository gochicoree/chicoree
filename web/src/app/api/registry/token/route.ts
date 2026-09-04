// Docker Registry v2 token endpoint. registryd challenges clients with
//   WWW-Authenticate: Bearer realm="<this route>",service=...,scope=...
// and docker/podman/oras call back here with Basic credentials. We accept
// personal access tokens (chc_pat_…) and service account credentials (chc_sa_…)
// as the password — or an account password for users without 2FA (local, or
// the directory password when LDAP is configured) — authorize the requested
// scopes, and answer with a short-lived ES256 JWT.
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { isAPIError } from "better-auth/api";
import { getAuth } from "@/lib/auth";
import { db } from "@/db";
import {
  accessTokens,
  account as accountTable,
  serviceAccounts,
  user as userTable,
} from "@/db/schema";
import {
  allowedRepositoryActions,
  callerSubject,
  findServiceAccountByHash,
  mayAccessCatalog,
  type Caller,
  type RegistryAction,
} from "@/lib/access";
import { hashSecret, PAT_PREFIX, SA_PREFIX } from "@/lib/secrets";
import { signRegistryToken, type AccessGrant } from "@/lib/registry-jwt";
import { splitImagePath } from "@/lib/library";
import { resolveRepositoryRedirect } from "@/lib/redirects";
import { getInstanceSettings } from "@/lib/instance-settings";
import { authenticateLdap, LdapError } from "@/lib/ldap";
import { isBanned, provisionLdapUser, type UserStore } from "@/lib/auth-ldap";

export const dynamic = "force-dynamic";

function unauthorized(message: string) {
  return NextResponse.json(
    { errors: [{ code: "UNAUTHORIZED", message }] },
    { status: 401 },
  );
}

async function identify(req: NextRequest): Promise<Caller | { error: string }> {
  const header = req.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("basic ")) return { kind: "anonymous" };

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return { error: "malformed authorization header" };
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return { error: "malformed basic credentials" };
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);

  if (password.startsWith(SA_PREFIX)) {
    const sa = await findServiceAccountByHash(hashSecret(password));
    if (!sa) return { error: "unknown service account credential" };
    if (sa.expiresAt && sa.expiresAt < new Date()) return { error: "service account credential expired" };
    db.update(serviceAccounts)
      .set({ lastUsedAt: new Date() })
      .where(eq(serviceAccounts.id, sa.id))
      .catch(() => {});
    return {
      kind: "sa",
      saId: sa.id,
      organizationId: sa.organizationId,
      permission: sa.permission,
      repositoryIds: sa.repositoryIds ?? null,
    };
  }

  if (password.startsWith(PAT_PREFIX)) {
    const pat = await db.query.accessTokens.findFirst({
      where: eq(accessTokens.tokenHash, hashSecret(password)),
    });
    if (!pat) return { error: "unknown access token" };
    if (pat.expiresAt && pat.expiresAt < new Date()) return { error: "access token expired" };
    db.update(accessTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(accessTokens.id, pat.id))
      .catch(() => {});
    const u = await db.query.user.findFirst({ where: eq(userTable.id, pat.userId) });
    if (!u || u.banned) return { error: "account unavailable" };
    return { kind: "user", userId: u.id, isAdmin: u.role === "admin", patScope: pat.scope };
  }

  // Fall back to a password, but never around two-factor auth. Local
  // accounts verify against their own hash; otherwise the directory decides.
  const u = await db.query.user.findFirst({ where: eq(userTable.email, username.toLowerCase()) });
  if (u?.banned) return { error: "account unavailable" };
  if (u?.twoFactorEnabled) {
    return { error: "this account uses two-factor auth; docker login with an access token instead" };
  }
  const credential = u
    ? await db.query.account.findFirst({
        where: and(eq(accountTable.userId, u.id), eq(accountTable.providerId, "credential")),
      })
    : null;
  if (u && credential?.password) {
    const ctx = await (await getAuth()).$context;
    const valid = await ctx.password.verify({ hash: credential.password, password });
    if (!valid) return { error: "invalid credentials" };
    return { kind: "user", userId: u.id, isAdmin: u.role === "admin", patScope: null };
  }
  if ((await getInstanceSettings()).ldap.enabled) return identifyViaLdap(username, password);
  if (!u) {
    return {
      error: username.includes("@")
        ? "invalid credentials"
        : "invalid credentials: use your email address as the username (or an access token as the password)",
    };
  }
  return { error: "this account has no password; docker login with an access token instead" };
}

/** `docker login` with directory credentials; provisions the account like the browser flow. */
async function identifyViaLdap(username: string, password: string): Promise<Caller | { error: string }> {
  try {
    const identity = await authenticateLdap(username, password);
    const ctx = await (await getAuth()).$context;
    const user = await provisionLdapUser(ctx.internalAdapter as unknown as UserStore, identity);
    if (isBanned(user)) return { error: "account unavailable" };
    if (user.twoFactorEnabled) {
      return { error: "this account uses two-factor auth; docker login with an access token instead" };
    }
    return { kind: "user", userId: user.id, isAdmin: user.role === "admin", patScope: null };
  } catch (e) {
    if (e instanceof LdapError) return { error: e.invalidCredentials ? "invalid credentials" : e.message };
    // Sign-up policy refusals (closed / invite-only / domain list) from the user hook.
    if (isAPIError(e)) return { error: e.message };
    console.error("LDAP docker login failed", e);
    return { error: "directory server unavailable" };
  }
}

const VALID_ACTIONS: RegistryAction[] = ["pull", "push", "delete"];

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const scopes = url.searchParams.getAll("scope");

  const caller = await identify(req);
  if ("error" in caller) return unauthorized(caller.error);

  const access: AccessGrant[] = [];
  for (const scope of scopes) {
    // scope = repository:<org>/<repo>:pull,push  |  registry:catalog:*
    const parts = scope.split(":");
    if (parts.length !== 3) continue;
    const [type, name, actionsRaw] = parts;

    if (type === "registry" && name === "catalog") {
      if (await mayAccessCatalog(caller)) {
        access.push({ type: "registry", name: "catalog", actions: ["*"] });
      }
      continue;
    }
    if (type !== "repository") continue;
    const target = splitImagePath(name);
    if (!target) continue;
    // skopeo / containers-image ask for `repository:<name>:*` before deleting;
    // a wildcard means every action, filtered by what the caller may do.
    const requested = actionsRaw
      .split(",")
      .flatMap((a) => (a === "*" ? VALID_ACTIONS : [a]))
      .filter((a): a is RegistryAction => (VALID_ACTIONS as string[]).includes(a));
    // A renamed or transferred repository keeps answering pulls under its
    // former name: authorize those against the target, never for writes.
    const moved = await resolveRepositoryRedirect(target.orgSlug, target.repoName);
    const granted = moved
      ? await allowedRepositoryActions(caller, moved.orgSlug, moved.repoName, requested.filter((a) => a === "pull"))
      : await allowedRepositoryActions(caller, target.orgSlug, target.repoName, requested);
    if (granted.length > 0) {
      access.push({ type: "repository", name, actions: granted });
    }
  }

  // Instance administrators always carry the catalog grant, so registryd
  // recognises them (they are exempt from pull rate limits) whatever scope
  // the client asked for — admins may do everything anyway.
  if (caller.kind === "user" && caller.isAdmin && !access.some((g) => g.type === "registry" && g.name === "catalog")) {
    access.push({ type: "registry", name: "catalog", actions: ["*"] });
  }

  const { token, issuedAt, expiresIn } = await signRegistryToken(callerSubject(caller), access);
  return NextResponse.json({
    token,
    access_token: token,
    expires_in: expiresIn,
    issued_at: issuedAt,
  });
}
