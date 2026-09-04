// Registry token signing keys. The web app signs registry JWTs with the
// newest active key from token_signing_keys (kid in the JWT header) and
// falls back to the file-based key (JWT_PRIVATE_KEY_FILE) when the table has
// no active key. registryd trusts the file key plus every key that is not
// retired (and those retired less than ten minutes ago — the overlap window
// covering the five-minute token TTL), so rotation never breaks clients:
// generate → wait longer than the TTL → retire the old key.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { tokenSigningKeys } from "@/db/schema";
import { decryptSecret, encryptSecret } from "./crypto";
import { env } from "./env";

/** Keys retired longer ago than this are no longer trusted by registryd. */
export const KEY_DROP_WINDOW_MS = 10 * 60 * 1000;
/** Registry token lifetime; the rotation procedure waits longer than this. */
export const TOKEN_TTL_SECONDS = 300;

/** Hex SHA-256 over the SPKI DER of a public key — the kid / fingerprint convention shared with registryd. */
export function publicKeyFingerprint(pub: KeyObject): string {
  return createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex");
}

/** Fingerprint of the public half of a PKCS#8 private key PEM. */
export function privateKeyFingerprint(pem: string): string {
  return publicKeyFingerprint(createPublicKey(createPrivateKey(pem)));
}

export interface SigningKeyRow {
  kid: string;
  fingerprint: string;
  algorithm: string;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
  createdBy: string | null;
}

function toRow(k: typeof tokenSigningKeys.$inferSelect): SigningKeyRow {
  return {
    kid: k.kid,
    fingerprint: k.kid,
    algorithm: k.algorithm,
    createdAt: k.createdAt,
    activatedAt: k.activatedAt,
    retiredAt: k.retiredAt,
    createdBy: k.createdBy,
  };
}

/** Every key ever generated, newest first. */
export async function listSigningKeys(): Promise<SigningKeyRow[]> {
  const rows = await db.query.tokenSigningKeys.findMany({ orderBy: [desc(tokenSigningKeys.createdAt)] });
  return rows.map(toRow);
}

/** Newest active (not retired) database key, or null. */
async function newestActiveKey() {
  return db.query.tokenSigningKeys.findFirst({
    where: isNull(tokenSigningKeys.retiredAt),
    orderBy: [desc(tokenSigningKeys.activatedAt), desc(tokenSigningKeys.createdAt)],
  });
}

export interface FileKeyInfo {
  path: string;
  fingerprint: string | null;
  error: string | null;
}

/** The environment-provided key: where it is and its fingerprint (null when unreadable). */
export function fileKeyInfo(): FileKeyInfo {
  const file = path.resolve(process.cwd(), env.tokenPrivateKeyFile);
  try {
    return { path: file, fingerprint: privateKeyFingerprint(readFileSync(file, "utf8")), error: null };
  } catch (e) {
    return { path: file, fingerprint: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ActiveSigner {
  kid: string;
  key: KeyObject;
  source: "database" | "file";
}

/** Parsed private keys by kid, so a rotation costs one decrypt + parse rather than one per token. */
const parsedKeys = new Map<string, KeyObject>();
let fileKey: { kid: string; key: KeyObject } | null = null;

/** Forget parsed keys (tests; after generating or retiring a key nothing needs it — the lookup below is live). */
export function invalidateSignerCache(): void {
  parsedKeys.clear();
  fileKey = null;
}

/**
 * The key that signs right now: the newest active database key, else the
 * file key (kid = its fingerprint). Looked up on every call — a one-row
 * indexed query — so a rotation takes effect on the next token request in
 * every replica; only the parsed key material is cached.
 */
export async function activeSigner(): Promise<ActiveSigner> {
  try {
    const row = await newestActiveKey();
    if (row) {
      let key = parsedKeys.get(row.kid);
      if (!key) {
        const pem = decryptSecret(row.privateKeyEncrypted);
        if (!pem) throw new Error(`signing key ${row.kid.slice(0, 12)} cannot be decrypted (AUTH_SECRET changed?)`);
        key = createPrivateKey(pem);
        parsedKeys.set(row.kid, key);
      }
      return { kid: row.kid, key, source: "database" };
    }
  } catch (e) {
    // A broken database key must not take the registry down: fall back to the file.
    console.error("token signing key lookup failed; using the file key:", e);
  }
  if (!fileKey) {
    const file = path.resolve(process.cwd(), env.tokenPrivateKeyFile);
    const key = createPrivateKey(readFileSync(file, "utf8"));
    fileKey = { kid: publicKeyFingerprint(createPublicKey(key)), key };
  }
  return { kid: fileKey.kid, key: fileKey.key, source: "file" };
}

/** Generate a P-256 key pair, store it encrypted and make it the signer. */
export async function generateSigningKey(createdBy: string | null): Promise<SigningKeyRow> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const kid = publicKeyFingerprint(publicKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const now = new Date();
  const [row] = await db
    .insert(tokenSigningKeys)
    .values({
      kid,
      publicKeyPem,
      privateKeyEncrypted: encryptSecret(privateKeyPem),
      algorithm: "ES256",
      createdAt: now,
      activatedAt: now,
      createdBy,
    })
    .returning();
  invalidateSignerCache();
  return toRow(row);
}

/**
 * Retire a key: it stops signing (it never was the signer, see below) and
 * registryd drops it ten minutes later. The active signer cannot be retired
 * — generate a replacement first.
 */
export async function retireSigningKey(kid: string): Promise<{ ok: true; key: SigningKeyRow } | { ok: false; error: string }> {
  const row = await db.query.tokenSigningKeys.findFirst({ where: (t, { eq }) => eq(t.kid, kid) });
  if (!row) return { ok: false, error: "Unknown key." };
  if (row.retiredAt) return { ok: false, error: "This key is already retired." };
  const active = await newestActiveKey();
  if (active?.kid === kid) return { ok: false, error: "This key signs tokens right now. Generate a new key first, wait longer than five minutes, then retire this one." };
  const [updated] = await db
    .update(tokenSigningKeys)
    .set({ retiredAt: new Date() })
    .where(and(eq(tokenSigningKeys.kid, kid), isNull(tokenSigningKeys.retiredAt)))
    .returning();
  if (!updated) return { ok: false, error: "This key is already retired." };
  invalidateSignerCache();
  return { ok: true, key: toRow(updated) };
}

/** Public keys registryd should trust right now: file key plus active and recently retired database keys. */
export async function trustedFingerprints(now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - KEY_DROP_WINDOW_MS);
  const rows = await db.query.tokenSigningKeys.findMany();
  const out = rows.filter((k) => !k.retiredAt || k.retiredAt > cutoff).map((k) => k.kid);
  const file = fileKeyInfo();
  if (file.fingerprint) out.push(file.fingerprint);
  return [...new Set(out)];
}
