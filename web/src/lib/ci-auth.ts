// Keyless CI authentication. A workflow presents the OIDC token its CI
// system issued (GitHub Actions, GitLab, any issuer an organization
// trusts); the token is verified against the issuer's published keys and
// matched against the trusted CI identities; a short-lived registry
// credential (chc_ci_…, an HMAC-signed JWT under a key derived from
// AUTH_SECRET) comes back. It works wherever a service account secret
// works — docker login and the REST API — with the identity's permission
// and repository list, and it needs no stored secret on either side.
import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { createRemoteJWKSet, decodeJwt, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { db } from "@/db";
import { ciIdentitiesTrusted, organization, repositories } from "@/db/schema";
import type { Caller } from "./access";
import { env } from "./env";
import { CI_PREFIX } from "./secrets";
import { subjectMatches } from "./signatures";

export type CiIdentityRow = typeof ciIdentitiesTrusted.$inferSelect;

export const CI_TOKEN_DEFAULT_TTL = 30 * 60;
export const CI_TOKEN_MAX_TTL = 60 * 60;
const CI_AUDIENCE = "chicoree-ci";

/** Well-known issuers offered in the form; any https issuer works. */
export const CI_ISSUERS: { value: string; label: string; subjectHint: string }[] = [
  { value: "https://token.actions.githubusercontent.com", label: "GitHub Actions", subjectHint: "repo:owner/repo:ref:refs/heads/main — or repo:owner/repo:* for any ref (GitHub's own form with ids, repo:owner@123/repo@456:…, matches too)" },
  { value: "https://gitlab.com", label: "GitLab.com", subjectHint: "project_path:group/project:ref_type:branch:ref:main" },
];

/** How a CI identity is named where an actor is shown: "GitHub Actions · release" (the issuer's label, then the identity's name). */
export function ciActorLabel(issuer: string, name: string): string {
  const known = CI_ISSUERS.find((i) => i.value === issuer.replace(/\/$/, ""));
  return `${known?.label ?? "CI"} · ${name}`;
}

function hmacKey(): Uint8Array {
  return createHash("sha256").update(`chicoree-ci-token:${env.authSecret}`).digest();
}

/** Audiences a CI token may be issued for: the app URL, its host, or the registry host. */
export function acceptedAudiences(): string[] {
  const app = env.appUrl.replace(/\/$/, "");
  const out = new Set<string>([app, `${app}/`, env.registryHost]);
  try {
    out.add(new URL(app).host);
  } catch {
    // APP_URL is not a URL; the registry host is still accepted
  }
  return [...out];
}

// --- Verifying the CI system's token -------------------------------------------

const jwksCache = new Map<string, { keys: ReturnType<typeof createRemoteJWKSet>; fetchedAt: number }>();

/** The issuer's JWKS through OpenID discovery, cached for an hour per issuer. */
async function issuerKeys(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const cached = jwksCache.get(issuer);
  if (cached && Date.now() - cached.fetchedAt < 3600_000) return cached.keys;
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`the issuer's discovery document answered HTTP ${res.status}`);
  const config = (await res.json()) as { jwks_uri?: string };
  if (!config.jwks_uri) throw new Error("the issuer's discovery document has no jwks_uri");
  const keys = createRemoteJWKSet(new URL(config.jwks_uri), { timeoutDuration: 10_000 });
  jwksCache.set(issuer, { keys, fetchedAt: Date.now() });
  return keys;
}

export interface VerifiedOidc {
  issuer: string;
  subject: string;
  claims: JWTPayload;
}

/**
 * Verify an OIDC token. Only issuers some organization trusts are ever
 * contacted (so nobody can point the registry at an arbitrary URL), the
 * signature must verify against the issuer's keys, and the audience must
 * name this registry.
 */
export async function verifyOidcToken(token: string): Promise<VerifiedOidc | { error: string }> {
  let iss: string | undefined;
  try {
    iss = decodeJwt(token).iss;
  } catch {
    return { error: "the token is not a JWT" };
  }
  if (!iss || !/^https?:\/\//.test(iss)) return { error: "the token has no issuer" };
  const trusted = await db.query.ciIdentitiesTrusted.findFirst({ where: eq(ciIdentitiesTrusted.issuer, iss), columns: { id: true } });
  if (!trusted) return { error: `no organization trusts the issuer ${iss}` };
  try {
    const { payload } = await jwtVerify(token, await issuerKeys(iss), { issuer: iss, audience: acceptedAudiences(), clockTolerance: 60 });
    if (!payload.sub) return { error: "the token has no subject" };
    return { issuer: iss, subject: payload.sub, claims: payload };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/audience/i.test(msg)) return { error: `the token's audience is not this registry; request it with audience ${env.appUrl}` };
    return { error: `the token did not verify: ${msg}` };
  }
}

/**
 * GitHub writes the owner's and the repository's numeric id into the subject
 * (`repo:acme@123/api@456:ref:refs/heads/main`); an identity written either
 * with or without the ids should match, so both spellings are tried.
 */
export function subjectSpellings(subject: string): string[] {
  const plain = subject.replace(/^repo:([^/:@]+)@\d+\/([^:@]+)@\d+:/, "repo:$1/$2:");
  return plain === subject ? [subject] : [subject, plain];
}

