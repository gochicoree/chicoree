// Instance settings: what the admin panel stores in the database, merged with
// the environment as defaults. Everything that used to be env-only (SMTP,
// GitHub/Google/OIDC, LDAP, group bindings) resolves through here.
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { instanceSettings } from "@/db/schema";
import { decryptSecret, encryptSecret } from "./crypto";
import { env } from "./env";

export type SettingsSection = "smtp" | "github" | "google" | "oidc" | "ldap" | "bindings" | "metrics" | "access" | "branding" | "ratelimit" | "scanner";
export type SettingsSource = "database" | "environment" | "none";

// Sign-up controls and branding: shapes live in the *-shared modules so client
// components can import them without touching the database.
import { DEFAULT_ACCESS, normalizeLocalSignInPath, type AccessSettings } from "./access-shared";
import { DEFAULT_BRANDING, type BrandingSettings } from "./branding-shared";
import type { ScannerSettings } from "./scanner-shared";
export type { AccessSettings } from "./access-shared";
export type { BrandingSettings } from "./branding-shared";
export type { ScannerSettings } from "./scanner-shared";

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}
export interface OAuthSettings {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
}
export interface OidcSettings extends OAuthSettings {
  issuer: string;
  name: string;
  scopes: string;
  groupsClaim: string;
}
export interface LdapSettings {
  enabled: boolean;
  url: string;
  name: string;
  bindDn: string;
  bindPassword: string;
  userBase: string;
  userFilter: string;
  attrEmail: string;
  attrName: string;
  attrGroups: string;
  groupBase: string;
  groupFilter: string;
  emailDomain: string;
  startTls: boolean;
  tlsInsecure: boolean;
  tlsCaFile: string;
  timeoutMs: number;
}

export interface MetricsSettings {
  enabled: boolean;
  /** Bearer token Prometheus presents; empty means the endpoint refuses every scrape. */
  token: string;
  /**
   * sha256 hex of the token, stored in the clear so registryd can gate its
   * own /metrics on the same credential (it cannot decrypt `token`).
   */
  tokenHash?: string;
}

/**
 * Pull rate limits enforced by registryd (it reads this section straight
 * from instance_settings every 30s). Limits are "<count>/<window>" strings,
 * see lib/rate-limit-shared.ts; empty means unlimited.
 */
export interface RateLimitSettings {
  /** Per client IP address. */
  anonymous: string;
  /** Per user or service account. */
  authenticated: string;
  /** CIDRs / addresses whose X-Forwarded-For header is trusted. */
  trustedProxies: string;
}

export interface EffectiveSettings {
  smtp: SmtpSettings;
  github: OAuthSettings;
  google: OAuthSettings;
  oidc: OidcSettings;
  ldap: LdapSettings;
  /** AUTH_GROUP_BINDINGS syntax, see lib/group-bindings.ts. */
  bindings: string;
  metrics: MetricsSettings;
  access: AccessSettings;
  branding: BrandingSettings;
  ratelimit: RateLimitSettings;
  /** Vulnerability scanner backend (Administration → Scanning). */
  scanner: ScannerSettings;
  sources: Record<SettingsSection, SettingsSource>;
  /** Changes whenever a section is saved; consumers cache on it. */
  version: number;
}

/** Fields whose stored value is encrypted. */
const SECRET_FIELDS: Record<SettingsSection, string[]> = {
  smtp: ["pass"],
  github: ["clientSecret"],
  google: ["clientSecret"],
  oidc: ["clientSecret"],
  ldap: ["bindPassword"],
  bindings: [],
  metrics: ["token"],
  access: [],
  branding: [],
  ratelimit: [],
  scanner: [],
};

function envDefaults(): Omit<EffectiveSettings, "sources" | "version"> {
  return {
    smtp: {
      host: env.smtpHost,
      port: env.smtpPort,
      secure: env.smtpSecure,
      user: env.smtpUser,
      pass: env.smtpPass,
      from: env.smtpFrom,
    },
    github: { enabled: !!env.githubClientId, clientId: env.githubClientId, clientSecret: env.githubClientSecret },
    google: { enabled: !!env.googleClientId, clientId: env.googleClientId, clientSecret: env.googleClientSecret },
    oidc: {
      enabled: !!env.oidcIssuer,
      issuer: env.oidcIssuer,
      clientId: env.oidcClientId,
      clientSecret: env.oidcClientSecret,
      name: env.oidcName,
      scopes: env.oidcScopes.join(" "),
      groupsClaim: env.oidcGroupsClaim,
    },
    ldap: {
      enabled: env.ldapEnabled,
      url: env.ldapUrl,
      name: env.ldapName,
      bindDn: env.ldapBindDn,
      bindPassword: env.ldapBindPassword,
      userBase: env.ldapUserBase,
      userFilter: env.ldapUserFilter,
      attrEmail: env.ldapAttrEmail,
      attrName: env.ldapAttrName,
      attrGroups: env.ldapAttrGroups,
      groupBase: env.ldapGroupBase,
      groupFilter: env.ldapGroupFilter,
      emailDomain: env.ldapEmailDomain,
      startTls: env.ldapStartTls,
      tlsInsecure: env.ldapTlsInsecure,
      tlsCaFile: env.ldapTlsCaFile,
      timeoutMs: env.ldapTimeoutMs,
    },
    bindings: env.authGroupBindings,
    metrics: { enabled: env.metricsEnabled, token: env.metricsToken },
    access: {
      ...DEFAULT_ACCESS,
      signUpMode: env.signUpMode,
      allowedEmailDomains: env.signUpAllowedDomains,
      allowOrganizationCreation: env.orgCreation,
      maxTokenLifetimeDays: env.tokenMaxLifetimeDays,
      requireTokenExpiry: env.tokenRequireExpiry,
      localSignIn: env.localSignIn,
      localSignInPath: normalizeLocalSignInPath(env.localSignInPath),
      apiEnabled: env.apiEnabled,
    },
    branding: {
      ...DEFAULT_BRANDING,
      instanceName: env.instanceName || DEFAULT_BRANDING.instanceName,
      tagline: env.instanceTagline || DEFAULT_BRANDING.tagline,
      gravatar: env.gravatarEnabled,
      showArtifacts: env.showArtifacts,
    },
    ratelimit: {
      anonymous: env.rateLimitAnonymous,
      authenticated: env.rateLimitAuthenticated,
      trustedProxies: env.rateLimitTrustedProxies,
    },
    scanner: {
      backend: env.scanner,
      clairUrl: env.clairUrl,
      trivyServerUrl: env.trivyServerUrl,
      trivyTimeoutSeconds: env.trivyTimeoutSeconds,
    },
  };
}

