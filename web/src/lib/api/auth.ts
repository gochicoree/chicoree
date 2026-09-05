// Who is calling the REST API. Three credentials work, in this order of
// precedence: a personal access token or service-account secret in the
// Authorization header (Bearer, or Basic with the secret as the password —
// what `curl -u` sends), else the browser session cookie, else anonymous.
// A malformed or unknown Authorization header is an error, never a silent
// fall-through to anonymous.
import type { NextRequest } from "next/server";
import { getAuth } from "@/lib/auth";
import { identifyAccessToken, identifyServiceAccount } from "@/lib/credential-auth";
import { CI_PREFIX, PAT_PREFIX, SA_PREFIX } from "@/lib/secrets";
import { identifyCiToken } from "@/lib/ci-auth";
import { clientIp, type AuditActor } from "@/lib/audit";
import type { Caller } from "@/lib/access";
import { ANONYMOUS, viewerFromSession, type Viewer } from "@/lib/viewer";
import { db } from "@/db";
import { serviceAccounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { forbidden, unauthorized } from "./respond";

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  role: string;
  emailVerified: boolean;
}

export interface ApiTokenInfo {
  id: string;
  name: string;
  scope: "read" | "write";
  expiresAt: Date | null;
  organizationId: string | null;
  repositoryIds: string[] | null;
}

export interface ApiServiceAccount {
  id: string;
  name: string;
  organizationId: string;
  permission: "pull" | "push" | "admin";
  repositoryIds: string[] | null;
  expiresAt: Date | null;
}

export type ApiCaller =
  | { kind: "anonymous"; via: "none"; viewer: Viewer; caller: Caller; subject: string; auditActor: AuditActor }
  | {
      kind: "user";
      via: "token" | "session";
      viewer: Viewer;
      caller: Extract<Caller, { kind: "user" }>;
      user: ApiUser;
      token: ApiTokenInfo | null;
      subject: string;
      auditActor: AuditActor;
    }
  | {
      kind: "sa";
      via: "service-account" | "ci";
      viewer: Viewer;
      caller: Extract<Caller, { kind: "sa" }>;
      sa: ApiServiceAccount;
      subject: string;
      auditActor: AuditActor;
    };

/** The secret out of `Bearer <secret>` or `Basic base64(<anything>:<secret>)`. */
function credentialFromHeader(header: string): string | null {
  const [scheme, ...rest] = header.trim().split(/\s+/);
  const value = rest.join(" ");
  if (!scheme || !value) return null;
  if (/^bearer$/i.test(scheme)) return value.trim();
  if (/^basic$/i.test(scheme)) {
    let decoded = "";
    try {
      decoded = Buffer.from(value, "base64").toString("utf8");
    } catch {
      return null;
    }
    const colon = decoded.indexOf(":");
    // Either side may carry the secret: `-u token:` and `-u user:token` both work.
    const user = colon < 0 ? decoded : decoded.slice(0, colon);
    const password = colon < 0 ? "" : decoded.slice(colon + 1);
    return password || user;
  }
  return null;
}

export async function authenticate(req: NextRequest): Promise<ApiCaller> {
  const header = req.headers.get("authorization");
  if (header) {
    const secret = credentialFromHeader(header);
    if (!secret) throw unauthorized("Send the credential as `Authorization: Bearer <token>`.");
    const ip = clientIp(req.headers);

    if (secret.startsWith(PAT_PREFIX)) {
      const res = await identifyAccessToken(secret, ip);
      if ("error" in res) throw unauthorized(`Access token refused: ${res.error}.`);
      return {
        kind: "user",
        via: "token",
        viewer: { kind: "user", userId: res.user.id, isAdmin: res.user.role === "admin" },
        caller: res.caller,
        user: { id: res.user.id, name: res.user.name, email: res.user.email, role: res.user.role ?? "user", emailVerified: !!res.user.emailVerified },
        token: {
          id: res.token.id,
          name: res.token.name,
          scope: res.token.scope,
          expiresAt: res.token.expiresAt ?? null,
          organizationId: res.token.organizationId ?? null,
          repositoryIds: res.token.repositoryIds ?? null,
        },
        subject: `user:${res.user.id}`,
        auditActor: { type: "user", id: res.user.id, label: res.user.email },
      };
    }

    if (secret.startsWith(SA_PREFIX)) {
      const res = await identifyServiceAccount(secret, ip);
      if ("error" in res) throw unauthorized(`Service account refused: ${res.error}.`);
      const row = await db.query.serviceAccounts.findFirst({ where: eq(serviceAccounts.id, res.saId) });
      return {
        kind: "sa",
        via: "service-account",
        viewer: ANONYMOUS,
        caller: res,
        sa: {
          id: res.saId,
          name: row?.name ?? res.saId,
          organizationId: res.organizationId,
          permission: res.permission,
          repositoryIds: res.repositoryIds,
          expiresAt: row?.expiresAt ?? null,
        },
        subject: `sa:${res.saId}`,
        auditActor: { type: "sa", id: res.saId, label: row?.name ?? res.saId },
      };
    }

    if (secret.startsWith(CI_PREFIX)) {
      const res = await identifyCiToken(secret);
      if ("error" in res) throw unauthorized(`CI token refused: ${res.error}.`);
      return {
        kind: "sa",
        via: "ci",
        viewer: ANONYMOUS,
        caller: res.caller,
        sa: {
          id: res.caller.saId,
          name: res.identity.name,
          organizationId: res.identity.organizationId,
          permission: res.identity.permission,
          repositoryIds: res.identity.repositoryIds ?? null,
          expiresAt: res.expiresAt,
        },
        subject: `sa:${res.caller.saId}`,
        auditActor: { type: "sa", id: res.caller.saId, label: `ci:${res.identity.name} (${res.oidcSubject})` },
      };
    }

    throw unauthorized("Unknown credential: personal access tokens (chc_pat_…), service-account secrets (chc_sa_…) and CI tokens (chc_ci_…) are accepted.");
  }

  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (session) {
    const u = session.user;
    return {
      kind: "user",
      via: "session",
      viewer: viewerFromSession(session),
      caller: { kind: "user", userId: u.id, isAdmin: u.role === "admin", patScope: null, restriction: null },
      user: { id: u.id, name: u.name, email: u.email, role: u.role ?? "user", emailVerified: !!u.emailVerified },
      token: null,
      subject: `user:${u.id}`,
      auditActor: { type: "user", id: u.id, label: u.email, impersonatorId: session.session.impersonatedBy ?? null },
    };
  }

  return {
    kind: "anonymous",
    via: "none",
    viewer: ANONYMOUS,
    caller: { kind: "anonymous" },
    subject: "anonymous",
    auditActor: { type: "system", label: "anonymous" },
  };
}

/** Any credential at all. */
export function requireAuthenticated(c: ApiCaller): Exclude<ApiCaller, { kind: "anonymous" }> {
  if (c.kind === "anonymous") throw unauthorized();
  return c;
}

/** A user (token or session), not a service account. */
export function requireUser(c: ApiCaller): Extract<ApiCaller, { kind: "user" }> {
  if (c.kind === "anonymous") throw unauthorized();
  if (c.kind === "sa") throw forbidden("Service accounts cannot use this endpoint; use a personal access token.");
  return c;
}

export function isReadOnlyToken(c: ApiCaller): boolean {
  return c.kind === "user" && c.caller.patScope === "read";
}