/** Trusted identities the verified token satisfies (issuer equal, subject pattern matched), oldest first. */
export async function matchingIdentities(v: VerifiedOidc, organizationSlug?: string | null): Promise<(CiIdentityRow & { organizationSlug: string })[]> {
  const rows = await db
    .select({ identity: ciIdentitiesTrusted, organizationSlug: organization.slug })
    .from(ciIdentitiesTrusted)
    .innerJoin(organization, eq(organization.id, ciIdentitiesTrusted.organizationId))
    .where(organizationSlug ? and(eq(ciIdentitiesTrusted.issuer, v.issuer), eq(organization.slug, organizationSlug)) : eq(ciIdentitiesTrusted.issuer, v.issuer))
    .orderBy(ciIdentitiesTrusted.createdAt);
  const spellings = subjectSpellings(v.subject);
  return rows.filter((r) => spellings.some((s) => subjectMatches(r.identity.subject, s))).map((r) => ({ ...r.identity, organizationSlug: r.organizationSlug }));
}

// --- Minting and identifying registry credentials -------------------------------

export interface MintedCiToken {
  token: string;
  expiresAt: Date;
  ttlSeconds: number;
}

export async function mintCiToken(identity: CiIdentityRow, oidcSubject: string, ttlSeconds = CI_TOKEN_DEFAULT_TTL): Promise<MintedCiToken> {
  const ttl = Math.max(60, Math.min(ttlSeconds, CI_TOKEN_MAX_TTL));
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ os: oidcSubject })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(env.tokenIssuer)
    .setAudience(CI_AUDIENCE)
    .setSubject(identity.id)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(hmacKey());
  await db
    .update(ciIdentitiesTrusted)
    .set({ lastUsedAt: new Date(), lastSubject: oidcSubject.slice(0, 500) })
    .where(eq(ciIdentitiesTrusted.id, identity.id));
  return { token: CI_PREFIX + jwt, expiresAt: new Date((now + ttl) * 1000), ttlSeconds: ttl };
}

export interface IdentifiedCi {
  caller: Extract<Caller, { kind: "sa" }>;
  identity: CiIdentityRow;
  oidcSubject: string;
  expiresAt: Date;
}

/**
 * Resolve a chc_ci_… credential: the JWT must verify and the identity it
 * names must still exist (deleting an identity revokes its tokens at once).
 */
export async function identifyCiToken(secret: string): Promise<IdentifiedCi | { error: string }> {
  const raw = secret.slice(CI_PREFIX.length);
  let payload: JWTPayload;
  try {
    payload = (await jwtVerify(raw, hmacKey(), { issuer: env.tokenIssuer, audience: CI_AUDIENCE })).payload;
  } catch (err) {
    return { error: /exp/i.test(String(err)) ? "CI token expired" : "invalid CI token" };
  }
  const identity = payload.sub ? await db.query.ciIdentitiesTrusted.findFirst({ where: eq(ciIdentitiesTrusted.id, payload.sub) }) : null;
  if (!identity) return { error: "the CI identity behind this token no longer exists" };
  return {
    identity,
    oidcSubject: String(payload.os ?? ""),
    expiresAt: new Date((payload.exp ?? 0) * 1000),
    caller: { kind: "sa", saId: `ci:${identity.id}`, organizationId: identity.organizationId, permission: identity.permission, repositoryIds: identity.repositoryIds ?? null },
  };
}

/** Rows with the repository allowlist resolved to names, for the UI and the API. */
export async function listCiIdentities(organizationId: string): Promise<(CiIdentityRow & { repositoryNames: string[] | null })[]> {
  const rows = await db.query.ciIdentitiesTrusted.findMany({ where: eq(ciIdentitiesTrusted.organizationId, organizationId), orderBy: (t, { asc }) => [asc(t.name)] });
  const ids = [...new Set(rows.flatMap((r) => r.repositoryIds ?? []))];
  const names = ids.length ? await db.query.repositories.findMany({ where: sql`${repositories.id} IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`, columns: { id: true, name: true } }) : [];
  const byId = new Map(names.map((r) => [r.id, r.name]));
  return rows.map((r) => ({ ...r, repositoryNames: r.repositoryIds ? r.repositoryIds.map((i) => byId.get(i) ?? "deleted repository").sort() : null }));
}

export const CI_NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Validate the fields of a new identity; throws with a user-facing message. */
export function validateCiIdentity(input: { name: string; issuer: string; subject: string; permission: string }): { name: string; issuer: string; subject: string; permission: "pull" | "push" | "admin" } {
  const name = input.name.trim();
  if (!CI_NAME_RE.test(name) || name.length > 64) throw new Error("Names use lowercase letters, digits and single ._- separators (up to 64 characters).");
  const issuer = input.issuer.trim().replace(/\/$/, "");
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(issuer) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(issuer)) throw new Error("The issuer must be an https URL, e.g. https://token.actions.githubusercontent.com.");
  const subject = input.subject.trim();
  if (!subject || subject.length > 500) throw new Error("Enter the subject the CI token carries (exact, or with * wildcards).");
  if (subject === "*") throw new Error('A subject of "*" would trust everyone at the issuer; be more specific.');
  if (!["pull", "push", "admin"].includes(input.permission)) throw new Error("Invalid permission.");
  return { name, issuer, subject, permission: input.permission as "pull" | "push" | "admin" };
}
