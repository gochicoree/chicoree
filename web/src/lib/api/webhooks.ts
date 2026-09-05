// Webhook management through the API, for both scopes (organization-wide
// hooks and a repository's own). The handlers are built once per scope by
// `webhookHandlers` and re-exported by the route files. Validation mirrors
// the settings form (app/actions/webhooks.ts); delivery and the test send
// come from lib/webhooks.ts.
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { repositoryWebhooks } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto";
import { decodeRepoParam } from "@/lib/proxy-shared";
import { countWebhooks, findScopedWebhook, listWebhookRows, maxWebhooks, sendTestDelivery, type Hook } from "@/lib/webhooks";
import { eventsForScope, isWebhookEvent, isWebhookFormat, WEBHOOK_FORMATS, type WebhookRow, type WebhookScope } from "@/lib/webhooks-shared";
import { loadOrg, loadRepo, requireManage, requireOrgManager, type OrgRow, type RepoRow } from "./access";
import type { ApiCaller } from "./auth";
import { route } from "./handler";
import { conflict, json, notFound, readJson, unprocessable } from "./respond";

type Kind = "organization" | "repository";
type Params = { org: string; repo?: string; id?: string };

interface ScopeCtx {
  scope: WebhookScope;
  org: OrgRow;
  repo: RepoRow | null;
  /** "acme/app" or "acme", for audit labels. */
  label: string;
  /** Settings page to revalidate. */
  path: string;
}

async function resolveScope(caller: ApiCaller, kind: Kind, params: Params): Promise<ScopeCtx> {
  if (kind === "repository") {
    const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo ?? ""));
    requireManage(caller, a, "manage webhooks here");
    return {
      scope: { kind: "repository", repositoryId: a.repo.id },
      org: a.org,
      repo: a.repo,
      label: `${a.org.slug}/${a.repo.name}`,
      path: `/${a.org.slug}/${a.repo.name}/settings`,
    };
  }
  const a = await loadOrg(caller, params.org);
  requireOrgManager(caller, a, "manage webhooks");
  return { scope: { kind: "organization", organizationId: a.org.id }, org: a.org, repo: null, label: a.org.slug, path: `/${a.org.slug}/settings` };
}

function hookJson(row: WebhookRow, withDeliveries: boolean) {
  const { deliveries, ...rest } = row;
  return withDeliveries ? { ...rest, deliveries } : rest;
}

async function rowById(scope: WebhookScope, id: string): Promise<WebhookRow> {
  const row = (await listWebhookRows(scope)).find((h) => h.id === id);
  if (!row) throw notFound("No such webhook.");
  return row;
}

const METHODS = ["POST", "PUT", "PATCH"] as const;
const AUTH_TYPES = ["none", "bearer", "basic", "header"] as const;

interface Validated {
  name: string;
  url: string;
  method: (typeof METHODS)[number];
  format: (typeof WEBHOOK_FORMATS)[number]["value"];
  headers: Record<string, string>;
  authType: (typeof AUTH_TYPES)[number];
  authHeaderName: string | null;
  events: string[];
  enabled: boolean;
}

/**
 * Validate a create (every field required) or update (fields optional,
 * missing ones keep the stored value) body. Throws 422 with the field.
 */
