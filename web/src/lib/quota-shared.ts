// Default limits for new accounts / organizations and the account portal
// link: pure types and checks shared by the admin forms (client) and the
// server. No database, no Node APIs.

/**
 * Limits given to every new account and every new organization
 * (Administration → Limits). null = unlimited. A limits row is created at
 * sign-up / creation only when at least one value is set, so an unsaved
 * section changes nothing.
 */
export interface QuotaDefaults {
  user: {
    maxOrganizations: number | null;
    maxPublicRepos: number | null;
    maxPrivateRepos: number | null;
    maxStorageBytes: number | null;
  };
  organization: {
    maxPublicRepos: number | null;
    maxPrivateRepos: number | null;
    maxStorageBytes: number | null;
    maxMembers: number | null;
  };
}

export const DEFAULT_QUOTAS: QuotaDefaults = {
  user: { maxOrganizations: null, maxPublicRepos: null, maxPrivateRepos: null, maxStorageBytes: null },
  organization: { maxPublicRepos: null, maxPrivateRepos: null, maxStorageBytes: null, maxMembers: null },
};

/** Whether any default is set at all (otherwise nothing is written at sign-up / creation). */
export function userDefaultsConfigured(q: QuotaDefaults): boolean {
  return Object.values(q.user).some((v) => v !== null);
}
export function organizationDefaultsConfigured(q: QuotaDefaults): boolean {
  return Object.values(q.organization).some((v) => v !== null);
}

/**
 * Where users manage their account with an external service (a billing
 * portal, a company directory). When `url` is set, the account and
 * organization settings show a "Manage" button that hands the user over
 * with a one-time token (see README "Account portal").
 */
export interface PortalSettings {
  url: string;
  /** Button label; empty = "Manage". */
  label: string;
}

export const DEFAULT_PORTAL: PortalSettings = { url: "", label: "" };

/** An absolute http(s) URL without credentials, at most 500 characters; empty clears the link. */
export function normalizePortalUrl(raw: string): { url: string; error?: undefined } | { url?: undefined; error: string } {
  const v = raw.trim();
  if (v === "") return { url: "" };
  if (v.length > 500) return { error: "The portal URL is longer than 500 characters." };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { error: "The portal URL must be absolute, like https://account.example.com/portal." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "The portal URL must use http or https." };
  if (u.username || u.password) return { error: "The portal URL must not contain credentials." };
  return { url: u.toString() };
}

/** The URL the Manage button opens: the portal with the one-time token (and organization) appended. */
export function portalHandoffUrl(base: string, token: string, organization?: string | null): string {
  const u = new URL(base);
  u.searchParams.set("token", token);
  if (organization) u.searchParams.set("organization", organization);
  return u.toString();
}
