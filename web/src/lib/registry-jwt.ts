import { SignJWT } from "jose";
import { randomUUID } from "crypto";
import { env } from "./env";
import { activeSigner, TOKEN_TTL_SECONDS } from "./signing-keys";

// The registry trusts ES256 JWTs signed with the active signing key
// (lib/signing-keys.ts): a key generated in the admin panel, or the file
// key from scripts/gen-keys.sh. The JWT header names the key (`kid`) so
// registryd can verify against several keys during a rotation.

export interface AccessGrant {
  type: "repository" | "registry";
  name: string;
  actions: string[];
}

/** Subject strings mirror what registryd parses: user:<id>, sa:<id>, anonymous. */
export async function signRegistryToken(
  subject: string,
  access: AccessGrant[],
  ttlSeconds = TOKEN_TTL_SECONDS,
): Promise<{ token: string; issuedAt: string; expiresIn: number; kid: string }> {
  const now = Math.floor(Date.now() / 1000);
  const signer = await activeSigner();
  const token = await new SignJWT({ access })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: signer.kid })
    .setIssuer(env.tokenIssuer)
    .setAudience(env.tokenService)
    .setSubject(subject)
    .setIssuedAt(now)
    .setNotBefore(now - 10)
    .setExpirationTime(now + ttlSeconds)
    .setJti(randomUUID())
    .sign(signer.key);
  return { token, issuedAt: new Date(now * 1000).toISOString(), expiresIn: ttlSeconds, kid: signer.kid };
}

/** Token the web app itself uses to read from the registry (config blobs, GC). */
export async function systemPullToken(repositoryPath: string, ttlSeconds = 3600): Promise<string> {
  const { token } = await signRegistryToken(
    "user:system",
    [{ type: "repository", name: repositoryPath, actions: ["pull"] }],
    ttlSeconds,
  );
  return token;
}
