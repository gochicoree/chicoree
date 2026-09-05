// Access-token lifecycle rules shared by the creation forms (client) and the
// server actions / token endpoint: expiry presets under the instance policy,
// expiry state for lists, and the organization / repository restriction check.
// Pure: no database, no Node-only imports.
import { relativeTime } from "./format";

export interface TokenExpiryPolicy {
  /** 0 = unlimited. */
  maxTokenLifetimeDays: number;
  requireTokenExpiry: boolean;
}

export const EXPIRY_PRESET_DAYS = [7, 30, 90, 365] as const;

export const NEVER = "never";
export const CUSTOM = "custom";

const DAY_MS = 24 * 3600 * 1000;

function presetLabel(days: number): string {
  if (days === 365) return "1 year";
  return `${days} days`;
}

/**
 * Options for the "Expires" select: every preset the policy allows, a custom
 * date, and "Never" unless expiry is required.
 */
export function expiryOptions(policy: TokenExpiryPolicy): { value: string; label: string; description?: string }[] {
  const cap = policy.maxTokenLifetimeDays > 0 ? policy.maxTokenLifetimeDays : Infinity;
  const options: { value: string; label: string; description?: string }[] = EXPIRY_PRESET_DAYS.filter((d) => d <= cap).map(
    (d) => ({ value: String(d), label: presetLabel(d) }),
  );
  if (Number.isFinite(cap) && !EXPIRY_PRESET_DAYS.includes(cap as (typeof EXPIRY_PRESET_DAYS)[number])) {
    options.push({ value: String(cap), label: presetLabel(cap), description: "Instance maximum" });
  }
  options.push({ value: CUSTOM, label: "Custom date" });
  if (!policy.requireTokenExpiry) options.push({ value: NEVER, label: "Never" });
  return options;
}

/** Default choice for the select: 90 days when allowed, else the longest permitted preset. */
export function defaultExpiryChoice(policy: TokenExpiryPolicy): string {
  const options = expiryOptions(policy).filter((o) => o.value !== CUSTOM && o.value !== NEVER);
  const ninety = options.find((o) => o.value === "90");
  if (ninety) return ninety.value;
  return options.length ? options[options.length - 1].value : CUSTOM;
}

