// Audit log writer. `recordAudit` fills in the actor, IP and user agent from
// the current request when the caller does not pass them, works from server
// actions, route handlers and better-auth hooks alike, and never throws —
// an audit failure is logged and the operation goes on.
import { sql } from "drizzle-orm";
import { getSessionFromCtx } from "better-auth/api";
import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { db } from "@/db";
import { auditLog, type AuditActorType } from "@/db/schema";
import { env } from "./env";
import { redactDetails } from "./audit-shared";

export interface AuditActor {
  type: AuditActorType;
  id?: string | null;
  label?: string | null;
  impersonatorId?: string | null;
}

export interface AuditEvent {
  action: string;
  /** Explicit actor; resolved from the session when omitted. */
  actor?: AuditActor;
  organizationId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  details?: Record<string, unknown>;
  /** Request headers to read IP / user agent from (found automatically when omitted). */
  headers?: Headers | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Actor for events the app performs on its own (jobs, webhooks from registryd). */
export const SYSTEM_ACTOR: AuditActor = { type: "system", label: "system" };

export function clientIp(headers: Headers | null | undefined): string | null {
  if (!headers) return null;
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim().slice(0, 64) || null;
  return (headers.get("x-real-ip") ?? headers.get("cf-connecting-ip"))?.trim().slice(0, 64) || null;
}

async function requestHeaders(): Promise<Headers | null> {
  const endpoint = tryGetCurrentAuthEndpointContext();
  if (endpoint?.headers) return endpoint.headers;
  try {
    const { headers } = await import("next/headers");
    return await headers();
  } catch {
    return null;
  }
}

/** Session → actor: the signed-in user, plus the admin behind an impersonation. */
export function sessionActor(s: {
  user: { id: string; email?: string | null; name?: string | null };
  session?: { impersonatedBy?: string | null } | null;
}): AuditActor {
  return {
    type: "user",
    id: s.user.id,
    label: s.user.email ?? s.user.name ?? "",
    impersonatorId: s.session?.impersonatedBy ?? null,
  };
}

async function resolveActor(headers: Headers | null): Promise<AuditActor> {
  // Inside a better-auth endpoint: the session the route resolved, or the
  // cookie's session without re-entering the router.
  const endpoint = tryGetCurrentAuthEndpointContext();
  if (endpoint) {
    const ctx = endpoint as unknown as {
      context: { session?: { user: { id: string; email?: string | null; name?: string | null }; session: { impersonatedBy?: string | null } } | null };
    };
    if (ctx.context.session) return sessionActor(ctx.context.session);
    try {
      const s = await getSessionFromCtx(endpoint as never);
      if (s) return sessionActor(s as never);
    } catch {
      // no usable session in this request
    }
    return SYSTEM_ACTOR;
  }
  if (headers) {
    try {
      const { getAuth } = await import("./auth");
      const auth = await getAuth();
      const s = await auth.api.getSession({ headers });
      if (s) return sessionActor(s);
    } catch {
      // not in a request with a session (build, background work)
    }
  }
  return SYSTEM_ACTOR;
}

let lastPrune = 0;

/** Once an hour, drop rows past AUDIT_RETENTION_DAYS (cheap, fire-and-forget). */
function pruneOpportunistically(): void {
  const now = Date.now();
  if (now - lastPrune < 3_600_000) return;
  lastPrune = now;
  const days = env.auditRetentionDays;
  db.execute(sql`DELETE FROM audit_log WHERE created_at < now() - make_interval(days => ${days})`).catch((err) =>
    console.error("[audit] prune failed:", err),
  );
}

/** Write one audit row. Never throws. */
export async function recordAudit(event: AuditEvent): Promise<void> {
  try {
    const headers = event.headers === undefined ? await requestHeaders() : event.headers;
    const actor = event.actor ?? (await resolveActor(headers));
    await db.insert(auditLog).values({
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorLabel: (actor.label ?? "").slice(0, 200),
      impersonatorId: actor.impersonatorId ?? null,
      action: event.action.slice(0, 80),
      organizationId: event.organizationId ?? null,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      targetLabel: event.targetLabel?.slice(0, 200) ?? null,
      details: redactDetails(event.details),
      ip: event.ip === undefined ? clientIp(headers) : event.ip,
      userAgent: event.userAgent === undefined ? (headers?.get("user-agent")?.slice(0, 256) ?? null) : event.userAgent,
    });
    pruneOpportunistically();
  } catch (err) {
    console.error(`[audit] could not record ${event.action}:`, err);
  }
}
