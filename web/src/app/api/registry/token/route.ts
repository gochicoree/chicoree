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
import { account as accountTable, user as userTable } from "@/db/schema";
import {
  allowedRepositoryActions,
  callerSubject,
  mayAccessCatalog,
  type Caller,
  type RegistryAction,
} from "@/lib/access";
import { clientIp } from "@/lib/audit";
import { identifyAccessToken, identifyServiceAccount } from "@/lib/credential-auth";
import { CI_PREFIX, PAT_PREFIX, SA_PREFIX } from "@/lib/secrets";
import { identifyCiToken } from "@/lib/ci-auth";
import { signRegistryToken, type AccessGrant } from "@/lib/registry-jwt";
import { splitImagePath } from "@/lib/library";
import { resolveRepositoryRedirect } from "@/lib/redirects";
import { getInstanceSettings } from "@/lib/instance-settings";
import { authenticateLdap, LdapError } from "@/lib/ldap";
import { isBanned, provisionLdapUser, type UserStore } from "@/lib/auth-ldap";
import { recordAudit } from "@/lib/audit";
import {
  ACCOUNT_MAX_FAILURES,
  accountKey,
  clearLoginFailures,
  IP_MAX_FAILURES,
  ipKey,
  lockMessage,
  loginLock,
  recordLoginFailure,
} from "@/lib/login-throttle";

export const dynamic = "force-dynamic";

interface Refusal {
  error: string;
  /** Seconds until a locked client may try again (sent as Retry-After). */
  retryAfter?: number;
}

function unauthorized(refusal: Refusal) {
  return NextResponse.json(
    { errors: [{ code: "UNAUTHORIZED", message: refusal.error }] },
    { status: 401, headers: refusal.retryAfter ? { "Retry-After": String(refusal.retryAfter) } : undefined },
  );
}

/**
 * Count a failed docker login against the address (and the account, for
 * password attempts) and write it to the audit log. Returns the refusal to
 * send — the lock message once the limit is hit, else the original one.
 */
async function failed(req: NextRequest, username: string, method: "password" | "ldap" | "token", refusal: Refusal): Promise<Refusal> {
  const ip = clientIp(req.headers);
  const lock = await recordLoginFailure([
    { key: ipKey(ip), max: IP_MAX_FAILURES },
    ...(method === "token" ? [] : [{ key: accountKey(username), max: ACCOUNT_MAX_FAILURES }]),
  ]).catch((err) => {
    console.error("login throttle update failed:", err);
    return null;
  });
  await recordAudit({
    action: "registry.login.failed",
    actor: { type: "user", id: null, label: username || null },
    targetType: username ? "email" : null,
    targetLabel: username || null,
    details: { method, reason: refusal.error, ...(lock ? { lockedUntil: lock.lockedUntil.toISOString() } : {}) },
    headers: req.headers,
  });
  if (lock) {
    const retryAfter = Math.max(1, Math.ceil((lock.lockedUntil.getTime() - Date.now()) / 1000));
    return { error: lockMessage(retryAfter), retryAfter };
  }
  return refusal;
}