/** One-line explanation of the policy for the form, or "" when nothing applies. */
export function describeExpiryPolicy(policy: TokenExpiryPolicy): string {
  const parts: string[] = [];
  if (policy.maxTokenLifetimeDays > 0) parts.push(`at most ${policy.maxTokenLifetimeDays} days`);
  if (policy.requireTokenExpiry) parts.push("an expiry date is required");
  if (parts.length === 0) return "";
  const s = parts.join(" and ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

export type ExpiryResolution = { expiresAt: Date | null } | { error: string };

/**
 * Turn a form choice into an expiry date under the policy. `choice` is a
 * number of days, "custom" (with `customDate` as YYYY-MM-DD or ISO), "never"
 * or "" (treated as never). Enforced server-side; the UI only hides options.
 */
export function resolveExpiry(
  choice: string,
  customDate: string,
  policy: TokenExpiryPolicy,
  now: Date = new Date(),
): ExpiryResolution {
  const cap = policy.maxTokenLifetimeDays > 0 ? policy.maxTokenLifetimeDays : Infinity;
  const c = choice.trim().toLowerCase();
  if (c === "" || c === NEVER) {
    if (policy.requireTokenExpiry) return { error: "Tokens on this instance must have an expiry date." };
    return { expiresAt: null };
  }
  let expiresAt: Date;
  if (c === CUSTOM) {
    const raw = customDate.trim();
    if (!raw) return { error: "Pick an expiry date." };
    // A bare date means the end of that day (local time of the server is fine: the UI shows the same date).
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T23:59:59`) : new Date(raw);
    if (Number.isNaN(parsed.getTime())) return { error: "The expiry date is not valid." };
    expiresAt = parsed;
  } else {
    const days = Number(c);
    if (!Number.isInteger(days) || days <= 0) return { error: "The expiry is not valid." };
    expiresAt = new Date(now.getTime() + days * DAY_MS);
  }
  if (expiresAt.getTime() <= now.getTime()) return { error: "The expiry date must be in the future." };
  if (expiresAt.getTime() - now.getTime() > cap * DAY_MS + 60_000) {
    return { error: `Tokens on this instance may live at most ${policy.maxTokenLifetimeDays} days.` };
  }
  return { expiresAt };
}

export type ExpiryState =
  | { state: "never" }
  | { state: "expired"; daysAgo: number }
  | { state: "expiring"; daysLeft: number }
  | { state: "active"; daysLeft: number };

/** Lifecycle state of an expiry date; "expiring" within `warnDays` (7). */
export function expiryState(expiresAt: Date | string | null | undefined, now: Date = new Date(), warnDays = 7): ExpiryState {
  if (!expiresAt) return { state: "never" };
  const at = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  const diff = at.getTime() - now.getTime();
  if (diff <= 0) return { state: "expired", daysAgo: Math.floor(-diff / DAY_MS) };
  const daysLeft = Math.ceil(diff / DAY_MS);
  if (daysLeft <= warnDays) return { state: "expiring", daysLeft };
  return { state: "active", daysLeft };
}

/** "expires in 3 days" / "expired 2 days ago" / "never expires". */
export function describeExpiry(expiresAt: Date | string | null | undefined, now: Date = new Date()): string {
  const s = expiryState(expiresAt, now);
  switch (s.state) {
    case "never":
      return "never expires";
    case "expired":
      return s.daysAgo === 0 ? "expired today" : `expired ${s.daysAgo} day${s.daysAgo === 1 ? "" : "s"} ago`;
    default:
      return s.daysLeft === 1 ? "expires in 1 day" : `expires in ${s.daysLeft} days`;
  }
}

export function isExpired(expiresAt: Date | null | undefined, now: Date = new Date()): boolean {
  return !!expiresAt && expiresAt.getTime() <= now.getTime();
}

// --- Restrictions ------------------------------------------------------------------

export interface TokenRestriction {
  /** The only organization the token reaches. */
  organizationId: string;
  /** Within it, the only repositories (null = every repository of the organization). */
  repositoryIds: string[] | null;
}

/**
 * Whether a restricted token may touch <organization, repository>. A token
 * limited to specific repositories only reaches repositories that already
 * exist and are listed (no auto-create on push). Unrestricted tokens
 * (restriction null) always pass.
 */
export function restrictionAllows(
  restriction: TokenRestriction | null | undefined,
  target: { organizationId: string; repositoryId: string | null },
): boolean {
  if (!restriction) return true;
  if (restriction.organizationId !== target.organizationId) return false;
  if (restriction.repositoryIds === null) return true;
  if (!target.repositoryId) return false;
  return restriction.repositoryIds.includes(target.repositoryId);
}

/** Normalise a restriction coming from the database or a form: no org → unrestricted. */
export function normalizeRestriction(organizationId: string | null | undefined, repositoryIds: string[] | null | undefined): TokenRestriction | null {
  if (!organizationId) return null;
  const ids = Array.isArray(repositoryIds) ? repositoryIds.filter((id) => typeof id === "string" && id) : null;
  return { organizationId, repositoryIds: ids && ids.length > 0 ? [...new Set(ids)] : null };
}

/** "acme · 2 repositories" / "acme" / "any organization". */
export function describeRestriction(orgName: string | null, repoNames: string[] | null): string {
  if (!orgName) return "any organization";
  if (!repoNames || repoNames.length === 0) return orgName;
  if (repoNames.length <= 3) return `${orgName} · ${repoNames.join(", ")}`;
  return `${orgName} · ${repoNames.length} repositories`;
}

/** "last used 3 minutes ago from 10.0.0.7" / "never used" — for token and service-account lists. */
export function lastUsedText(lastUsedAt: string | Date | null, lastUsedIp: string | null): string {
  if (!lastUsedAt) return "never used";
  return `last used ${relativeTime(lastUsedAt)}${lastUsedIp ? ` from ${lastUsedIp}` : ""}`;
}
