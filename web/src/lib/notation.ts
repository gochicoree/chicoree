// Notation (notaryproject.dev) signature verification. A Notation signature
// is an OCI referrer of artifact type application/vnd.cncf.notary.signature
// with one layer: a JWS (application/jose+json) or COSE (application/cose)
// envelope over a payload that names the signed manifest digest. The
// signing certificate chain travels in the envelope (x5c). We verify the
// JWS against the leaf certificate and call it *verified* when a certificate
// of the chain — usually the leaf, or the CA that issued it — is in the
// trust store (Settings → Policies → Trusted signing keys, which accepts
// certificates as well as raw public keys; the fingerprint compared is that
// of the certificate's public key). Revocation, timestamps and Notation's
// trust-policy files are out of scope. COSE envelopes are listed but not
// verified yet.
import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate, type KeyObject } from "node:crypto";
import { constants } from "node:crypto";
import { NOTATION_PAYLOAD_TYPE, parseNotationJws, type SignatureCheck } from "./signatures-shared";

export interface NotationTrustKey {
  row: { id: string; name: string; fingerprint: string; scope: "trusted" | "user"; signer?: string | null };
  key: KeyObject;
}

const ALGS: Record<string, { hash: string; kind: "rsa-pss" | "ecdsa" }> = {
  PS256: { hash: "sha256", kind: "rsa-pss" },
  PS384: { hash: "sha384", kind: "rsa-pss" },
  PS512: { hash: "sha512", kind: "rsa-pss" },
  ES256: { hash: "sha256", kind: "ecdsa" },
  ES384: { hash: "sha384", kind: "ecdsa" },
  ES512: { hash: "sha512", kind: "ecdsa" },
};

function b64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function spkiFingerprint(key: KeyObject): string {
  return createHash("sha256").update(key.export({ type: "spki", format: "der" }) as Buffer).digest("hex");
}

function cn(dn: string): string {
  const m = /(?:^|\n)CN=([^\n]+)/.exec(dn);
  return m ? m[1] : dn.split("\n")[0] ?? dn;
}

/** Verify a JWS envelope: the signature with the leaf certificate, the payload against the subject, trust against the store. */
export function verifyNotationJws(blob: Buffer, subjectDigest: string, keys: NotationTrustKey[], check: SignatureCheck): void {
  let json: unknown;
  try {
    json = JSON.parse(blob.toString("utf8"));
  } catch {
    check.status = "invalid";
    check.reason = "envelope is not JSON";
    return;
  }
  const jws = parseNotationJws(json);
  if (!jws) {
    check.status = "invalid";
    check.reason = "envelope is not a Notation JWS";
    return;
  }
  check.signedAt = jws.protected.authenticSigningTime ?? jws.protected.signingTime ?? null;
  check.signedDigest = jws.target?.digest ?? null;
  if (jws.protected.cty && jws.protected.cty !== NOTATION_PAYLOAD_TYPE) {
    check.status = "invalid";
    check.reason = `unexpected payload type ${jws.protected.cty}`;
    return;
  }
  if (!jws.target?.digest) {
    check.status = "invalid";
    check.reason = "payload names no target artifact";
    return;
  }
  if (jws.target.digest !== subjectDigest) {
    check.status = "invalid";
    check.reason = `payload names ${jws.target.digest.slice(0, 19)}, not this image`;
    return;
  }
  if (jws.x5c.length === 0) {
    check.status = "invalid";
    check.reason = "envelope carries no certificate chain (x5c)";
    return;
  }
  let chain: X509Certificate[];
  try {
    chain = jws.x5c.map((c) => new X509Certificate(Buffer.from(c, "base64")));
  } catch (err) {
    check.status = "invalid";
    check.reason = `certificate chain does not parse: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  const leaf = chain[0];
  check.identity = cn(leaf.subject);
  check.issuer = cn(leaf.issuer);
  const alg = ALGS[jws.protected.alg ?? ""];
  if (!alg) {
    check.status = "invalid";
    check.reason = `unsupported algorithm ${jws.protected.alg ?? "(none)"}`;
    return;
  }
  const signingInput = Buffer.from(`${jws.protectedB64}.${jws.payloadB64}`, "ascii");
  const signature = b64url(jws.signatureB64);
  let ok = false;
  try {
    ok =
      alg.kind === "rsa-pss"
        ? cryptoVerify(alg.hash, signingInput, { key: leaf.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature)
        : cryptoVerify(alg.hash, signingInput, { key: leaf.publicKey, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    ok = false;
  }
  if (!ok) {
    check.status = "invalid";
    check.reason = "signature does not verify with the signing certificate";
    return;
  }
  const expiry = jws.protected.expiry ? Date.parse(jws.protected.expiry) : NaN;
  if (!Number.isNaN(expiry) && expiry < Date.now()) {
    check.status = "invalid";
    check.reason = `signature expired ${jws.protected.expiry}`;
    return;
  }
  // Trust: any certificate of the chain whose public key is in the store.
  const fingerprints = chain.map((c) => spkiFingerprint(c.publicKey));
  for (const k of keys) {
    const at = fingerprints.indexOf(k.row.fingerprint);
    if (at >= 0) {
      check.status = "verified";
      check.keyId = k.row.scope === "trusted" ? k.row.id : null;
      check.userKeyId = k.row.scope === "user" ? k.row.id : null;
      check.signer = k.row.scope === "user" ? (k.row.signer ?? null) : null;
      check.keyName = k.row.name;
      check.keyFingerprint = k.row.fingerprint;
      check.reason = at === 0 ? null : `issued by trusted certificate "${k.row.name}"`;
      return;
    }
  }
  check.status = "untrusted";
  check.keyFingerprint = fingerprints[0];
  check.reason = `signing certificate ${check.identity} is not trusted here — add it (or its issuer) under Settings → Policies`;
}

/** The public key of a certificate PEM, for trust-store entries pasted as certificates. */
export function publicKeyOfCertificate(pem: string): KeyObject | null {
  try {
    return new X509Certificate(pem).publicKey;
  } catch {
    try {
      return createPublicKey({ key: pem, format: "pem" });
    } catch {
      return null;
    }
  }
}
