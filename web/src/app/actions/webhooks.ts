"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, repositories, repositoryWebhooks, tags } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { encryptSecret } from "@/lib/crypto";
import { recordAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import {
  buildPushPayload,
  countWebhooks,
  deliverWebhook,
  findScopedWebhook,
  maxWebhooks,
  resolveActor,
  type WebhookEnvelope,
} from "@/lib/webhooks";
import { eventsForScope, isWebhookEvent, type WebhookScope } from "@/lib/webhooks-shared";

export interface WebhookResult {
  error?: string;
  saved?: boolean;
  tested?: { ok: boolean; status: number | null; error: string | null };
}

type Org = typeof organization.$inferSelect;
type Repo = typeof repositories.$inferSelect;

interface ScopeContext {
  scope: WebhookScope;
  org: Org;
  repo: Repo | null;
  /** Settings page to revalidate. */
  path: string;
}

/** "acme/app" for repository hooks, "acme" for organization hooks (audit labels). */
function scopeLabel(ctx: ScopeContext): string {
  return ctx.repo ? `${ctx.org.slug}/${ctx.repo.name}` : ctx.org.slug;
}

/**
 * Resolve the scope a form talks about (repositoryId or organizationId) and
 * check the caller manages that organization.
 */
async function requireScope(formData: FormData): Promise<ScopeContext | { error: string }> {
  await requireSession();
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const organizationId = String(formData.get("organizationId") ?? "");
  const denied = { error: "Only organization owners and admins can manage webhooks." } as const;
  if (repositoryId) {
    const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
    if (!repo) return { error: "Repository not found." };
    const role = await getOrgRole(repo.organizationId);
    if (!role || !MANAGER_ROLES.includes(role)) return denied;
    const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
    if (!org) return { error: "Organization not found." };
    return { scope: { kind: "repository", repositoryId }, org, repo, path: `/${org.slug}/${repo.name}/settings` };
  }
  if (organizationId) {
    const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
    if (!org) return { error: "Organization not found." };
    const role = await getOrgRole(org.id);
    if (!role || !MANAGER_ROLES.includes(role)) return denied;
    return { scope: { kind: "organization", organizationId }, org, repo: null, path: `/${org.slug}/settings` };
  }
  return { error: "Missing repository or organization." };
}

function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (/^[A-Za-z0-9-]+$/.test(name) && value) out[name] = value;
  }
  return out;
}

export async function saveWebhook(_prev: WebhookResult | null, formData: FormData): Promise<WebhookResult> {
  const ctx = await requireScope(formData);
  if ("error" in ctx) return { error: ctx.error };
  const { scope } = ctx;

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const url = String(formData.get("url") ?? "").trim();
  const method = String(formData.get("method") ?? "POST");
  const authType = String(formData.get("authType") ?? "none");
  const authHeaderName = String(formData.get("authHeaderName") ?? "").trim();
  const authSecretRaw = String(formData.get("authSecret") ?? "");
  const signingSecretRaw = String(formData.get("signingSecret") ?? "");
  const allowed = new Set(eventsForScope(scope.kind).map((e) => e.value));
  const events = [...new Set(formData.getAll("events").map(String))].filter((e) => isWebhookEvent(e) && allowed.has(e));

  if (!name || name.length > 64) return { error: "Give the webhook a name (up to 64 characters)." };
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { error: "Enter a valid URL." };
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) return { error: "Webhook URLs must be http(s)." };
  if (!["POST", "PUT", "PATCH"].includes(method)) return { error: "Invalid method." };
  if (!["none", "bearer", "basic", "header"].includes(authType)) return { error: "Invalid authentication type." };
  if (authType === "header" && !/^[A-Za-z0-9-]+$/.test(authHeaderName)) return { error: "Enter a valid header name." };
  if (events.length === 0) return { error: "Subscribe the webhook to at least one event." };

  const base = {
    name,
    url,
    method: method as "POST" | "PUT" | "PATCH",
    headers: parseHeaders(String(formData.get("headers") ?? "")),
    authType: authType as "none" | "bearer" | "basic" | "header",
    authHeaderName: authType === "header" ? authHeaderName : null,
    events,
  };

  if (id) {
    const existing = await findScopedWebhook(scope, id);
    if (!existing) return { error: "Webhook not found." };
    await db
      .update(repositoryWebhooks)
      .set({
        ...base,
        // Blank secret fields keep the stored value; "-" clears it.
        authSecret:
          authSecretRaw === "" ? (authType === "none" ? null : existing.authSecret) : authSecretRaw === "-" ? null : encryptSecret(authSecretRaw),
        signingSecret:
          signingSecretRaw === "" ? existing.signingSecret : signingSecretRaw === "-" ? null : encryptSecret(signingSecretRaw),
      })
      .where(eq(repositoryWebhooks.id, id));
  } else {
    const max = maxWebhooks(scope);
    if ((await countWebhooks(scope)) >= max) {
      return { error: `${scope.kind === "repository" ? "A repository" : "An organization"} can have at most ${max} webhooks.` };
    }
    const session = await requireSession();
    await db.insert(repositoryWebhooks).values({
      repositoryId: scope.kind === "repository" ? scope.repositoryId : null,
      organizationId: scope.kind === "organization" ? scope.organizationId : null,
      ...base,
      authSecret: authType !== "none" && authSecretRaw ? encryptSecret(authSecretRaw) : null,
      signingSecret: signingSecretRaw ? encryptSecret(signingSecretRaw) : null,
      createdBy: session.user.id,
    });
  }
  await recordAudit({ action: id ? "webhook.update" : "webhook.create", organizationId: ctx.org.id, targetType: "webhook", targetId: id || null, targetLabel: `${scopeLabel(ctx)} · ${name}`, details: { scope: scope.kind, url, method, authType, events: base.events } });
  revalidatePath(ctx.path);
  return { saved: true };
}

