// Outbound webhooks: build event payloads and deliver them to every enabled
// hook of a repository — its own hooks plus the organization-wide ones —
// recording each attempt. The push payload keeps its original shape; every
// other event shares the same envelope (event, timestamp, repository, …)
// with event-specific fields next to it.
import { randomUUID, createHmac } from "crypto";
import { chatMessage, encodeChatMessage } from "./webhook-chat";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  manifests,
  organization,
  repositories,
  repositoryWebhooks,
  serviceAccounts,
  tags as tagsTable,
  user as userTable,
  webhookDeliveries,
} from "@/db/schema";
import { decryptSecret } from "./crypto";
import { env } from "./env";
import { imagePath, imageReference } from "./library";
import { WEBHOOK_LOG_MAX } from "./paginate-shared";
import {
  MAX_WEBHOOKS_PER_ORG,
  MAX_WEBHOOKS_PER_REPO,
  type WebhookEvent,
  type WebhookRow,
  type WebhookScope,
} from "./webhooks-shared";

export { MAX_WEBHOOKS_PER_ORG, MAX_WEBHOOKS_PER_REPO };
export type { WebhookEvent, WebhookRow, WebhookScope };

export interface WebhookRepository {
  id: string;
  name: string;
  path: string;
  organization: { slug: string; name: string };
  visibility: string;
  url: string;
}

/** Fields every delivery carries. Push payloads extend it (see WebhookPayload). */
export interface WebhookEnvelope {
  event: string;
  deliveryId: string;
  timestamp: string;
  registry: string;
  /** null for organization-level events such as quota.warning */
  repository: WebhookRepository | null;
}

export interface WebhookActor {
  type: string;
  id: string | null;
  name: string | null;
}

/** The push payload — unchanged for backwards compatibility. */
export interface WebhookPayload extends WebhookEnvelope {
  event: "push" | "test";
  repository: WebhookRepository;
  tag: string | null;
  image: {
    reference: string;
    digestReference: string;
    digest: string;
    mediaType: string;
    manifestSize: number;
    totalSize: number;
    layerCount: number;
    isIndex: boolean;
    layers: { digest: string; size: number; mediaType: string }[];
    platform: { os?: string; architecture?: string; variant?: string } | null;
    config: {
      entrypoint?: string[];
      cmd?: string[];
      workingDir?: string;
      user?: string;
      labels?: Record<string, string>;
      exposedPorts?: string[];
    } | null;
    url: string;
  } | null;
  actor: WebhookActor | null;
}

/**
 * Payload of a `retention.completed` event. The retention job calls
 * emitRepositoryEvent(repositoryId, "retention.completed", payload).
 */
export interface RetentionCompletedPayload {
  dryRun: boolean;
  /** Tags removed (or that would be removed in a dry run). */
  deletedTags: string[];
  /** Manifest digests that lost their last tag. */
  deletedDigests: string[];
  /** Tags that survived the run. */
  keptTags?: number;
  /** Free-form description of the rule that ran, e.g. "keep 10, older than 30d". */
  policy?: string;
  actor?: WebhookActor | null;
}

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
}

export async function resolveActor(actor: string | undefined | null): Promise<WebhookActor | null> {
  if (!actor) return null;
  const [type, id] = actor.split(":");
  if (type === "user" && id) {
    const u = await db.query.user.findFirst({ where: eq(userTable.id, id) });
    return { type, id, name: u?.name ?? null };
  }
  if (type === "sa" && id) {
    const sa = await db.query.serviceAccounts.findFirst({ where: eq(serviceAccounts.id, id) });
    return { type: "service_account", id, name: sa?.name ?? null };
  }
  if (type === "mirror" && id) return { type: "mirror", id, name: null };
  return { type: "anonymous", id: null, name: null };
}

/** Repository block of the envelope, plus the ids the dispatcher needs. */
export async function repositoryInfo(
  repositoryId: string,
): Promise<{ repository: WebhookRepository; organizationId: string } | null> {
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return null;
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) return null;
  return {
    organizationId: org.id,
    repository: {
      id: repo.id,
      name: repo.name,
      path: imagePath(org.slug, repo.name),
      organization: { slug: org.slug, name: org.name },
      visibility: repo.visibility,
      url: `${env.appUrl}/${org.slug}/${repo.name}`,
    },
  };
}