function validate(kind: Kind, body: Record<string, unknown>, existing: Hook | null): Validated {
  const str = (key: string, max: number): string | undefined => {
    const v = body[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw unprocessable(`"${key}" must be a string.`, { field: key });
    if (v.length > max) throw unprocessable(`"${key}" is longer than ${max} characters.`, { field: key });
    return v.trim();
  };
  const name = str("name", 64) ?? existing?.name ?? "";
  if (!name) throw unprocessable('"name" is required (up to 64 characters).', { field: "name" });
  const url = str("url", 2000) ?? existing?.url ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw unprocessable('"url" must be a valid URL.', { field: "url" });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw unprocessable("Webhook URLs must be http(s).", { field: "url" });
  const format = str("format", 20) ?? existing?.format ?? "json";
  if (!isWebhookFormat(format)) throw unprocessable(`"format" must be one of ${WEBHOOK_FORMATS.map((f) => f.value).join(", ")}.`, { field: "format" });
  // Chat services accept POST only; the method field is for JSON receivers.
  const methodRaw = (str("method", 10) ?? existing?.method ?? "POST").toUpperCase();
  const method = format === "json" ? methodRaw : "POST";
  if (!(METHODS as readonly string[]).includes(method)) throw unprocessable(`"method" must be one of ${METHODS.join(", ")}.`, { field: "method" });
  const authType = str("authType", 10) ?? existing?.authType ?? "none";
  if (!(AUTH_TYPES as readonly string[]).includes(authType)) throw unprocessable(`"authType" must be one of ${AUTH_TYPES.join(", ")}.`, { field: "authType" });
  const authHeaderName = str("authHeaderName", 100) ?? existing?.authHeaderName ?? "";
  if (authType === "header" && !/^[A-Za-z0-9-]+$/.test(authHeaderName)) throw unprocessable('"authHeaderName" must be a valid header name.', { field: "authHeaderName" });

  let headers: Record<string, string> = existing?.headers ?? {};
  if (body.headers !== undefined) {
    if (!body.headers || typeof body.headers !== "object" || Array.isArray(body.headers)) throw unprocessable('"headers" must be an object of header names to values.', { field: "headers" });
    headers = {};
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9-]+$/.test(k) || typeof v !== "string" || !v.trim()) throw unprocessable(`Header "${k}" is not valid.`, { field: "headers" });
      headers[k] = v.trim();
    }
  }
  let events = existing?.events ?? [];
  if (body.events !== undefined) {
    if (!Array.isArray(body.events) || !body.events.every((e) => typeof e === "string")) throw unprocessable('"events" must be an array of event names.', { field: "events" });
    const allowed = new Set(eventsForScope(kind).map((e) => e.value));
    events = [...new Set(body.events as string[])].filter((e) => isWebhookEvent(e) && allowed.has(e));
    const unknown = (body.events as string[]).filter((e) => !allowed.has(e as never));
    if (unknown.length) throw unprocessable(`Unknown events for this scope: ${unknown.join(", ")}. Allowed: ${[...allowed].join(", ")}.`, { field: "events" });
  }
  if (events.length === 0) throw unprocessable("Subscribe the webhook to at least one event.", { field: "events" });
  let enabled = existing?.enabled ?? true;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw unprocessable('"enabled" must be true or false.', { field: "enabled" });
    enabled = body.enabled;
  }
  return {
    name,
    url,
    method: method as Validated["method"],
    format,
    headers,
    authType: authType as Validated["authType"],
    authHeaderName: authType === "header" ? authHeaderName : null,
    events,
    enabled,
  };
}

/** A secret field: undefined keeps the stored value, null clears it, a string sets it. */
function secretField(body: Record<string, unknown>, key: string, current: string | null): string | null {
  const v = body[key];
  if (v === undefined) return current;
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw unprocessable(`"${key}" must be a string or null.`, { field: key });
  return encryptSecret(v);
}