export async function deleteWebhook(formData: FormData): Promise<void> {
  const ctx = await requireScope(formData);
  if ("error" in ctx) return;
  const id = String(formData.get("id") ?? "");
  const hook = await findScopedWebhook(ctx.scope, id);
  if (!hook) return;
  await db.delete(repositoryWebhooks).where(eq(repositoryWebhooks.id, hook.id));
  await recordAudit({ action: "webhook.delete", organizationId: ctx.org.id, targetType: "webhook", targetId: hook.id, targetLabel: `${scopeLabel(ctx)} · ${hook.name}` });
  revalidatePath(ctx.path);
}

export async function toggleWebhook(formData: FormData): Promise<void> {
  const ctx = await requireScope(formData);
  if ("error" in ctx) return;
  const id = String(formData.get("id") ?? "");
  const enabled = String(formData.get("enabled")) === "true";
  const hook = await findScopedWebhook(ctx.scope, id);
  if (!hook) return;
  await db.update(repositoryWebhooks).set({ enabled }).where(eq(repositoryWebhooks.id, hook.id));
  await recordAudit({ action: "webhook.toggle", organizationId: ctx.org.id, targetType: "webhook", targetId: hook.id, targetLabel: `${scopeLabel(ctx)} · ${hook.name}`, details: { enabled } });
  revalidatePath(ctx.path);
}

/**
 * Send a test delivery: a push-shaped payload built from the most recent tag
 * of the repository (or of any repository in the organization), or a stub
 * when there is nothing to describe yet.
 */
export async function testWebhook(_prev: WebhookResult | null, formData: FormData): Promise<WebhookResult> {
  const ctx = await requireScope(formData);
  if ("error" in ctx) return { error: ctx.error };
  const id = String(formData.get("id") ?? "");
  const hook = await findScopedWebhook(ctx.scope, id);
  if (!hook) return { error: "Webhook not found." };
  const session = await requireSession();
  const actor = `user:${session.user.id}`;

  let repo = ctx.repo;
  let latest: { name: string; manifestDigest: string } | null = null;
  if (repo) {
    latest =
      (await db.query.tags.findFirst({
        where: eq(tags.repositoryId, repo.id),
        orderBy: [desc(tags.updatedAt)],
      })) ?? null;
  } else {
    const [row] = await db
      .select({ name: tags.name, manifestDigest: tags.manifestDigest, repositoryId: tags.repositoryId })
      .from(tags)
      .innerJoin(repositories, eq(repositories.id, tags.repositoryId))
      .where(eq(repositories.organizationId, ctx.org.id))
      .orderBy(desc(tags.updatedAt))
      .limit(1);
    if (row) {
      latest = row;
      repo = (await db.query.repositories.findFirst({ where: eq(repositories.id, row.repositoryId) })) ?? null;
    } else {
      repo = (await db.query.repositories.findFirst({ where: eq(repositories.organizationId, ctx.org.id) })) ?? null;
    }
  }

  let payload: WebhookEnvelope | null = null;
  if (repo) {
    const built = await buildPushPayload(
      ctx.org.slug,
      repo.name,
      latest?.manifestDigest ?? "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      latest?.name ?? "test",
      actor,
      "test",
    );
    payload = built?.payload ?? null;
  }
  payload ??= {
    event: "test",
    deliveryId: randomUUID(),
    timestamp: new Date().toISOString(),
    registry: env.registryHost,
    repository: null,
    organization: { slug: ctx.org.slug, name: ctx.org.name },
    tag: null,
    image: null,
    actor: await resolveActor(actor),
  } as WebhookEnvelope;

  await deliverWebhook(hook, payload);
  const refreshed = await db.query.repositoryWebhooks.findFirst({ where: eq(repositoryWebhooks.id, hook.id) });
  await recordAudit({ action: "webhook.test", organizationId: ctx.org.id, targetType: "webhook", targetId: hook.id, targetLabel: `${scopeLabel(ctx)} · ${hook.name}`, details: { status: refreshed?.lastStatus ?? null } });
  revalidatePath(ctx.path);
  return {
    tested: {
      ok: !!refreshed?.lastStatus && refreshed.lastStatus >= 200 && refreshed.lastStatus < 300,
      status: refreshed?.lastStatus ?? null,
      error: refreshed?.lastError ?? null,
    },
  };
}