function envelope(event: string, repository: WebhookRepository | null): WebhookEnvelope {
  return { event, deliveryId: randomUUID(), timestamp: new Date().toISOString(), registry: env.registryHost, repository };
}

/** Tags of a repository currently pointing at a digest. */
export async function tagsForDigest(repositoryId: string, digest: string): Promise<string[]> {
  const rows = await db.query.tags.findMany({
    where: and(eq(tagsTable.repositoryId, repositoryId), eq(tagsTable.manifestDigest, digest)),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
  return rows.map((r) => r.name);
}

/** Assemble the payload for a manifest push. */
export async function buildPushPayload(
  orgSlug: string,
  repoName: string,
  digest: string,
  tag: string | null,
  actor?: string,
  event: "push" | "test" = "push",
): Promise<{ payload: WebhookPayload; repositoryId: string } | null> {
  const org = await db.query.organization.findFirst({ where: eq(organization.slug, orgSlug) });
  if (!org) return null;
  const repo = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, org.id), eq(repositories.name, repoName)),
  });
  if (!repo) return null;

  const path = imagePath(orgSlug, repoName);
  const repoUrl = `${env.appUrl}/${orgSlug}/${repoName}`;

  let image: WebhookPayload["image"] = null;
  const m = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)),
  });
  if (m) {
    let parsed: { config?: Descriptor; layers?: Descriptor[]; manifests?: Descriptor[] } = {};
    try {
      parsed = JSON.parse(m.payload);
    } catch {
      /* keep empty */
    }
    const layers = (parsed.layers ?? []).map((l) => ({
      digest: l.digest ?? "",
      size: l.size ?? 0,
      mediaType: l.mediaType ?? "",
    }));
    const cfg = (m.config ?? null) as {
      os?: string;
      architecture?: string;
      variant?: string;
      config?: {
        Entrypoint?: string[];
        Cmd?: string[];
        WorkingDir?: string;
        User?: string;
        Labels?: Record<string, string>;
        ExposedPorts?: Record<string, unknown>;
      };
    } | null;
    image = {
      reference: imageReference(env.registryHost, orgSlug, repoName, tag ?? digest),
      digestReference: imageReference(env.registryHost, orgSlug, repoName, digest),
      digest,
      mediaType: m.mediaType,
      manifestSize: m.size,
      totalSize: layers.reduce((s, l) => s + l.size, 0) + (parsed.config?.size ?? 0),
      layerCount: layers.length,
      isIndex: Array.isArray(parsed.manifests),
      layers,
      platform: cfg?.os ? { os: cfg.os, architecture: cfg.architecture, variant: cfg.variant } : null,
      config: cfg?.config
        ? {
            entrypoint: cfg.config.Entrypoint,
            cmd: cfg.config.Cmd,
            workingDir: cfg.config.WorkingDir,
            user: cfg.config.User,
            labels: cfg.config.Labels,
            exposedPorts: cfg.config.ExposedPorts ? Object.keys(cfg.config.ExposedPorts) : undefined,
          }
        : null,
      url: `${repoUrl}/tags/${encodeURIComponent(tag ?? digest)}`,
    };
  }

  return {
    repositoryId: repo.id,
    payload: {
      ...envelope(event, null),
      event,
      repository: {
        id: repo.id,
        name: repo.name,
        path,
        organization: { slug: org.slug, name: org.name },
        visibility: repo.visibility,
        url: repoUrl,
      },
      tag,
      image,
      actor: await resolveActor(actor),
    },
  };
}

