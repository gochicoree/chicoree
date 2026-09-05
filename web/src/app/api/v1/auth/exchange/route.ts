// POST /api/v1/auth/exchange — trade a CI system's OIDC token for a
// short-lived registry credential (keyless authentication).
import { route } from "@/lib/api/handler";
import { badRequest, iso, json, readJson, stringField, unauthorized } from "@/lib/api/respond";
import { recordAudit } from "@/lib/audit";
import { CI_TOKEN_DEFAULT_TTL, CI_TOKEN_MAX_TTL, matchingIdentities, mintCiToken, verifyOidcToken } from "@/lib/ci-auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const body = await readJson(req);
  const token = stringField(body, "token", 16_000);
  if (!token) throw badRequest('"token" is required: the OIDC token your CI system issued.');
  const organization = stringField(body, "organization", 100) || null;
  const ttlRaw = body.ttl;
  const ttl = ttlRaw === undefined || ttlRaw === null ? CI_TOKEN_DEFAULT_TTL : Number(ttlRaw);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > CI_TOKEN_MAX_TTL) throw badRequest(`"ttl" must be a whole number of seconds between 60 and ${CI_TOKEN_MAX_TTL}.`);

  const verified = await verifyOidcToken(token);
  if ("error" in verified) {
    await recordAudit({ action: "registry.login.failed", actor: { type: "system", label: "oidc" }, targetType: "issuer", targetLabel: null, details: { method: "oidc", reason: verified.error, organization }, headers: req.headers });
    throw unauthorized(`OIDC token refused: ${verified.error}.`);
  }
  const matches = await matchingIdentities(verified, organization);
  if (matches.length === 0) {
    await recordAudit({ action: "registry.login.failed", actor: { type: "system", label: "oidc" }, targetType: "subject", targetLabel: verified.subject.slice(0, 200), details: { method: "oidc", reason: "no trusted identity matches", issuer: verified.issuer, organization }, headers: req.headers });
    throw unauthorized(`No trusted CI identity matches ${verified.subject} from ${verified.issuer}${organization ? ` in ${organization}` : ""}.`);
  }
  const orgs = [...new Set(matches.map((m) => m.organizationSlug))];
  if (orgs.length > 1) throw badRequest(`The subject matches identities in several organizations (${orgs.join(", ")}); send "organization" to pick one.`);
  const identity = matches[0];
  const minted = await mintCiToken(identity, verified.subject, ttl);
  await recordAudit({
    action: "ci.exchange",
    actor: { type: "sa", id: `ci:${identity.id}`, label: `ci:${identity.name} (${verified.subject})` },
    organizationId: identity.organizationId,
    targetType: "ci_identity",
    targetId: identity.id,
    targetLabel: identity.name,
    details: { issuer: verified.issuer, subject: verified.subject, permission: identity.permission, ttl: minted.ttlSeconds, via: "api" },
    headers: req.headers,
  });
  return json({
    token: minted.token,
    expiresAt: iso(minted.expiresAt),
    ttlSeconds: minted.ttlSeconds,
    identity: { id: identity.id, name: identity.name, organization: identity.organizationSlug, permission: identity.permission, repositories: identity.repositoryIds ? identity.repositoryIds.length : null },
    subject: verified.subject,
    dockerLogin: { registry: env.registryHost, username: "ci", password: minted.token },
  });
});
