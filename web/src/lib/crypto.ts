// Symmetric encryption for secrets stored at rest (webhook credentials,
// mirror source passwords). Key derived from AUTH_SECRET; ciphertext format
// "v1:<iv>:<tag>:<data>" in base64url.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { env } from "./env";

function key(): Buffer {
  return createHash("sha256").update(`chicoree-secrets:${env.authSecret}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(":");
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const [v, ivB, tagB, dataB] = stored.split(":");
  if (v !== "v1" || !ivB || !tagB || !dataB) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
