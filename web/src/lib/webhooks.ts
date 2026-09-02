// Outbound repository webhooks: build a rich push payload and deliver it to
// every enabled hook on the repository, recording each attempt.
import { randomUUID, createHmac } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  manifests,
  organization,
  repositories,
  repositoryWebhooks,
  serviceAccounts,
  user as userTable,
  webhookDeliveries,
} from "@/db/schema";
import { decryptSecret } from "./crypto";
import { env } from "./env";
import { imagePath, imageReference } from "./library";

export const MAX_WEBHOOKS_PER_REPO = 5;

export interface WebhookPayload {
  event: "push" | "test";
  deliveryId: string;
  timestamp: string;
  registry: string;
  repository: {
    id: string;
    name: string;
    path: string;
    organization: { slug: string; name: string };
    visibility: string;
    url: string;
  };
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
  actor: { type: string; id: string | null; name: string | null } | null;
}

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
}

async function resolveActor(actor: string | undefined): Promise<WebhookPayload["actor"]> {
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
      event,
      deliveryId: randomUUID(),
      timestamp: new Date().toISOString(),
      registry: env.registryHost,
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

type Hook = typeof repositoryWebhooks.$inferSelect;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deliver one payload to one hook with retries; records the delivery. */
export async function deliverWebhook(hook: Hook, payload: WebhookPayload): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
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
      const res = await fetch(hook.url, { method: hook.method, headers, body, signal: controller.signal, redirect: "manual" });
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
  await db.insert(webhookDeliveries).values({
    webhookId: hook.id,
    event: payload.event,
    payload,
    statusCode,
    ok,
    attempts,
    durationMs: Date.now() - started,
    error: ok ? null : (error ?? `HTTP ${statusCode}`),
    responseSnippet: snippet,
  });
  await db
    .update(repositoryWebhooks)
    .set({ lastStatus: statusCode, lastDeliveredAt: new Date(), lastError: ok ? null : (error ?? `HTTP ${statusCode}`) })
    .where(eq(repositoryWebhooks.id, hook.id));
  // Keep the delivery log bounded per hook.
  await db.execute(sql`
    DELETE FROM webhook_deliveries WHERE webhook_id = ${hook.id} AND id NOT IN (
      SELECT id FROM webhook_deliveries WHERE webhook_id = ${hook.id} ORDER BY created_at DESC LIMIT 50)`);
}

/** Fan a push out to every enabled hook subscribed to the event. */
export async function dispatchRepositoryWebhooks(repositoryId: string, payload: WebhookPayload): Promise<void> {
  const hooks = await db.query.repositoryWebhooks.findMany({
    where: and(eq(repositoryWebhooks.repositoryId, repositoryId), eq(repositoryWebhooks.enabled, true)),
  });
  await Promise.allSettled(
    hooks
      .filter((h) => h.events.includes(payload.event === "test" ? "push" : payload.event))
      .map((h) => deliverWebhook(h, payload).catch((err) => console.error("webhook delivery failed:", err))),
  );
}
