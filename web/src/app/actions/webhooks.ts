"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, repositories, repositoryWebhooks } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { encryptSecret } from "@/lib/crypto";
import { buildPushPayload, deliverWebhook, MAX_WEBHOOKS_PER_REPO } from "@/lib/webhooks";

export interface WebhookResult {
  error?: string;
  saved?: boolean;
  tested?: { ok: boolean; status: number | null; error: string | null };
}

async function requireRepoManager(repositoryId: string) {
  await requireSession();
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." } as const;
  const role = await getOrgRole(repo.organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization admins can manage webhooks." } as const;
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  return { repo, org: org! } as const;
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
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const ctx = await requireRepoManager(repositoryId);
  if ("error" in ctx) return { error: ctx.error };

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const url = String(formData.get("url") ?? "").trim();
  const method = String(formData.get("method") ?? "POST");
  const authType = String(formData.get("authType") ?? "none");
  const authHeaderName = String(formData.get("authHeaderName") ?? "").trim();
  const authSecretRaw = String(formData.get("authSecret") ?? "");
  const signingSecretRaw = String(formData.get("signingSecret") ?? "");
  const events = formData.getAll("events").map(String).filter((e) => e === "push");

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

  const base = {
    name,
    url,
    method: method as "POST" | "PUT" | "PATCH",
    headers: parseHeaders(String(formData.get("headers") ?? "")),
    authType: authType as "none" | "bearer" | "basic" | "header",
    authHeaderName: authType === "header" ? authHeaderName : null,
    events: events.length ? events : ["push"],
  };

  if (id) {
    const existing = await db.query.repositoryWebhooks.findFirst({
      where: and(eq(repositoryWebhooks.id, id), eq(repositoryWebhooks.repositoryId, repositoryId)),
    });
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
    const count = await db.$count(repositoryWebhooks, eq(repositoryWebhooks.repositoryId, repositoryId));
    if (count >= MAX_WEBHOOKS_PER_REPO) return { error: `A repository can have at most ${MAX_WEBHOOKS_PER_REPO} webhooks.` };
    const session = await requireSession();
    await db.insert(repositoryWebhooks).values({
      repositoryId,
      ...base,
      authSecret: authType !== "none" && authSecretRaw ? encryptSecret(authSecretRaw) : null,
      signingSecret: signingSecretRaw ? encryptSecret(signingSecretRaw) : null,
      createdBy: session.user.id,
    });
  }
  revalidatePath(`/${ctx.org.slug}/${ctx.repo.name}/settings`);
  return { saved: true };
}

export async function deleteWebhook(formData: FormData): Promise<void> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const id = String(formData.get("id") ?? "");
  const ctx = await requireRepoManager(repositoryId);
  if ("error" in ctx) return;
  await db.delete(repositoryWebhooks).where(and(eq(repositoryWebhooks.id, id), eq(repositoryWebhooks.repositoryId, repositoryId)));
  revalidatePath(`/${ctx.org.slug}/${ctx.repo.name}/settings`);
}

export async function toggleWebhook(formData: FormData): Promise<void> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const id = String(formData.get("id") ?? "");
  const enabled = String(formData.get("enabled")) === "true";
  const ctx = await requireRepoManager(repositoryId);
  if ("error" in ctx) return;
  await db
    .update(repositoryWebhooks)
    .set({ enabled })
    .where(and(eq(repositoryWebhooks.id, id), eq(repositoryWebhooks.repositoryId, repositoryId)));
  revalidatePath(`/${ctx.org.slug}/${ctx.repo.name}/settings`);
}

/** Send a test delivery using the repository's most recent tag (or a stub). */
export async function testWebhook(_prev: WebhookResult | null, formData: FormData): Promise<WebhookResult> {
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const id = String(formData.get("id") ?? "");
  const ctx = await requireRepoManager(repositoryId);
  if ("error" in ctx) return { error: ctx.error };
  const hook = await db.query.repositoryWebhooks.findFirst({
    where: and(eq(repositoryWebhooks.id, id), eq(repositoryWebhooks.repositoryId, repositoryId)),
  });
  if (!hook) return { error: "Webhook not found." };

  const latest = await db.query.tags.findFirst({
    where: (t, { eq }) => eq(t.repositoryId, repositoryId),
    orderBy: (t, { desc }) => [desc(t.updatedAt)],
  });
  const session = await requireSession();
  const built = await buildPushPayload(
    ctx.org.slug,
    ctx.repo.name,
    latest?.manifestDigest ?? "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    latest?.name ?? "test",
    `user:${session.user.id}`,
    "test",
  );
  if (!built) return { error: "Could not build a payload." };
  await deliverWebhook(hook, built.payload);
  const refreshed = await db.query.repositoryWebhooks.findFirst({ where: eq(repositoryWebhooks.id, id) });
  revalidatePath(`/${ctx.org.slug}/${ctx.repo.name}/settings`);
  return {
    tested: {
      ok: !!refreshed?.lastStatus && refreshed.lastStatus >= 200 && refreshed.lastStatus < 300,
      status: refreshed?.lastStatus ?? null,
      error: refreshed?.lastError ?? null,
    },
  };
}
