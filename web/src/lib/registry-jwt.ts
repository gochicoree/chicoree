import { readFileSync } from "fs";
import path from "path";
import { SignJWT, importPKCS8, type KeyObject } from "jose";
import { randomUUID } from "crypto";
import { env } from "./env";

// The registry trusts ES256 JWTs signed with this key; registryd holds the
// matching public key. See scripts/gen-keys.sh.

export interface AccessGrant {
  type: "repository" | "registry";
  name: string;
  actions: string[];
}

let cachedKey: CryptoKey | KeyObject | null = null;

async function signingKey() {
  if (!cachedKey) {
    const file = path.resolve(process.cwd(), env.tokenPrivateKeyFile);
    const pem = readFileSync(file, "utf8");
    cachedKey = await importPKCS8(pem, "ES256");
  }
  return cachedKey;
}

/** Subject strings mirror what registryd parses: user:<id>, sa:<id>, anonymous. */
export async function signRegistryToken(
  subject: string,
  access: AccessGrant[],
  ttlSeconds = 300,
): Promise<{ token: string; issuedAt: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ access })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuer(env.tokenIssuer)
    .setAudience(env.tokenService)
    .setSubject(subject)
    .setIssuedAt(now)
    .setNotBefore(now - 10)
    .setExpirationTime(now + ttlSeconds)
    .setJti(randomUUID())
    .sign(await signingKey());
  return { token, issuedAt: new Date(now * 1000).toISOString(), expiresIn: ttlSeconds };
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