export type Hook = typeof repositoryWebhooks.$inferSelect;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deliver one payload to one hook with retries; records the delivery. */
export async function deliverWebhook(hook: Hook, payload: WebhookEnvelope): Promise<void> {
  // Chat formats render the event as a message; the JSON format sends the
  // payload itself. Signing and authentication apply to whatever is sent.
  // GET carries no body: the receiver acts on the request itself (a deploy
  // hook, for instance); the event still travels in the headers.
  const sendsBody = hook.method !== "GET";
  const body = !sendsBody ? "" : hook.format && hook.format !== "json" ? JSON.stringify(encodeChatMessage(hook.format, chatMessage(payload))) : JSON.stringify(payload);
  const headers: Record<string, string> = {
    ...(sendsBody ? { "Content-Type": "application/json" } : {}),
    "User-Agent": "Chicoree-Webhooks/1.0",
    "X-Chicoree-Event": payload.event,
    "X-Chicoree-Delivery": payload.deliveryId,
    ...hook.headers,
  };
  const signingKey = decryptSecret(hook.signingSecret);
  if (signingKey) {
    headers["X-Chicoree-Signature"] = "sha256=" + createHmac("sha256", signingKey).update(body).digest("hex");
  }
  const secret = decryptSecret(hook.authSecret);
  if (secret) {
    if (hook.authType === "bearer") headers.Authorization = `Bearer ${secret}`;
    else if (hook.authType === "basic") headers.Authorization = `Basic ${Buffer.from(secret).toString("base64")}`;
    else if (hook.authType === "header" && hook.authHeaderName) headers[hook.authHeaderName] = secret;
  }

  const started = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;
  let snippet: string | null = null;
  let attempts = 0;
  for (const delay of [0, 2000, 6000]) {
    if (delay) await sleep(delay);
    attempts++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(hook.url, { method: hook.method, headers, body: sendsBody ? body : undefined, signal: controller.signal, redirect: "manual" });
      statusCode = res.status;
      snippet = (await res.text()).slice(0, 500);
      error = null;
      if (res.status < 500) break; // 2xx done; 4xx is the receiver's answer, don't retry
      error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      statusCode = null;
    } finally {
      clearTimeout(timer);
    }
  }
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300;
  const failure = ok ? null : (error ?? `HTTP ${statusCode}`);
  const [delivery] = await db
    .insert(webhookDeliveries)
    .values({
      webhookId: hook.id,
      event: payload.event,
      payload,
      statusCode,
      ok,
      attempts,
      durationMs: Date.now() - started,
      error: failure,
      responseSnippet: snippet,
    })
    .returning({ id: webhookDeliveries.id });
  await db
    .update(repositoryWebhooks)
    .set({ lastStatus: statusCode, lastDeliveredAt: new Date(), lastError: failure })
    .where(eq(repositoryWebhooks.id, hook.id));
  // Keep the delivery log bounded per hook (WEBHOOK_LOG_MAX rows).
  await db.execute(sql`
    DELETE FROM webhook_deliveries WHERE webhook_id = ${hook.id} AND id NOT IN (
      SELECT id FROM webhook_deliveries WHERE webhook_id = ${hook.id} ORDER BY created_at DESC LIMIT ${WEBHOOK_LOG_MAX})`);

  // Retries exhausted or a hard refusal: tell the organization (email only —
  // this never fans out to webhooks, so a broken receiver cannot loop).
  if (!ok && payload.event !== "test") {
    const { notify } = await import("./notify");
    await notify({
      event: "webhook.failed",
      hookId: hook.id,
      deliveryId: delivery.id,
      eventName: payload.event,
      statusCode,
      error: failure ?? "delivery failed",
      attempts,
    }).catch((err) => console.error("webhook.failed notification failed:", err));
  }
}

/** Enabled hooks that apply to a repository: its own plus its organization's. */
export async function hooksForRepository(repositoryId: string, organizationId: string): Promise<Hook[]> {
  const [own, orgWide] = await Promise.all([
    db.query.repositoryWebhooks.findMany({
      where: and(eq(repositoryWebhooks.repositoryId, repositoryId), eq(repositoryWebhooks.enabled, true)),
    }),
    db.query.repositoryWebhooks.findMany({
      where: and(
        eq(repositoryWebhooks.organizationId, organizationId),
        isNull(repositoryWebhooks.repositoryId),
        eq(repositoryWebhooks.enabled, true),
      ),
    }),
  ]);
  return [...own, ...orgWide];
}

