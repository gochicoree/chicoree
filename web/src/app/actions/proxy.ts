"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, organizationProxies, organizationSettings } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { encryptSecret } from "@/lib/crypto";
import { getOrgProxy, reloadRegistryProxies, splitProxyAuth, testUpstream } from "@/lib/proxy";
import { PROXY_PRESETS, presetFor, type ProxyPreset } from "@/lib/proxy-shared";
import { PROXY_CACHES_OFF } from "@/lib/access-shared";
import { getInstanceSettings } from "@/lib/instance-settings";

async function proxyCachesOn(): Promise<boolean> {
  return (await getInstanceSettings()).access.proxyCaches;
}

export interface ProxyActionResult {
  error?: string;
  saved?: boolean;
  /** Result of "Test upstream". */
  test?: { ok: boolean; message: string };
}

function readPreset(v: FormDataEntryValue | null): ProxyPreset {
  const s = String(v ?? "");
  return PROXY_PRESETS.some((p) => p.value === s) ? (s as ProxyPreset) : "custom";
}

function readUrl(v: FormDataEntryValue | null): string | { error: string } {
  const url = String(v ?? "").trim().replace(/\/+$/, "");
  if (!url) return { error: "Enter the upstream registry URL." };
  if (!/^https?:\/\/[^\s/]+/.test(url)) return { error: "The upstream URL must look like https://registry.example.com." };
  try {
    new URL(url);
  } catch {
    return { error: "The upstream URL is not valid." };
  }
  return url;
}

function readTtl(v: FormDataEntryValue | null): number | { error: string } {
  const n = Number(String(v ?? "").trim() || "300");
  if (!Number.isInteger(n) || n < 0 || n > 30 * 86_400) return { error: "The tag TTL must be a number of seconds between 0 and 2592000 (30 days)." };
  return n;
}

async function managerContext(organizationId: string) {
  const session = await requireSession();
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can configure the proxy cache." } as const;
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (!org) return { error: "Organization not found." } as const;
  return { session, org } as const;
}

/** Create or update the organization's proxy configuration. */
export async function saveOrgProxy(_prev: ProxyActionResult | null, formData: FormData): Promise<ProxyActionResult> {
  if (!(await proxyCachesOn())) return { error: PROXY_CACHES_OFF };
  const organizationId = String(formData.get("organizationId") ?? "");
  const ctx = await managerContext(organizationId);
  if ("error" in ctx) return { error: ctx.error };

  const upstreamUrl = readUrl(formData.get("upstreamUrl"));
  if (typeof upstreamUrl !== "string") return upstreamUrl;
  const ttl = readTtl(formData.get("tagTtlSeconds"));
  if (typeof ttl !== "number") return ttl;
  const preset = readPreset(formData.get("preset"));
  const allowedPatterns = String(formData.get("allowedPatterns") ?? "").trim().split(/[\s,]+/).filter(Boolean).join(" ");
  const enabled = formData.get("enabled") !== "off";
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const clearAuth = formData.get("clearAuth") === "on";

  const existing = await getOrgProxy(organizationId);
  // Credentials are write-only: an empty password keeps what is stored.
  let auth: string | null = existing?.auth ?? null;
  if (clearAuth) auth = null;
  else if (password) auth = encryptSecret(username ? `${username}:${password}` : password);
  else if (username && existing?.auth) {
    const stored = splitProxyAuth(existing.auth);
    if (stored && stored.username !== username) auth = encryptSecret(`${username}:${stored.password}`);
  }

  const values = {
    upstreamUrl,
    preset: preset === "custom" ? presetFor(upstreamUrl) : preset,
    auth,
    allowedPatterns,
    tagTtlSeconds: ttl,
    enabled,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(organizationProxies).set(values).where(eq(organizationProxies.organizationId, organizationId));
  } else {
    await db.insert(organizationProxies).values({ organizationId, createdBy: ctx.session.user.id, ...values });
  }
  await reloadRegistryProxies();
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { saved: true };
}

/** Remove the proxy configuration; cached repositories stay as normal repositories. */
export async function removeOrgProxy(formData: FormData): Promise<ProxyActionResult> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const ctx = await managerContext(organizationId);
  if ("error" in ctx) return { error: ctx.error };
  await db.delete(organizationProxies).where(eq(organizationProxies.organizationId, organizationId));
  await reloadRegistryProxies();
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { saved: true };
}

/** Probe the upstream with the values in the form (stored credentials when the password is blank). */
export async function testOrgProxy(_prev: ProxyActionResult | null, formData: FormData): Promise<ProxyActionResult> {
  if (!(await proxyCachesOn())) return { error: PROXY_CACHES_OFF };
  const organizationId = String(formData.get("organizationId") ?? "");
  const ctx = await managerContext(organizationId);
  if ("error" in ctx) return { error: ctx.error };
  const upstreamUrl = readUrl(formData.get("upstreamUrl"));
  if (typeof upstreamUrl !== "string") return upstreamUrl;
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  let auth: { username: string; password: string } | null = null;
  if (password) auth = { username, password };
  else if (formData.get("clearAuth") !== "on") {
    const existing = await getOrgProxy(organizationId);
    const stored = splitProxyAuth(existing?.auth ?? null);
    if (stored) auth = { username: username || stored.username, password: stored.password };
  }
  const test = await testUpstream(upstreamUrl, auth);
  return { test, saved: false };
}

/**
 * Shortcut used right after creating an organization on /orgs/new: turn it
 * into a proxy of a preset upstream and make new repositories public so
 * anonymous pulls work like on the upstream.
 */
export async function enableProxyForNewOrg(formData: FormData): Promise<ProxyActionResult> {
  if (!(await proxyCachesOn())) return { error: PROXY_CACHES_OFF };
  const organizationId = String(formData.get("organizationId") ?? "");
  const ctx = await managerContext(organizationId);
  if ("error" in ctx) return { error: ctx.error };
  const preset = readPreset(formData.get("preset"));
  const presetDef = PROXY_PRESETS.find((p) => p.value === preset);
  const upstreamUrl = presetDef?.url || String(formData.get("upstreamUrl") ?? "").trim();
  if (!/^https?:\/\//.test(upstreamUrl)) return { error: "Pick a preset or enter the upstream URL." };
  await db
    .insert(organizationProxies)
    .values({ organizationId, upstreamUrl, preset, createdBy: ctx.session.user.id })
    .onConflictDoNothing();
  await db
    .insert(organizationSettings)
    .values({ organizationId, defaultVisibility: "public", updatedAt: new Date() })
    .onConflictDoUpdate({ target: organizationSettings.organizationId, set: { defaultVisibility: "public", updatedAt: new Date() } });
  await reloadRegistryProxies();
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { saved: true };
}