function envConfigured(section: SettingsSection, d: ReturnType<typeof envDefaults>): boolean {
  switch (section) {
    case "smtp":
      return !!d.smtp.host;
    case "github":
      return !!d.github.clientId;
    case "google":
      return !!d.google.clientId;
    case "oidc":
      return !!d.oidc.issuer;
    case "ldap":
      return !!d.ldap.url;
    case "bindings":
      return !!d.bindings;
    case "metrics":
      return d.metrics.enabled;
    case "access":
      return (
        !!process.env.LOCAL_SIGNIN ||
        !!process.env.SIGNUP_MODE ||
        !!process.env.SIGNUP_ALLOWED_DOMAINS ||
        !!process.env.ORG_CREATION ||
        !!process.env.TOKEN_MAX_LIFETIME_DAYS ||
        !!process.env.TOKEN_REQUIRE_EXPIRY ||
        !!process.env.API_ENABLED
      );
    case "branding":
      return !!process.env.INSTANCE_NAME || !!process.env.INSTANCE_TAGLINE || !!process.env.GRAVATAR || !!process.env.SHOW_ARTIFACTS;
    case "ratelimit":
      return !!d.ratelimit.anonymous || !!d.ratelimit.authenticated;
    case "scanner":
      return !!process.env.SCANNER || !!d.scanner.clairUrl;
  }
}

function decryptSection(section: SettingsSection, value: Record<string, unknown>): Record<string, unknown> {
  const out = { ...value };
  for (const f of SECRET_FIELDS[section]) {
    if (typeof out[f] === "string" && out[f]) out[f] = decryptSecret(out[f] as string) ?? "";
  }
  return out;
}

/** Newest updated_at across sections, as a number (0 when nothing is stored). */
export async function settingsVersion(): Promise<number> {
  const { rows } = await db.execute(sql`select coalesce(max(updated_at), 'epoch'::timestamptz) as v from instance_settings`);
  const v = rows[0]?.v;
  return v ? new Date(v as string).getTime() : 0;
}

async function loadSettings(): Promise<EffectiveSettings> {
  const defaults = envDefaults();
  const rows = await db.select().from(instanceSettings);
  const stored = new Map(rows.map((r) => [r.key as SettingsSection, r]));
  const sources = {} as Record<SettingsSection, SettingsSource>;
  const merged: Record<string, unknown> = {};
  let version = 0;
  for (const section of ["smtp", "github", "google", "oidc", "ldap", "bindings", "metrics", "access", "branding", "ratelimit", "scanner"] as SettingsSection[]) {
    const row = stored.get(section);
    if (row) {
      version = Math.max(version, row.updatedAt.getTime());
      const value = decryptSection(section, row.value);
      merged[section] = section === "bindings" ? String(value.text ?? "") : { ...defaults[section], ...value };
      sources[section] = "database";
    } else {
      merged[section] = defaults[section];
      sources[section] = envConfigured(section, defaults) ? "environment" : "none";
    }
  }
  return { ...(merged as Omit<EffectiveSettings, "sources" | "version">), sources, version };
}

/** Effective settings; memoised per request inside React, plain call elsewhere. */
export const getInstanceSettings = cache(loadSettings);

/**
 * Store one section. Secret fields left empty keep the stored value; a
 * single "-" clears them. Returns the stored (encrypted) row value.
 */
export async function saveSettingsSection(section: SettingsSection, value: Record<string, unknown>): Promise<void> {
  const existing = await db.query.instanceSettings.findFirst({ where: (t, { eq }) => eq(t.key, section) });
  const fromEnv = envDefaults()[section] as Record<string, unknown> | string;
  const next: Record<string, unknown> = { ...value };
  for (const f of SECRET_FIELDS[section]) {
    const v = next[f];
    if (typeof v !== "string" || v === "") {
      if (existing && typeof existing.value[f] === "string") {
        // keep what is stored (still encrypted)
        next[f] = existing.value[f];
      } else if (typeof fromEnv === "object" && typeof fromEnv[f] === "string" && fromEnv[f]) {
        // First save of a section the environment configured: snapshot the
        // secret so the stored section stands on its own.
        next[f] = encryptSecret(fromEnv[f] as string);
      } else {
        delete next[f];
      }
    } else if (v === "-") {
      next[f] = "";
    } else {
      next[f] = encryptSecret(v);
    }
  }
  await db
    .insert(instanceSettings)
    .values({ key: section, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value: next, updatedAt: new Date() } });
}

/** Forget a stored section so the environment defaults apply again. */
export async function resetSettingsSection(section: SettingsSection): Promise<void> {
  await db.delete(instanceSettings).where(sql`key = ${section}`);
}