function subscribed(hook: Hook, event: string): boolean {
  return hook.events.includes(event === "test" ? "push" : event);
}

async function deliverAll(hooks: Hook[], payload: WebhookEnvelope): Promise<void> {
  await Promise.allSettled(
    hooks
      .filter((h) => subscribed(h, payload.event))
      .map((h) => deliverWebhook(h, payload).catch((err) => console.error("webhook delivery failed:", err))),
  );
}

/** Fan a repository event out to every enabled hook subscribed to it. */
export async function dispatchRepositoryWebhooks(repositoryId: string, payload: WebhookEnvelope): Promise<void> {
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return;
  await deliverAll(await hooksForRepository(repositoryId, repo.organizationId), payload);
}

/** Fan an organization-level event out to the organization's hooks only. */
export async function dispatchOrganizationWebhooks(organizationId: string, payload: WebhookEnvelope): Promise<void> {
  const hooks = await db.query.repositoryWebhooks.findMany({
    where: and(
      eq(repositoryWebhooks.organizationId, organizationId),
      isNull(repositoryWebhooks.repositoryId),
      eq(repositoryWebhooks.enabled, true),
    ),
  });
  await deliverAll(hooks, payload);
}

/**
 * Build the standard envelope for a repository event and deliver it. `data`
 * is merged next to the envelope fields — the documented shapes live in
 * docs/wip/automation.md. Other modules (scan, mirror, retention) call this.
 */
export async function emitRepositoryEvent(
  repositoryId: string,
  event: Exclude<WebhookEvent, "push" | "quota.warning" | "quota.exceeded" | "quota.pruned">,
  data: Record<string, unknown>,
): Promise<void> {
  const info = await repositoryInfo(repositoryId);
  if (!info) return;
  const payload: WebhookEnvelope = { ...data, ...envelope(event, info.repository) };
  await deliverAll(await hooksForRepository(repositoryId, info.organizationId), payload);
}

/** Organization-level event (no repository); reaches organization hooks only. */
export async function emitOrganizationEvent(
  organizationId: string,
  event: "quota.warning" | "quota.exceeded" | "quota.pruned",
  data: Record<string, unknown>,
): Promise<void> {
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (!org) return;
  const payload: WebhookEnvelope & { organization: { slug: string; name: string } } = {
    ...data,
    ...envelope(event, null),
    organization: { slug: org.slug, name: org.name },
  };
  await dispatchOrganizationWebhooks(organizationId, payload);
}

// --- Queries for the settings pages ------------------------------------------

function scopeWhere(scope: WebhookScope) {
  return scope.kind === "repository"
    ? eq(repositoryWebhooks.repositoryId, scope.repositoryId)
    : and(eq(repositoryWebhooks.organizationId, scope.organizationId), isNull(repositoryWebhooks.repositoryId));
}

/**
 * Send a test delivery to one hook: a push-shaped payload built from the
 * most recent tag of the repository (or of any repository in the
 * organization), or a stub when there is nothing to describe yet. Returns
 * what the hook recorded for the attempt.
 */
