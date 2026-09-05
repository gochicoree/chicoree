// Sign-up controls: pure types and checks shared by the server (better-auth
// hooks, actions) and the sign-up / sign-in / invitation screens.

export type SignUpMode = "open" | "invite" | "closed";
export type OrgCreationPolicy = "everyone" | "admins";
/**
 * Local sign-in = password, magic link and email code (passkeys and LDAP
 * are unaffected). "hidden" keeps it working only on /sign-in/<path>, for a
 * break-glass administrator account when everyone else uses SSO.
 */
export type LocalSignInMode = "everyone" | "hidden" | "off";

export interface AccessSettings {
  /** open: anyone; invite: only through an organization invitation; closed: no new accounts. */
  signUpMode: SignUpMode;
  /** Email domains allowed to register (lowercase, no @); empty = any. */
  allowedEmailDomains: string[];
  allowOrganizationCreation: OrgCreationPolicy;
  /** Longest lifetime of an access token / service account credential in days; 0 = unlimited. */
  maxTokenLifetimeDays: number;
  /** Refuse to create tokens that never expire. */
  requireTokenExpiry: boolean;
  localSignIn: LocalSignInMode;
  /** Last path segment of the hidden sign-in page: /sign-in/<localSignInPath>. */
  localSignInPath: string;
  /** The REST API under /api/v1; off = every endpoint answers 403 api_disabled (docker login and the jobs API are unaffected). */
  apiEnabled: boolean;
}

/** Header the sign-up form sends so an invitee is matched to their invitation. */
export const INVITATION_HEADER = "x-chicoree-invitation";

export const DEFAULT_ACCESS: AccessSettings = {
  signUpMode: "open",
  allowedEmailDomains: [],
  allowOrganizationCreation: "everyone",
  maxTokenLifetimeDays: 0,
  requireTokenExpiry: false,
  localSignIn: "everyone",
  localSignInPath: "local",
  apiEnabled: true,
};

export const LOCAL_SIGNIN_MODES: { value: LocalSignInMode; label: string; description: string }[] = [
  { value: "everyone", label: "Everyone", description: "Password, magic link and email code are offered on the sign-in page." },
  { value: "hidden", label: "Hidden URL only", description: "The sign-in page shows only SSO, LDAP and passkeys; local methods work on the hidden page below." },
  { value: "off", label: "Off", description: "Local methods are refused everywhere, including docker login with a password." },
];

/** Cookie that proves the browser opened the hidden page; its value is an HMAC of AUTH_SECRET. */
export const LOCAL_SIGNIN_COOKIE = "chicoree-local-signin";
export const LOCAL_SIGNIN_DISABLED = "Password sign-in is disabled on this registry; use your identity provider, a passkey, or an access token.";

/** The hidden page's path segment: lowercase letters, digits and dashes, 1–64 characters. */
export function normalizeLocalSignInPath(raw: string): string {
  const v = raw.trim().toLowerCase().replace(/^\/+|\/+$/g, "");
  return /^[a-z0-9-]{1,64}$/.test(v) && v !== "local-signin" ? v : "local";
}

/** Whether a better-auth request is a local (password / magic link / email code) sign-in attempt. */
export function isLocalSignInRequest(path: string, body: unknown): boolean {
  if (path === "/sign-in/email" || path === "/sign-in/magic-link" || path === "/sign-in/email-otp") return true;
  if (path === "/email-otp/send-verification-otp") {
    const type = body && typeof body === "object" ? (body as { type?: string }).type : undefined;
    return !type || type === "sign-in";
  }
  return false;
}


export const SIGN_UP_MODES: { value: SignUpMode; label: string; description: string }[] = [
  { value: "open", label: "Open", description: "Anyone can create an account." },
  { value: "invite", label: "Invitation only", description: "Only people invited to an organization can create an account." },
  { value: "closed", label: "Closed", description: "No new accounts at all; existing accounts keep working." },
];

/** Parse a textarea / env list of domains: one per line or separated by commas, spaces, semicolons. */
export function parseDomainList(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const d = part.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
    if (d && /^[a-z0-9.-]+$/.test(d)) seen.add(d);
  }
  return [...seen];
}

/** Whether an email address is allowed by the domain list (empty list = any domain). */
export function emailDomainAllowed(email: string, domains: string[]): boolean {
  if (domains.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Human list for hints: "example.com or corp.example.com". */
export function describeDomains(domains: string[]): string {
  if (domains.length === 0) return "";
  if (domains.length === 1) return domains[0];
  return `${domains.slice(0, -1).join(", ")} or ${domains[domains.length - 1]}`;
}