export function webhookHandlers(kind: Kind) {
  const list = route<Params>(async (_req, { caller, params }) => {
    const ctx = await resolveScope(caller, kind, params);
    const rows = await listWebhookRows(ctx.scope);
    return json({ items: rows.map((r) => hookJson(r, false)), total: rows.length, max: maxWebhooks(ctx.scope) });
  });

  const create = route<Params>(async (req, { caller, params }) => {
    const ctx = await resolveScope(caller, kind, params);
    const body = await readJson(req);
    const values = validate(kind, body, null);
    const max = maxWebhooks(ctx.scope);
    if ((await countWebhooks(ctx.scope)) >= max) throw conflict(`${kind === "repository" ? "A repository" : "An organization"} can have at most ${max} webhooks.`);
    const [created] = await db
      .insert(repositoryWebhooks)
      .values({
        repositoryId: ctx.scope.kind === "repository" ? ctx.scope.repositoryId : null,
        organizationId: ctx.scope.kind === "organization" ? ctx.scope.organizationId : null,
        ...values,
        authSecret: values.authType !== "none" ? secretField(body, "authSecret", null) : null,
        signingSecret: secretField(body, "signingSecret", null),
        createdBy: caller.kind === "user" ? caller.user.id : null,
      })
      .returning({ id: repositoryWebhooks.id });
    await recordAudit({
      action: "webhook.create",
      actor: caller.auditActor,
      headers: req.headers,
      organizationId: ctx.org.id,
      targetType: "webhook",
      targetId: created.id,
      targetLabel: `${ctx.label} · ${values.name}`,
      details: { scope: kind, url: values.url, method: values.method, format: values.format, authType: values.authType, events: values.events, via: "api" },
    });
    revalidatePath(ctx.path);
    return json(hookJson(await rowById(ctx.scope, created.id), true), { status: 201 });
  });

  const get = route<Params>(async (_req, { caller, params }) => {
    const ctx = await resolveScope(caller, kind, params);
    return json(hookJson(await rowById(ctx.scope, params.id ?? ""), true));
  });

  const update = route<Params>(async (req, { caller, params }) => {
    const ctx = await resolveScope(caller, kind, params);
    const hook = await findScopedWebhook(ctx.scope, params.id ?? "");
    if (!hook) throw notFound("No such webhook.");
    const body = await readJson(req);
    const values = validate(kind, body, hook);
    await db
      .update(repositoryWebhooks)
      .set({
        ...values,
        authSecret: values.authType === "none" ? null : secretField(body, "authSecret", hook.authSecret),
        signingSecret: secretField(body, "signingSecret", hook.signingSecret),
      })
      .where(eq(repositoryWebhooks.id, hook.id));
    await recordAudit({
      action: "webhook.update",
      actor: caller.auditActor,
      headers: req.headers,
      organizationId: ctx.org.id,
      targetType: "webhook",
      targetId: hook.id,
      targetLabel: `${ctx.label} · ${values.name}`,
      details: { scope: kind, url: values.url, method: values.method, format: values.format, authType: values.authType, events: values.events, enabled: values.enabled, via: "api" },
    });
    revalidatePath(ctx.path);
    return json(hookJson(await rowById(ctx.scope, hook.id), true));
  });

  const remove = route<Params>(async (req, { caller, params }) => {
    const ctx = await resolveScope(caller, kind, params);
    const hook = await findScopedWebhook(ctx.scope, params.id ?? "");
    if (!hook) throw notFound("No such webhook.");
    await db.delete(repositoryWebhooks).where(eq(repositoryWebhooks.id, hook.id));
    await recordAudit({
      action: "webhook.delete",
      actor: caller.auditActor,
      headers: req.headers,
      organizationId: ctx.org.id,
      targetType: "webhook",
      targetId: hook.id,
      targetLabel: `${ctx.label} · ${hook.name}`,
      details: { via: "api" },
    });
    revalidatePath(ctx.path);
    return json({ deleted: hook.id });
  });

  const test = route<Params>(async (req, { caller, params }) => {
    const ctx = await resolveScope(caller, kind, params);
    const hook = await findScopedWebhook(ctx.scope, params.id ?? "");
    if (!hook) throw notFound("No such webhook.");
    const tested = await sendTestDelivery(ctx.org, ctx.repo, hook, caller.subject);
    await recordAudit({
      action: "webhook.test",
      actor: caller.auditActor,
      headers: req.headers,
      organizationId: ctx.org.id,
      targetType: "webhook",
      targetId: hook.id,
      targetLabel: `${ctx.label} · ${hook.name}`,
      details: { status: tested.status, via: "api" },
    });
    revalidatePath(ctx.path);
    return json(tested);
  });

  return { list, create, get, update, remove, test };
}
