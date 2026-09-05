// Keyless (Sigstore) verification. A keyless cosign signature carries a
// short-lived Fulcio certificate naming the signer's OIDC identity, plus a
// Rekor transparency-log entry that proves when it was made. Verifying it
// means: the certificate chains to the Sigstore root and carries a valid
// certificate-transparency SCT; the log entry is signed by Rekor and covers
// this signature; the certificate was valid at the logged time; and the
// signature checks out under the certificate's key. sigstore-js does all
// of that from a Sigstore bundle; cosign's older tag-convention signatures
// keep the same material in manifest annotations, which are turned into a
// bundle here first.
//
// The trusted root (Fulcio, Rekor, CT log and TSA keys of the public
// Sigstore instance) is vendored from sigstore/root-signing; point
// SIGSTORE_TRUSTED_ROOT at another trusted_root.json for a private
// instance or a newer snapshot.
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { bundleFromJSON, type Bundle } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier, type TrustMaterial } from "@sigstore/verify";
import defaultRoot from "./sigstore-trusted-root.json";

let cached: { source: string; material: TrustMaterial } | null = null;

/** Where the trusted root came from, for the health page. */
export function trustedRootSource(): string {
  return process.env.SIGSTORE_TRUSTED_ROOT || "bundled (sigstore/root-signing)";
}

function trustMaterial(): TrustMaterial {
  const source = trustedRootSource();
  if (cached && cached.source === source) return cached.material;
  const json = process.env.SIGSTORE_TRUSTED_ROOT ? JSON.parse(readFileSync(process.env.SIGSTORE_TRUSTED_ROOT, "utf8")) : defaultRoot;
  const material = toTrustMaterial(TrustedRoot.fromJSON(json));
  cached = { source, material };
  return material;
}

export interface KeylessVerification {
  ok: boolean;
  /** Subject alternative name of the certificate (email or workflow URI). */
  identity: string | null;
  /** OIDC issuer recorded by Fulcio. */
  issuer: string | null;
  /** When the transparency log saw the signature (ISO 8601). */
  signedAt: string | null;
  error: string | null;
}

function message(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? m.slice(0, 300) + "…" : m;
}

/**
 * Verify a Sigstore bundle (JSON as stored in the registry) against the
 * trusted root. `artifact` is the signed content for message signatures —
 * the subject manifest for cosign v3 bundles, the simple-signing payload
 * for converted legacy signatures; DSSE bundles carry their payload.
 */
export function verifyKeylessBundle(bundleJson: unknown, artifact?: Buffer): KeylessVerification {
  let bundle: Bundle;
  try {
    bundle = bundleFromJSON(bundleJson);
  } catch (e) {
    return { ok: false, identity: null, issuer: null, signedAt: null, error: `bundle is malformed: ${message(e)}` };
  }
  try {
    const entity = toSignedEntity(bundle, artifact);
    const verifier = new Verifier(trustMaterial(), { tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 0 });
    const signer = verifier.verify(entity);
    const entry = bundle.verificationMaterial.tlogEntries[0];
    const seconds = entry?.integratedTime ? Number(entry.integratedTime) : NaN;
    return {
      ok: true,
      identity: signer.identity?.subjectAlternativeName ?? null,
      issuer: signer.identity?.extensions?.issuer ?? null,
      signedAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
      error: null,
    };
  } catch (e) {
    return { ok: false, identity: null, issuer: null, signedAt: null, error: message(e) };
  }
}

// --- Legacy cosign material → bundle ------------------------------------------------------------

/** cosign's dev.sigstore.cosign/bundle annotation: the Rekor entry of a legacy signature. */
interface RekorBundle {
  SignedEntryTimestamp?: string;
  Payload?: { body?: string; integratedTime?: number; logIndex?: number; logID?: string };
}

/** The DER of every certificate in a PEM string, base64-encoded (what a bundle carries). */
export function pemToRawBytes(pem: string): string[] {
  const out: string[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem))) out.push(m[1].replace(/\s+/g, ""));
  return out;
}