async function identify(req: NextRequest): Promise<Caller | Refusal> {
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
  const ip = clientIp(req.headers);

  // A locked address or account is refused before any credential is
  // checked, so guessing cannot continue while the lock lasts.
  const lock = await loginLock([ipKey(ip), accountKey(username)]).catch((err) => {
    console.error("login throttle lookup failed:", err);
    return null;
  });
  if (lock) return { error: lockMessage(lock.retryAfterSeconds), retryAfter: lock.retryAfterSeconds };

  // Opaque credentials: expiry, restriction and last-use bookkeeping live in
  // lib/credential-auth.ts (shared with the jobs API).
  if (password.startsWith(SA_PREFIX)) {
    const res = await identifyServiceAccount(password, ip);
    return "error" in res ? failed(req, username, "token", res) : res;
  }

  // Short-lived CI credentials minted from a workflow's OIDC token (lib/ci-auth.ts).
  if (password.startsWith(CI_PREFIX)) {
    const res = await identifyCiToken(password);
    return "error" in res ? failed(req, username, "token", res) : res.caller;
  }

  if (password.startsWith(PAT_PREFIX)) {
    const res = await identifyAccessToken(password, ip);
    return "error" in res ? failed(req, username, "token", res) : res.caller;
  }

  // Fall back to a password, but never around two-factor auth. Local
  // accounts verify against their own hash; otherwise the directory decides.
  const u = await db.query.user.findFirst({ where: eq(userTable.email, username.toLowerCase()) });
  if (u?.banned) return failed(req, username, "password", { error: "account unavailable" });
  if (u?.twoFactorEnabled) {
    return { error: "this account uses two-factor auth; docker login with an access token instead" };
  }
  const credential = u
    ? await db.query.account.findFirst({
        where: and(eq(accountTable.userId, u.id), eq(accountTable.providerId, "credential")),
      })
    : null;
  if (u && credential?.password) {
    if ((await getInstanceSettings()).access.localSignIn !== "everyone") {
      return { error: "password sign-in is disabled on this registry; docker login with an access token instead" };
    }
    const ctx = await (await getAuth()).$context;
    const valid = await ctx.password.verify({ hash: credential.password, password });
    if (!valid) return failed(req, username, "password", { error: "invalid credentials" });
    await clearLoginFailures(accountKey(username));
    return { kind: "user", userId: u.id, isAdmin: u.role === "admin", patScope: null };
  }
  if ((await getInstanceSettings()).ldap.enabled) {
    const res = await identifyViaLdap(username, password);
    if ("error" in res) return res.invalidCredentials ? failed(req, username, "ldap", res) : res;
    await clearLoginFailures(accountKey(username));
    return res;
  }
  if (!u) {
    return failed(req, username, "password", {
      error: username.includes("@")
        ? "invalid credentials"
        : "invalid credentials: use your email address as the username (or an access token as the password)",
    });
  }
  return { error: "this account has no password; docker login with an access token instead" };
}

/** `docker login` with directory credentials; provisions the account like the browser flow. */
async function identifyViaLdap(username: string, password: string): Promise<Caller | (Refusal & { invalidCredentials: boolean })> {
  try {
    const identity = await authenticateLdap(username, password);
    const ctx = await (await getAuth()).$context;
    const user = await provisionLdapUser(ctx.internalAdapter as unknown as UserStore, identity);
    if (isBanned(user)) return { error: "account unavailable", invalidCredentials: true };
    if (user.twoFactorEnabled) {
      return { error: "this account uses two-factor auth; docker login with an access token instead", invalidCredentials: false };
    }
    return { kind: "user", userId: user.id, isAdmin: user.role === "admin", patScope: null };
  } catch (e) {
    if (e instanceof LdapError) {
      return { error: e.invalidCredentials ? "invalid credentials" : e.message, invalidCredentials: e.invalidCredentials };
    }
    // Sign-up policy refusals (closed / invite-only / domain list) from the user hook.
    if (isAPIError(e)) return { error: e.message, invalidCredentials: false };
    console.error("LDAP docker login failed", e);
    return { error: "directory server unavailable", invalidCredentials: false };
  }
}

const VALID_ACTIONS: RegistryAction[] = ["pull", "push", "delete"];

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const scopes = url.searchParams.getAll("scope");

  const caller = await identify(req);
  if ("error" in caller) return unauthorized(caller);

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
    let granted = moved
      ? await allowedRepositoryActions(caller, moved.orgSlug, moved.repoName, requested.filter((a) => a === "pull"))
      : await allowedRepositoryActions(caller, target.orgSlug, target.repoName, requested);
    // Callers who may push get "push" on their pull tokens as well: the
    // signature pull policy lets such tokens read an unsigned image (they
    // are the ones who sign it), and cosign reads with a pull-only scope
    // before it pushes the signature. Nothing else in registryd keys on it.
    if (!moved && granted.includes("pull") && !granted.includes("push") && !requested.includes("push")) {
      const extra = await allowedRepositoryActions(caller, target.orgSlug, target.repoName, ["push"]);
      if (extra.includes("push")) granted = [...granted, "push"];
    }
    if (granted.length > 0) {
      access.push({ type: "repository", name, actions: granted });
    }
  }

  // Instance administrators always carry the catalog grant, so registryd
  // recognises them (they are exempt from pull rate limits) whatever scope
  // the client asked for — admins may do everything anyway. A token limited
  // to one organization is not an instance-wide credential, so it does not.
  if (caller.kind === "user" && caller.isAdmin && !caller.restriction && !access.some((g) => g.type === "registry" && g.name === "catalog")) {
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
