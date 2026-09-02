import { createHash, randomBytes, timingSafeEqual } from "crypto";

// Opaque credentials for docker login. The prefix identifies the credential
// type at the token endpoint; only a sha256 hash is stored server-side.
export const PAT_PREFIX = "chc_pat_";
export const SA_PREFIX = "chc_sa_";

export function generateSecret(prefix: string): { secret: string; hash: string; display: string } {
  const secret = prefix + randomBytes(30).toString("base64url");
  return { secret, hash: hashSecret(secret), display: secret.slice(0, prefix.length + 6) + "…" };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