function tlogEntryFromRekorBundle(raw: string): Record<string, unknown> | null {
  let parsed: RekorBundle;
  try {
    parsed = JSON.parse(raw) as RekorBundle;
  } catch {
    return null;
  }
  const p = parsed.Payload;
  if (!p?.body || !p.logID || !parsed.SignedEntryTimestamp) return null;
  let kind = "hashedrekord";
  let version = "0.0.1";
  try {
    const body = JSON.parse(Buffer.from(p.body, "base64").toString("utf8")) as { kind?: string; apiVersion?: string };
    if (body.kind) kind = body.kind;
    if (body.apiVersion) version = body.apiVersion;
  } catch {
    // keep the defaults; verification will say what is wrong
  }
  return {
    logIndex: String(p.logIndex ?? 0),
    logId: { keyId: Buffer.from(p.logID, "hex").toString("base64") },
    kindVersion: { kind, version },
    integratedTime: String(p.integratedTime ?? 0),
    inclusionPromise: { signedEntryTimestamp: parsed.SignedEntryTimestamp },
    canonicalizedBody: p.body,
  };
}

export interface LegacyMaterial {
  /** PEM of the signing certificate (dev.sigstore.cosign/certificate). */
  certificate: string;
  /** PEM chain up to the Fulcio root (dev.sigstore.cosign/chain), if attached. */
  chain?: string | null;
  /** The Rekor bundle annotation (dev.sigstore.cosign/bundle). */
  rekorBundle?: string | null;
}

/** Why a legacy signature cannot be turned into a verifiable bundle, or null. */
function legacyProblem(m: LegacyMaterial): string | null {
  if (pemToRawBytes(m.certificate).length === 0) return "certificate annotation is not a PEM certificate";
  if (!m.rekorBundle) return "no transparency log entry (signed without Rekor)";
  return null;
}

function legacyVerificationMaterial(m: LegacyMaterial): { material: Record<string, unknown> } | { error: string } {
  const problem = legacyProblem(m);
  if (problem) return { error: problem };
  const entry = tlogEntryFromRekorBundle(m.rekorBundle!);
  if (!entry) return { error: "transparency log annotation is malformed" };
  const certificates = [...pemToRawBytes(m.certificate), ...(m.chain ? pemToRawBytes(m.chain) : [])].map((rawBytes) => ({ rawBytes }));
  return {
    material: {
      x509CertificateChain: { certificates },
      tlogEntries: [entry],
      timestampVerificationData: { rfc3161Timestamps: [] },
    },
  };
}

/** A cosign `.sig` layer (simple-signing payload + signature annotation) as a Sigstore bundle. */
export function legacyMessageBundle(m: LegacyMaterial, payload: Buffer, signatureBase64: string): { bundle: unknown } | { error: string } {
  const vm = legacyVerificationMaterial(m);
  if ("error" in vm) return vm;
  return {
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.1",
      verificationMaterial: vm.material,
      messageSignature: {
        messageDigest: { algorithm: "SHA2_256", digest: createHash("sha256").update(payload).digest("base64") },
        signature: signatureBase64,
      },
    },
  };
}

/** A cosign `.att` layer (DSSE envelope) as a Sigstore bundle. */
export function legacyDsseBundle(
  m: LegacyMaterial,
  envelope: { payload?: string; payloadType?: string; signatures?: { sig?: string; keyid?: string }[] },
): { bundle: unknown } | { error: string } {
  const vm = legacyVerificationMaterial(m);
  if ("error" in vm) return vm;
  return {
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.1",
      verificationMaterial: vm.material,
      dsseEnvelope: {
        payload: envelope.payload ?? "",
        payloadType: envelope.payloadType ?? "",
        signatures: (envelope.signatures ?? []).map((s) => ({ sig: s.sig ?? "", keyid: s.keyid ?? "" })),
      },
    },
  };
}