export async function sendTestDelivery(
  org: { id: string; slug: string; name: string },
  repoIn: { id: string; name: string } | null,
  hook: Hook,
  actor: string,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  let repo: { id: string; name: string } | null = repoIn;
  let latest: { name: string; manifestDigest: string } | null = null;
  if (repo) {
    latest = (await db.query.tags.findFirst({ where: eq(tagsTable.repositoryId, repo.id), orderBy: (t, { desc }) => [desc(t.updatedAt)] })) ?? null;
  } else {
    const { rows } = await db.execute(sql`
      SELECT t.name, t.manifest_digest, t.repository_id FROM tags t
      JOIN repositories r ON r.id = t.repository_id
      WHERE r.organization_id = ${org.id} ORDER BY t.updated_at DESC LIMIT 1`);
    const row = rows[0];
    if (row) {
      latest = { name: String(row.name), manifestDigest: String(row.manifest_digest) };
      repo = (await db.query.repositories.findFirst({ where: eq(repositories.id, String(row.repository_id)) })) ?? null;
    } else {
      repo = (await db.query.repositories.findFirst({ where: eq(repositories.organizationId, org.id) })) ?? null;
    }
  }
  let payload: WebhookEnvelope | null = null;
  if (repo) {
    const built = await buildPushPayload(
      org.slug,
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
    organization: { slug: org.slug, name: org.name },
    tag: null,
    image: null,
    actor: await resolveActor(actor),
  } as WebhookEnvelope;
  await deliverWebhook(hook, payload);
  const refreshed = await db.query.repositoryWebhooks.findFirst({ where: eq(repositoryWebhooks.id, hook.id) });
  return {
    ok: !!refreshed?.lastStatus && refreshed.lastStatus >= 200 && refreshed.lastStatus < 300,
    status: refreshed?.lastStatus ?? null,
    error: refreshed?.lastError ?? null,
  };
}

export function maxWebhooks(scope: WebhookScope): number {
  return scope.kind === "repository" ? MAX_WEBHOOKS_PER_REPO : MAX_WEBHOOKS_PER_ORG;
}

export async function countWebhooks(scope: WebhookScope): Promise<number> {
  return db.$count(repositoryWebhooks, scopeWhere(scope));
}

/** One hook of the scope, or null (guards every mutation). */
export async function findScopedWebhook(scope: WebhookScope, id: string): Promise<Hook | null> {
  const row = await db.query.repositoryWebhooks.findFirst({ where: and(eq(repositoryWebhooks.id, id), scopeWhere(scope)) });
  return row ?? null;
}

/**
 * Hooks of a repository or organization with their delivery log, for the UI.
 *
 * The log is pruned to WEBHOOK_LOG_MAX rows per hook on every delivery, so
 * one window-function query reads the complete log of every hook of the
 * scope at once (no query per hook); the manager pages through it in the
 * browser, which is also where the log is opened and closed.
 */
export async function listWebhookRows(scope: WebhookScope): Promise<WebhookRow[]> {
  const hooks = await db.query.repositoryWebhooks.findMany({
    where: scopeWhere(scope),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  if (hooks.length === 0) return [];
  const ids = hooks.map((h) => h.id);
  const { rows: deliveryRows } = await db.execute(sql`
    SELECT id, webhook_id, event, ok, status_code, attempts, duration_ms, error, created_at
    FROM (
      SELECT d.*, row_number() OVER (PARTITION BY d.webhook_id ORDER BY d.created_at DESC, d.id DESC) AS rn
      FROM webhook_deliveries d
      WHERE d.webhook_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    ) x
    WHERE x.rn <= ${WEBHOOK_LOG_MAX}
    ORDER BY x.webhook_id, x.rn`);
  const byHook = new Map<string, WebhookRow["deliveries"]>();
  for (const d of deliveryRows) {
    const list = byHook.get(String(d.webhook_id)) ?? [];
    list.push({
      id: String(d.id),
      event: String(d.event),
      ok: Boolean(d.ok),
      statusCode: d.status_code == null ? null : Number(d.status_code),
      attempts: Number(d.attempts ?? 0),
      durationMs: d.duration_ms == null ? null : Number(d.duration_ms),
      error: (d.error as string | null) ?? null,
      createdAt: new Date(d.created_at as string).toISOString(),
    });
    byHook.set(String(d.webhook_id), list);
  }
  return Promise.all(
    hooks.map(async (h) => {
      const deliveries = byHook.get(h.id) ?? [];
      return {
        id: h.id,
        name: h.name,
        url: h.url,
        method: h.method,
        format: h.format,
        headers: h.headers,
        authType: h.authType,
        authHeaderName: h.authHeaderName,
        hasAuthSecret: !!h.authSecret,
        hasSigningSecret: !!h.signingSecret,
        events: h.events,
        enabled: h.enabled,
        lastStatus: h.lastStatus,
        lastDeliveredAt: h.lastDeliveredAt?.toISOString() ?? null,
        lastError: h.lastError,
        deliveries,
      };
    }),
  );
}
