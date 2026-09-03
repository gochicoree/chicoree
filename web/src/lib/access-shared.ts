// Sign-up controls: pure types and checks shared by the server (better-auth
// hooks, actions) and the sign-up / sign-in / invitation screens.

export type SignUpMode = "open" | "invite" | "closed";
export type OrgCreationPolicy = "everyone" | "admins";

export interface AccessSettings {
  /** open: anyone; invite: only through an organization invitation; closed: no new accounts. */
  signUpMode: SignUpMode;
  /** Email domains allowed to register (lowercase, no @); empty = any. */
  allowedEmailDomains: string[];
  allowOrganizationCreation: OrgCreationPolicy;
}

/** Header the sign-up form sends so an invitee is matched to their invitation. */
export const INVITATION_HEADER = "x-chicoree-invitation";

export const DEFAULT_ACCESS: AccessSettings = {
  signUpMode: "open",
  allowedEmailDomains: [],
  allowOrganizationCreation: "everyone",
};

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
