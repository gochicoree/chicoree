// Supply chain, server side: trusted cosign keys, discovery of the artifacts
// attached to an image (OCI referrers and cosign's tag convention),
// cryptographic verification of signatures and DSSE attestations against
// the trusted keys, cached artifact summaries (SBOM package counts, SLSA
// provenance) and the view the "Attestations" tab renders.
//
// Verification results live in manifest_signatures and are recomputed on
// push, when trusted keys change, and on demand; lib/pull-policy.ts turns
// "no verified signature" into manifest_blocks when the policy requires one.
import { constants, createHash, createPublicKey, verify as cryptoVerify, X509Certificate, type KeyObject } from "crypto";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  manifestArtifacts,
  manifestSignatures,
  manifests,
  organization,
  organizationSettings,
  repositories,
  signingKeysTrusted,
  tags,
} from "@/db/schema";
import { imagePath, splitImagePath } from "./library";
import { refreshRepositoryBlocks } from "./pull-policy";
import { effectiveSignaturePolicy } from "./pull-policy-shared";
import { fetchBlobBytes } from "./registry-client";
import {
  ANNOTATION_CERTIFICATE,
  ANNOTATION_SIGNATURE,
  COSIGN_TAG_SUFFIXES,
  classifyArtifact,
  cosignArtifactTag,
  describeSignatureStatus,
  digestHex,
  kindForSubkind,
  parseCosignTag,
  parseInTotoStatement,
  parseSimpleSigning,
  predicateSubkind,
  referenceMatchesRepository,
  statementCoversDigest,
  summarizeProvenance,
  summarizeSbom,
  type ArtifactDescriptor,
  type ArtifactSubkind,
  type ArtifactSummary,
  type Classification,
  type InTotoStatement,
  type ProvenanceSummary,
  type SbomSummary,
  type SignatureCheck,
  type SignatureStatus,
} from "./signatures-shared";

export * from "./signatures-shared";

export type TrustedKeyRow = typeof signingKeysTrusted.$inferSelect;
export type SignatureRow = typeof manifestSignatures.$inferSelect;
type RepoRow = typeof repositories.$inferSelect;

export const MAX_TRUSTED_KEYS_PER_SCOPE = 50;

// --- Public keys -------------------------------------------------------------------------

const CURVE_NAMES: Record<string, string> = {
  prime256v1: "P-256",
  secp256r1: "P-256",
  secp384r1: "P-384",
  secp521r1: "P-521",
};

export interface ParsedPublicKey {
  key: KeyObject;
  /** Normalised SPKI PEM. */
  pem: string;
  /** sha256 hex of the DER SPKI. */
  fingerprint: string;
  /** "ECDSA P-256", "Ed25519", "RSA 3072" */
  keyType: string;
}

/** sha256 over the DER SubjectPublicKeyInfo — what Sigstore bundles carry (base64) as the key hint. */
export function keyFingerprint(key: KeyObject): string {
  return createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }) as Buffer)
    .digest("hex");
}

/** Parse a PEM public key (or certificate) and describe it; throws a user-facing message. */
export function parsePublicKey(input: string): ParsedPublicKey {
  const pem = input.trim();
  if (!pem.includes("-----BEGIN")) throw new Error("Paste a PEM-encoded public key (-----BEGIN PUBLIC KEY----- …).");
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: "pem" });
  } catch (err) {
    throw new Error(`Not a usable public key: ${err instanceof Error ? err.message : String(err)}`);
  }
  const details = key.asymmetricKeyDetails ?? {};
  let keyType: string;
  switch (key.asymmetricKeyType) {
    case "ec":
      keyType = `ECDSA ${CURVE_NAMES[details.namedCurve ?? ""] ?? details.namedCurve ?? "unknown curve"}`;
      break;
    case "ed25519":
      keyType = "Ed25519";
      break;
    case "ed448":
      keyType = "Ed448";
      break;
    case "rsa":
    case "rsa-pss":
      if ((details.modulusLength ?? 0) < 2048) throw new Error("RSA keys must be at least 2048 bits.");
      keyType = `RSA ${details.modulusLength}`;
      break;
    default:
      throw new Error(`Unsupported key type "${key.asymmetricKeyType}"; use ECDSA, Ed25519 or RSA.`);
  }
  return { key, pem: key.export({ type: "spki", format: "pem" }) as string, fingerprint: keyFingerprint(key), keyType };
}

/**
 * Verify a signature the way cosign / sigstore produce them: ECDSA over
 * sha256 (DER-encoded, with P-384/P-521 hashes as fallback), Ed25519 pure,
 * RSA PKCS#1 v1.5 or PSS.
 */
export function verifyWithKey(key: KeyObject, data: Buffer, signature: Buffer): boolean {
  const attempt = (algorithm: string | null, extra?: Record<string, unknown>) => {
    try {
      return cryptoVerify(algorithm, data, { key, ...extra }, signature);
    } catch {
      return false;
    }
  };
  switch (key.asymmetricKeyType) {
    case "ed25519":
    case "ed448":
      return attempt(null);
    case "ec": {
      const curve = key.asymmetricKeyDetails?.namedCurve ?? "";
      const hashes = ["sha256", ...(curve === "secp384r1" ? ["sha384"] : curve === "secp521r1" ? ["sha512"] : [])];
      return hashes.some((h) => attempt(h) || attempt(h, { dsaEncoding: "ieee-p1363" }));
    }
    case "rsa":
    case "rsa-pss":
      return ["sha256", "sha384", "sha512"].some((h) => attempt(h) || attempt(h, { padding: constants.RSA_PKCS1_PSS_PADDING }));
    default:
      return false;
  }
}

/** DSSE pre-authentication encoding: what a DSSE signature is computed over. */
export function dssePreAuthEncoding(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.length} `), payload]);
}

// --- Keyless certificates ------------------------------------------------------------------

const OID_FULCIO_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1"; // raw string
const OID_FULCIO_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8"; // DER UTF8String

function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    let v = p;
    do {
      chunk.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return Buffer.from(bytes);
}

function readTlv(buf: Buffer, at: number): { tag: number; start: number; end: number } | null {
  if (at + 2 > buf.length) return null;
  const tag = buf[at];
  let len = buf[at + 1];
  let pos = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || pos + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + i];
    pos += n;
  }
  if (pos + len > buf.length) return null;
  return { tag, start: pos, end: pos + len };
}

/** The string value of a custom X.509 extension (Fulcio's OIDC issuer OIDs), or null. */
export function certificateExtensionString(der: Buffer, oid: string): string | null {
  const encoded = encodeOid(oid);
  const needle = Buffer.concat([Buffer.from([0x06, encoded.length]), encoded]);
  const idx = der.indexOf(needle);
  if (idx < 0) return null;
  let pos = idx + needle.length;
  let tlv = readTlv(der, pos);
  if (tlv?.tag === 0x01) {
    pos = tlv.end; // critical flag
    tlv = readTlv(der, pos);
  }
  if (!tlv || tlv.tag !== 0x04) return null;
  const value = der.subarray(tlv.start, tlv.end);
  const inner = readTlv(value, 0);
  if (inner && (inner.tag === 0x0c || inner.tag === 0x16 || inner.tag === 0x13) && inner.end === value.length) {
    return value.subarray(inner.start, inner.end).toString("utf8");
  }
  return value.toString("utf8");
}

export interface CertificateIdentity {
  /** Subject alternative names, e.g. an email or a CI workflow URI. */
  identity: string | null;
  /** OIDC issuer from the Fulcio extension. */
  issuer: string | null;
  subject: string | null;
}

/** Identity of a Fulcio (keyless) signing certificate: SAN plus OIDC issuer. */
export function certificateIdentity(cert: string | Buffer): CertificateIdentity | null {
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch {
    return null;
  }
  const san = (x509.subjectAltName ?? "")
    .split(/,\s*/)
    .map((s) => s.replace(/^(email|URI|DNS|IP Address|othername):/i, "").trim())
    .filter(Boolean)
    .join(", ");
  const issuer = certificateExtensionString(x509.raw, OID_FULCIO_ISSUER_V2) ?? certificateExtensionString(x509.raw, OID_FULCIO_ISSUER_V1);
  return { identity: san || null, issuer, subject: x509.subject || null };
}

// --- Trusted keys ----------------------------------------------------------------------------

/** Keys defined at exactly one scope: a repository, or the organization (repositoryId null). */
export async function listTrustedKeys(organizationId: string, repositoryId: string | null): Promise<TrustedKeyRow[]> {
  return db.query.signingKeysTrusted.findMany({
    where: and(
      eq(signingKeysTrusted.organizationId, organizationId),
      repositoryId ? eq(signingKeysTrusted.repositoryId, repositoryId) : isNull(signingKeysTrusted.repositoryId),
    ),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}

/** Every key a repository's signatures may be verified with: its own plus the organization's. */
export async function effectiveTrustedKeys(organizationId: string, repositoryId: string): Promise<TrustedKeyRow[]> {
  return db.query.signingKeysTrusted.findMany({
    where: and(
      eq(signingKeysTrusted.organizationId, organizationId),
      or(isNull(signingKeysTrusted.repositoryId), eq(signingKeysTrusted.repositoryId, repositoryId)),
    ),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}

export async function addTrustedKey(input: {
  organizationId: string;
  repositoryId: string | null;
  name: string;
  pem: string;
  createdBy: string | null;
}): Promise<TrustedKeyRow> {
  const name = input.name.trim();
  if (!name) throw new Error("Give the key a name.");
  if (name.length > 80) throw new Error("Key names are at most 80 characters.");
  const parsed = parsePublicKey(input.pem);
  const existing = await listTrustedKeys(input.organizationId, input.repositoryId);
  if (existing.some((k) => k.fingerprint === parsed.fingerprint)) {
    throw new Error(`This key is already trusted here as "${existing.find((k) => k.fingerprint === parsed.fingerprint)!.name}".`);
  }
  if (existing.some((k) => k.name === name)) throw new Error(`A key named "${name}" already exists in this scope.`);
  if (existing.length >= MAX_TRUSTED_KEYS_PER_SCOPE) throw new Error(`At most ${MAX_TRUSTED_KEYS_PER_SCOPE} trusted keys per scope.`);
  const [row] = await db
    .insert(signingKeysTrusted)
    .values({
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      name,
      publicKeyPem: parsed.pem,
      fingerprint: parsed.fingerprint,
      keyType: parsed.keyType,
      createdBy: input.createdBy,
    })
    .returning();
  return row;
}

export async function removeTrustedKey(id: string): Promise<TrustedKeyRow | null> {
  const [row] = await db.delete(signingKeysTrusted).where(eq(signingKeysTrusted.id, id)).returning();
  return row ?? null;
}

// --- Artifact discovery ----------------------------------------------------------------------

export interface ArtifactRef {
  digest: string;
  mediaType: string;
  artifactType: string | null;
  /** Raw manifest JSON. */
  payload: string;
  size: number;
  subjectDigest: string;
  source: "referrer" | "tag";
  /** The cosign tag it was found under, when any. */
  tag: string | null;
  createdAt: Date;
}

/**
 * Everything attached to the given image digests: manifests naming one as
 * their `subject` (the referrers API) and cosign's `sha256-<hex>.sig / .att
 * / .sbom` tags in the same repository. Oldest first.
 */
export async function discoverArtifacts(repositoryId: string, subjects: string[]): Promise<ArtifactRef[]> {
  if (subjects.length === 0) return [];
  const byDigest = new Map<string, ArtifactRef>();
  const referrers = await db
    .select({
      digest: manifests.digest,
      mediaType: manifests.mediaType,
      artifactType: manifests.artifactType,
      payload: manifests.payload,
      size: manifests.size,
      subjectDigest: manifests.subjectDigest,
      createdAt: manifests.createdAt,
    })
    .from(manifests)
    .where(and(eq(manifests.repositoryId, repositoryId), inArray(manifests.subjectDigest, subjects)));
  for (const r of referrers) {
    byDigest.set(r.digest, { ...r, subjectDigest: r.subjectDigest!, source: "referrer", tag: null });
  }
  const tagNames = subjects.flatMap((d) => COSIGN_TAG_SUFFIXES.map((s) => cosignArtifactTag(d, s)));
  const tagged = await db
    .select({
      tag: tags.name,
      digest: manifests.digest,
      mediaType: manifests.mediaType,
      artifactType: manifests.artifactType,
      payload: manifests.payload,
      size: manifests.size,
      createdAt: manifests.createdAt,
    })
    .from(tags)
    .innerJoin(manifests, and(eq(manifests.repositoryId, tags.repositoryId), eq(manifests.digest, tags.manifestDigest)))
    .where(and(eq(tags.repositoryId, repositoryId), inArray(tags.name, tagNames)));
  for (const t of tagged) {
    const parsed = parseCosignTag(t.tag);
    if (!parsed) continue;
    const existing = byDigest.get(t.digest);
    if (existing) {
      existing.tag ??= t.tag;
      continue;
    }
    byDigest.set(t.digest, { ...t, subjectDigest: parsed.digest, source: "tag" });
  }
  return [...byDigest.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Digests in a repository that have at least one artifact attached (subjects to verify). */
export async function artifactSubjects(repositoryId: string): Promise<string[]> {
  const subjects = new Set<string>();
  const refs = await db
    .selectDistinct({ subject: manifests.subjectDigest })
    .from(manifests)
    .where(eq(manifests.repositoryId, repositoryId));
  for (const r of refs) if (r.subject) subjects.add(r.subject);
  const tagRows = await db.select({ name: tags.name }).from(tags).where(eq(tags.repositoryId, repositoryId));
  for (const t of tagRows) {
    const parsed = parseCosignTag(t.name);
    if (parsed) subjects.add(parsed.digest);
  }
  const existing = await db
    .select({ digest: manifests.digest })
    .from(manifests)
    .where(and(eq(manifests.repositoryId, repositoryId), inArray(manifests.digest, [...subjects, "-"])));
  const present = new Set(existing.map((e) => e.digest));
  return [...subjects].filter((s) => present.has(s));
}

// --- Manifest helpers -------------------------------------------------------------------------

interface LayerDescriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
  annotations?: Record<string, string>;
}

interface ArtifactManifest {
  config?: { mediaType?: string; digest?: string; size?: number };
  layers?: LayerDescriptor[];
  annotations?: Record<string, string>;
  subject?: { digest?: string };
}

function parseArtifactManifest(payload: string): ArtifactManifest {
  try {
    const parsed = JSON.parse(payload) as ArtifactManifest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function descriptorOf(a: ArtifactRef, parsed: ArtifactManifest): ArtifactDescriptor {
  return {
    mediaType: a.mediaType,
    artifactType: a.artifactType,
    configMediaType: parsed.config?.mediaType ?? null,
    layerMediaTypes: (parsed.layers ?? []).map((l) => l.mediaType ?? ""),
    annotations: { ...(parsed.layers?.[0]?.annotations ?? {}), ...(parsed.annotations ?? {}) },
    tag: a.tag,
    hasSubject: a.source === "referrer",
  };
}

type BlobLoader = (digest: string) => Promise<Buffer | null>;

/** Loads blobs through the registry once per digest for the duration of one operation. */
export function makeBlobLoader(repositoryPath: string, maxBytes = 16 * 1024 * 1024): BlobLoader {
  const cache = new Map<string, Promise<Buffer | null>>();
  return (digest) => {
    let p = cache.get(digest);
    if (!p) {
      p = fetchBlobBytes(repositoryPath, digest, maxBytes)
        .then((r) => r?.bytes ?? null)
        .catch(() => null);
      cache.set(digest, p);
    }
    return p;
  };
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

interface DsseEnvelope {
  payloadType?: string;
  payload?: string;
  signatures?: { sig?: string; keyid?: string }[];
}

interface SigstoreBundle {
  mediaType?: string;
  verificationMaterial?: {
    publicKey?: { hint?: string };
    certificate?: { rawBytes?: string };
    x509CertificateChain?: { certificates?: { rawBytes?: string }[] };
  };
  dsseEnvelope?: DsseEnvelope;
  messageSignature?: { messageDigest?: { algorithm?: string; digest?: string }; signature?: string };
}

function decodeStatement(envelope: DsseEnvelope | undefined): { body: Buffer; statement: InTotoStatement | null } | null {
  if (!envelope?.payload) return null;
  const body = Buffer.from(envelope.payload, "base64");
  return { body, statement: parseInTotoStatement(parseJson(body)) };
}

// --- Artifact summaries (cached) --------------------------------------------------------------

export interface ArtifactInfo {
  classification: Classification;
  summary: ArtifactSummary;
}

/**
 * Classify an artifact and parse what the cards show (SBOM package count,
 * provenance builder / source, …). Cached in manifest_artifacts — the
 * content never changes for a digest.
 */
export async function artifactSummary(repositoryId: string, a: ArtifactRef, load: BlobLoader): Promise<ArtifactInfo> {
  const cached = await db.query.manifestArtifacts.findFirst({
    where: and(eq(manifestArtifacts.repositoryId, repositoryId), eq(manifestArtifacts.digest, a.digest)),
  });
  if (cached?.summary) {
    const summary = cached.summary as ArtifactSummary;
    return {
      classification: {
        kind: cached.kind,
        subkind: (cached.subkind as ArtifactSubkind | null) ?? null,
        format: cached.format as Classification["format"],
        predicateType: "predicateType" in summary ? summary.predicateType : null,
      },
      summary,
    };
  }

  const parsed = parseArtifactManifest(a.payload);
  const layers = parsed.layers ?? [];
  const sizeBytes = layers.reduce((n, l) => n + (l.size ?? 0), 0);
  let cls = classifyArtifact(descriptorOf(a, parsed));
  let summary: ArtifactSummary;
  // Only cache what was computed from the actual blob: a registry hiccup
  // must not pin "unavailable" on an artifact forever.
  let complete = true;

  switch (cls.format) {
    case "cosign-legacy":
      summary = { kind: "signature", predicateType: null, signatures: layers.length };
      break;
    case "sigstore-bundle":
    case "dsse": {
      const first = layers[0];
      const blob = first?.digest ? await load(first.digest) : null;
      if (!blob) complete = false;
      let error: string | null = null;
      let statement: InTotoStatement | null = null;
      let messageSignature = false;
      let predicateType = cls.predicateType;
      if (!blob) {
        error = "payload blob unavailable";
      } else {
        const obj = parseJson(blob) as (SigstoreBundle & DsseEnvelope) | null;
        if (!obj) error = "payload is not JSON";
        else {
          const envelope = cls.format === "sigstore-bundle" ? obj.dsseEnvelope : obj;
          const decoded = decodeStatement(envelope);
          if (decoded) {
            statement = decoded.statement;
            if (!statement) error = "envelope payload is not an in-toto statement";
            predicateType = statement?.predicateType ?? predicateType;
          } else if (obj.messageSignature) {
            messageSignature = true;
          } else {
            error = "no DSSE envelope in the payload";
          }
        }
      }
      const subkind: ArtifactSubkind = messageSignature ? "cosign-sign" : predicateType ? predicateSubkind(predicateType) : "custom";
      const kind = kindForSubkind(subkind);
      cls = { kind, subkind, format: cls.format, predicateType };
      if (kind === "signature") summary = { kind, predicateType, signatures: 1 };
      else if (kind === "sbom") {
        const sbom = statement ? summarizeSbom(statement.predicate) : null;
        summary = { kind, attested: true, predicateType, sbom, sizeBytes, error: error ?? (sbom ? null : "unrecognised SBOM predicate") };
      } else {
        summary = {
          kind: "attestation",
          subkind,
          predicateType,
          provenance: subkind === "provenance" && statement ? summarizeProvenance(statement.predicate, predicateType) : null,
          subjects: statement?.subjects.map((s) => (s.digests.sha256 ? `sha256:${s.digests.sha256}` : (s.name ?? ""))).filter(Boolean) ?? [],
          sizeBytes,
          error,
        };
      }
      break;
    }
    case "raw": {
      const first = layers[0];
      const blob = first?.digest ? await load(first.digest) : null;
      if (!blob) complete = false;
      const sbom = blob ? summarizeSbom(parseJson(blob)) : null;
      cls = { ...cls, subkind: sbom?.format ?? cls.subkind };
      summary = {
        kind: "sbom",
        attested: false,
        predicateType: null,
        sbom,
        sizeBytes,
        error: blob ? (sbom ? null : "unrecognised SBOM format (only SPDX and CycloneDX JSON are summarised)") : "document blob unavailable or too large to summarise",
      };
      break;
    }
    default:
      summary = { kind: "other", sizeBytes };
  }

  if (!complete) return { classification: cls, summary };
  await db
    .insert(manifestArtifacts)
    .values({
      repositoryId,
      digest: a.digest,
      subjectDigest: a.subjectDigest,
      kind: cls.kind,
      subkind: cls.subkind,
      format: cls.format,
      summary,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [manifestArtifacts.repositoryId, manifestArtifacts.digest],
      set: { subjectDigest: a.subjectDigest, kind: cls.kind, subkind: cls.subkind, format: cls.format, summary, computedAt: new Date() },
    })
    .catch(() => {
      // The artifact manifest may have been deleted meanwhile; the summary is still usable.
    });
  return { classification: cls, summary };
}

// --- Verification -------------------------------------------------------------------------------

interface PreparedKey {
  row: TrustedKeyRow;
  key: KeyObject;
}

function prepareKeys(keys: TrustedKeyRow[]): PreparedKey[] {
  const out: PreparedKey[] = [];
  for (const row of keys) {
    try {
      out.push({ row, key: createPublicKey(row.publicKeyPem) });
    } catch {
      // A stored key that no longer parses is skipped, not fatal.
    }
  }
  return out;
}

function matchKeys(check: SignatureCheck, data: Buffer, signature: Buffer, keys: PreparedKey[]): boolean {
  for (const k of keys) {
    if (verifyWithKey(k.key, data, signature)) {
      check.status = "verified";
      check.keyId = k.row.id;
      check.keyName = k.row.name;
      check.keyFingerprint = k.row.fingerprint;
      check.reason = null;
      return true;
    }
  }
  return false;
}

function applyKeyless(check: SignatureCheck, cert: string | Buffer | null | undefined): void {
  if (!cert || check.status === "verified") return;
  const id = certificateIdentity(cert);
  if (!id) return;
  check.status = "keyless";
  check.identity = id.identity ?? id.subject;
  check.issuer = id.issuer;
}

function invalid(check: SignatureCheck, reason: string): void {
  check.status = "invalid";
  check.reason = reason;
}

function verifyDsse(check: SignatureCheck, envelope: DsseEnvelope | undefined, subjectDigest: string, keys: PreparedKey[]): void {
  const decoded = decodeStatement(envelope);
  if (!decoded || !envelope) return invalid(check, "no DSSE envelope payload");
  check.predicateType = decoded.statement?.predicateType ?? null;
  if (!decoded.statement) return invalid(check, "envelope payload is not an in-toto statement");
  check.signedDigest = decoded.statement.subjects.map((s) => (s.digests.sha256 ? `sha256:${s.digests.sha256}` : "")).find(Boolean) ?? null;
  if (!statementCoversDigest(decoded.statement, subjectDigest)) return invalid(check, "the statement's subject is a different image");
  const pae = dssePreAuthEncoding(envelope.payloadType ?? "", decoded.body);
  const sigs = (envelope.signatures ?? []).filter((s) => typeof s.sig === "string");
  if (sigs.length === 0) return invalid(check, "envelope carries no signature");
  for (const s of sigs) {
    if (matchKeys(check, pae, Buffer.from(s.sig!, "base64"), keys)) return;
  }
}

/** Repository paths a cosign docker-reference may use for this repository. */
export function repositoryPathCandidates(orgSlug: string, repoName: string): string[] {
  const full = `${orgSlug}/${repoName}`;
  const short = imagePath(orgSlug, repoName);
  return short === full ? [full] : [full, short];
}

export interface SignatureResult {
  kind: "signature" | "attestation";
  status: SignatureStatus;
  keyId: string | null;
  identity: string | null;
  checks: SignatureCheck[];
}

/**
 * Check every signature an artifact carries against the trusted keys.
 * Returns null for artifacts that are not signed at all (raw SBOM tags,
 * unknown referrers).
 */
export async function checkArtifactSignatures(input: {
  orgSlug: string;
  repoName: string;
  subjectDigest: string;
  /** Exact bytes of the subject manifest — what a Sigstore message signature signs. */
  subjectPayload: string | null;
  artifact: ArtifactRef;
  classification: Classification;
  keys: TrustedKeyRow[];
  load: BlobLoader;
}): Promise<SignatureResult | null> {
  const { artifact, classification, subjectDigest } = input;
  const parsed = parseArtifactManifest(artifact.payload);
  const layers = parsed.layers ?? [];
  const keys = prepareKeys(input.keys);
  const candidates = repositoryPathCandidates(input.orgSlug, input.repoName);
  const checks: SignatureCheck[] = [];

  switch (classification.format) {
    case "cosign-legacy": {
      for (const layer of layers) {
        const check: SignatureCheck = { payloadDigest: layer.digest ?? "", format: "cosign-legacy", status: "untrusted" };
        checks.push(check);
        const payload = layer.digest ? await input.load(layer.digest) : null;
        if (!payload) {
          invalid(check, "payload blob unavailable");
          continue;
        }
        const ss = parseSimpleSigning(parseJson(payload));
        if (!ss) {
          invalid(check, "payload is not a cosign simple-signing document");
          continue;
        }
        check.signedDigest = ss.manifestDigest;
        check.signedReference = ss.dockerReference;
        const sigB64 = layer.annotations?.[ANNOTATION_SIGNATURE];
        if (ss.manifestDigest !== subjectDigest) {
          invalid(check, `payload names ${ss.manifestDigest ? ss.manifestDigest.slice(0, 19) : "no image"}, not this image`);
        } else if (!referenceMatchesRepository(ss.dockerReference, candidates)) {
          invalid(check, `payload names repository ${ss.dockerReference ?? "(none)"}`);
        } else if (!sigB64) {
          invalid(check, "no signature annotation on the payload");
        } else {
          matchKeys(check, payload, Buffer.from(sigB64, "base64"), keys);
          applyKeyless(check, layer.annotations?.[ANNOTATION_CERTIFICATE]);
        }
      }
      break;
    }
    case "sigstore-bundle": {
      const layer = layers[0];
      const check: SignatureCheck = { payloadDigest: layer?.digest ?? "", format: "sigstore-bundle", status: "untrusted" };
      checks.push(check);
      const blob = layer?.digest ? await input.load(layer.digest) : null;
      const bundle = blob ? (parseJson(blob) as SigstoreBundle | null) : null;
      if (!bundle) {
        invalid(check, blob ? "bundle is not JSON" : "bundle blob unavailable");
        break;
      }
      const hintB64 = bundle.verificationMaterial?.publicKey?.hint;
      if (hintB64) {
        try {
          check.hint = Buffer.from(hintB64, "base64").toString("hex");
        } catch {
          // ignore malformed hints
        }
      }
      if (bundle.dsseEnvelope) {
        verifyDsse(check, bundle.dsseEnvelope, subjectDigest, keys);
      } else if (bundle.messageSignature) {
        const md = bundle.messageSignature.messageDigest?.digest;
        const signed = md ? Buffer.from(md, "base64").toString("hex") : "";
        check.signedDigest = signed ? `sha256:${signed}` : null;
        if (signed !== digestHex(subjectDigest)) invalid(check, "the bundle signs a different digest");
        else if (!input.subjectPayload) invalid(check, "subject manifest unavailable");
        else if (!bundle.messageSignature.signature) invalid(check, "bundle carries no signature");
        else matchKeys(check, Buffer.from(input.subjectPayload), Buffer.from(bundle.messageSignature.signature, "base64"), keys);
      } else {
        invalid(check, "bundle has neither a DSSE envelope nor a message signature");
      }
      if (check.status === "untrusted" && check.hint) {
        const hinted = keys.find((k) => k.row.fingerprint === check.hint);
        if (hinted) invalid(check, `does not verify with trusted key "${hinted.row.name}", the key it names`);
      }
      const certRaw =
        bundle.verificationMaterial?.certificate?.rawBytes ?? bundle.verificationMaterial?.x509CertificateChain?.certificates?.[0]?.rawBytes;
      if (certRaw) applyKeyless(check, Buffer.from(certRaw, "base64"));
      break;
    }
    case "dsse": {
      for (const layer of layers) {
        const check: SignatureCheck = { payloadDigest: layer.digest ?? "", format: "dsse", status: "untrusted" };
        checks.push(check);
        const blob = layer.digest ? await input.load(layer.digest) : null;
        const envelope = blob ? (parseJson(blob) as DsseEnvelope | null) : null;
        if (!envelope) {
          invalid(check, blob ? "envelope is not JSON" : "envelope blob unavailable");
          continue;
        }
        verifyDsse(check, envelope, subjectDigest, keys);
        applyKeyless(check, layer.annotations?.[ANNOTATION_CERTIFICATE]);
      }
      break;
    }
    default:
      return null;
  }

  const verified = checks.find((c) => c.status === "verified");
  const keyless = checks.find((c) => c.status === "keyless");
  const status: SignatureStatus = verified
    ? "verified"
    : keyless
      ? "keyless"
      : checks.length > 0 && checks.every((c) => c.status === "invalid")
        ? "invalid"
        : "untrusted";
  return {
    kind: classification.kind === "signature" ? "signature" : "attestation",
    status,
    keyId: verified?.keyId ?? null,
    identity: keyless?.identity ?? null,
    checks,
  };
}

interface VerifyContext {
  keys?: TrustedKeyRow[];
  orgSlug?: string;
  load?: BlobLoader;
}

async function orgSlugOf(organizationId: string): Promise<string> {
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId), columns: { slug: true } });
  return org?.slug ?? "";
}

/**
 * Recompute manifest_signatures for one image: every attached artifact that
 * carries a signature gets a row; rows whose artifact is gone are removed.
 * Returns the number of signed artifacts found.
 */
export async function verifyManifestSignatures(repo: RepoRow, subjectDigest: string, ctx: VerifyContext = {}): Promise<number> {
  const orgSlug = ctx.orgSlug ?? (await orgSlugOf(repo.organizationId));
  const keys = ctx.keys ?? (await effectiveTrustedKeys(repo.organizationId, repo.id));
  const load = ctx.load ?? makeBlobLoader(imagePath(orgSlug, repo.name));
  const subject = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, subjectDigest)),
    columns: { payload: true },
  });
  if (!subject) return 0;
  const artifacts = await discoverArtifacts(repo.id, [subjectDigest]);
  const kept = new Set<string>();
  for (const artifact of artifacts) {
    const { classification } = await artifactSummary(repo.id, artifact, load);
    const result = await checkArtifactSignatures({
      orgSlug,
      repoName: repo.name,
      subjectDigest,
      subjectPayload: subject.payload,
      artifact,
      classification,
      keys,
      load,
    });
    if (!result) continue;
    kept.add(artifact.digest);
    const values = {
      kind: result.kind,
      status: result.status,
      keyId: result.keyId,
      identity: result.identity,
      details: result.checks,
      checkedAt: new Date(),
    };
    await db
      .insert(manifestSignatures)
      .values({ repositoryId: repo.id, manifestDigest: subjectDigest, signatureDigest: artifact.digest, ...values })
      .onConflictDoUpdate({
        target: [manifestSignatures.repositoryId, manifestSignatures.manifestDigest, manifestSignatures.signatureDigest],
        set: values,
      });
  }
  const existing = await db.query.manifestSignatures.findMany({
    where: and(eq(manifestSignatures.repositoryId, repo.id), eq(manifestSignatures.manifestDigest, subjectDigest)),
    columns: { signatureDigest: true },
  });
  for (const e of existing) {
    if (kept.has(e.signatureDigest)) continue;
    await db
      .delete(manifestSignatures)
      .where(
        and(
          eq(manifestSignatures.repositoryId, repo.id),
          eq(manifestSignatures.manifestDigest, subjectDigest),
          eq(manifestSignatures.signatureDigest, e.signatureDigest),
        ),
      );
  }
  return kept.size;
}

/** Re-verify every signed image of a repository and refresh its pull blocks. */
export async function reverifyRepository(repositoryId: string): Promise<{ subjects: number; signed: number }> {
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { subjects: 0, signed: 0 };
  const orgSlug = await orgSlugOf(repo.organizationId);
  const keys = await effectiveTrustedKeys(repo.organizationId, repo.id);
  const load = makeBlobLoader(imagePath(orgSlug, repo.name));
  const subjects = await artifactSubjects(repo.id);
  let signed = 0;
  for (const s of subjects) signed += await verifyManifestSignatures(repo, s, { keys, orgSlug, load });
  await refreshRepositoryBlocks(repo.id);
  return { subjects: subjects.length, signed };
}

/** Re-verify every repository of an organization (after an organization-wide key change). */
export async function reverifyOrganization(organizationId: string): Promise<{ repositories: number; subjects: number; signed: number }> {
  const repos = await db.query.repositories.findMany({ where: eq(repositories.organizationId, organizationId), columns: { id: true } });
  let subjects = 0;
  let signed = 0;
  for (const r of repos) {
    const out = await reverifyRepository(r.id);
    subjects += out.subjects;
    signed += out.signed;
  }
  return { repositories: repos.length, subjects, signed };
}

/**
 * Push hook (registryd's manifest.push event): a signature / attestation
 * arriving re-verifies its subject; an image arriving is checked for
 * signatures that already exist. When the repository requires signatures
 * its pull blocks are refreshed right away (an unsigned image is blocked
 * until its signature lands; a signature unblocks its image). Without the
 * policy the scan pipeline keeps owning manifest_blocks, as before.
 */
export async function onManifestPushed(repositoryPath: string, digest: string, tag: string | null | undefined): Promise<void> {
  const target = splitImagePath(repositoryPath);
  if (!target) return;
  const org = await db.query.organization.findFirst({ where: eq(organization.slug, target.orgSlug) });
  if (!org) return;
  const repo = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, org.id), eq(repositories.name, target.repoName)),
  });
  if (!repo) return;
  const row = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)),
    columns: { subjectDigest: true },
  });
  if (!row) return;
  const subject = row.subjectDigest ?? parseCosignTag(tag)?.digest ?? null;
  const ctx: VerifyContext = {
    keys: await effectiveTrustedKeys(org.id, repo.id),
    orgSlug: org.slug,
    load: makeBlobLoader(repositoryPath),
  };
  await verifyManifestSignatures(repo, subject ?? digest, ctx);
  const settings = await db.query.organizationSettings.findFirst({ where: eq(organizationSettings.organizationId, org.id) });
  if (effectiveSignaturePolicy(settings, repo)) await refreshRepositoryBlocks(repo.id, { quiet: true });
}

// --- The Attestations tab ------------------------------------------------------------------------

export interface SignatureStatusView {
  status: SignatureStatus;
  keyName: string | null;
  keyFingerprint: string | null;
  identity: string | null;
  issuer: string | null;
  checkedAt: string;
  /** "verified by key deploy", "unverified: no trusted key", … */
  description: string;
  checks: SignatureCheck[];
}

interface ArtifactBase {
  digest: string;
  subjectDigest: string;
  source: "referrer" | "tag";
  tag: string | null;
  createdAt: string;
  sizeBytes: number;
  mediaType: string;
  artifactType: string | null;
  downloadHref: string;
}

export interface SignatureView extends ArtifactBase {
  format: Classification["format"];
  predicateType: string | null;
  signatures: number;
  sig: SignatureStatusView | null;
}

export interface SbomView extends ArtifactBase {
  format: Classification["format"];
  attested: boolean;
  predicateType: string | null;
  sbom: SbomSummary | null;
  error: string | null;
  sig: SignatureStatusView | null;
}

export interface ProvenanceView extends ArtifactBase {
  predicateType: string | null;
  provenance: ProvenanceSummary | null;
  error: string | null;
  sig: SignatureStatusView | null;
}

export interface OtherArtifactView extends ArtifactBase {
  kind: Classification["kind"];
  subkind: ArtifactSubkind | null;
  format: Classification["format"];
  predicateType: string | null;
  sig: SignatureStatusView | null;
}

export interface AttestationView {
  subjects: { digest: string; label: string }[];
  signatures: SignatureView[];
  sboms: SbomView[];
  provenance: ProvenanceView[];
  others: OtherArtifactView[];
  trustedKeys: number;
  total: number;
}

function platformLabel(p: { os?: string; architecture?: string; variant?: string } | undefined): string {
  if (!p?.os && !p?.architecture) return "variant";
  return `${p.os ?? "?"}/${p.architecture ?? "?"}${p.variant ? `/${p.variant}` : ""}`;
}

/** Everything the Attestations tab shows for an image (or an index and its variants). */
export async function getAttestationView(
  repo: RepoRow,
  orgSlug: string,
  digest: string,
  payload: { manifests?: { digest?: string; platform?: { os?: string; architecture?: string; variant?: string } }[] },
): Promise<AttestationView> {
  const children = (payload.manifests ?? []).filter((m) => m.digest);
  const subjects = [
    { digest, label: children.length > 0 ? "the index" : "this image" },
    ...children.map((c) => ({ digest: c.digest!, label: platformLabel(c.platform) })),
  ];
  const digests = subjects.map((s) => s.digest);
  const [artifacts, keys] = await Promise.all([discoverArtifacts(repo.id, digests), effectiveTrustedKeys(repo.organizationId, repo.id)]);
  const load = makeBlobLoader(imagePath(orgSlug, repo.name));

  const loadRows = () =>
    db.query.manifestSignatures.findMany({
      where: and(eq(manifestSignatures.repositoryId, repo.id), inArray(manifestSignatures.manifestDigest, digests)),
    });
  let rows = await loadRows();

  const infos = new Map<string, ArtifactInfo>();
  const missing = new Set<string>();
  for (const a of artifacts) {
    const info = await artifactSummary(repo.id, a, load);
    infos.set(a.digest, info);
    const signed = info.classification.format !== "raw" && info.classification.format !== "unknown";
    if (signed && !rows.some((r) => r.signatureDigest === a.digest)) missing.add(a.subjectDigest);
  }
  if (missing.size > 0) {
    for (const s of missing) await verifyManifestSignatures(repo, s, { keys, orgSlug, load });
    rows = await loadRows();
  }

  const keyNames = new Map(keys.map((k) => [k.id, k]));
  for (const r of rows) {
    if (r.keyId && !keyNames.has(r.keyId)) {
      const k = await db.query.signingKeysTrusted.findFirst({ where: eq(signingKeysTrusted.id, r.keyId) });
      if (k) keyNames.set(k.id, k);
    }
  }
  const statusOf = (a: ArtifactRef): SignatureStatusView | null => {
    const r = rows.find((row) => row.signatureDigest === a.digest);
    if (!r) return null;
    const key = r.keyId ? keyNames.get(r.keyId) : undefined;
    const checks = (r.details as SignatureCheck[] | null) ?? [];
    const keyless = checks.find((c) => c.status === "keyless");
    return {
      status: r.status,
      keyName: key?.name ?? (r.status === "verified" ? "(removed)" : null),
      keyFingerprint: key?.fingerprint ?? null,
      identity: r.identity ?? keyless?.identity ?? null,
      issuer: keyless?.issuer ?? null,
      checkedAt: r.checkedAt.toISOString(),
      description: describeSignatureStatus({
        status: r.status,
        keyName: key?.name ?? null,
        identity: r.identity ?? keyless?.identity ?? null,
        reason: checks.find((c) => c.reason)?.reason ?? null,
      }),
      checks,
    };
  };

  const view: AttestationView = { subjects, signatures: [], sboms: [], provenance: [], others: [], trustedKeys: keys.length, total: artifacts.length };
  for (const a of artifacts) {
    const info = infos.get(a.digest)!;
    const base: ArtifactBase = {
      digest: a.digest,
      subjectDigest: a.subjectDigest,
      source: a.source,
      tag: a.tag,
      createdAt: a.createdAt.toISOString(),
      sizeBytes: "sizeBytes" in info.summary ? info.summary.sizeBytes : a.size,
      mediaType: a.mediaType,
      artifactType: a.artifactType,
      downloadHref: `/api/artifacts/${repo.id}/${a.digest}`,
    };
    const sig = statusOf(a);
    const s = info.summary;
    if (s.kind === "signature") {
      view.signatures.push({ ...base, format: info.classification.format, predicateType: s.predicateType, signatures: s.signatures, sig });
    } else if (s.kind === "sbom") {
      view.sboms.push({ ...base, format: info.classification.format, attested: s.attested, predicateType: s.predicateType, sbom: s.sbom, error: s.error, sig });
    } else if (s.kind === "attestation" && s.subkind === "provenance") {
      view.provenance.push({ ...base, predicateType: s.predicateType, provenance: s.provenance, error: s.error, sig });
    } else {
      view.others.push({
        ...base,
        kind: info.classification.kind,
        subkind: info.classification.subkind,
        format: info.classification.format,
        predicateType: info.classification.predicateType,
        sig,
      });
    }
  }
  return view;
}

// --- Downloads -----------------------------------------------------------------------------------

export interface ArtifactDownload {
  repositoryPath: string;
  layerDigest: string;
  mediaType: string;
  filename: string;
  /** Decode the DSSE statement and hand out its predicate (the SBOM / provenance document itself). */
  decode: boolean;
}

function extensionFor(mediaType: string, subkind: ArtifactSubkind | null, decoded: boolean): string {
  if (subkind === "spdx") return "spdx.json";
  if (subkind === "cyclonedx") return "cdx.json";
  if (subkind === "provenance") return "provenance.json";
  if (decoded) return "attestation.json";
  const mt = mediaType.split(";")[0].trim();
  if (mt.includes("simplesigning")) return "payload.json";
  if (mt.includes("sigstore.bundle")) return "sigstore.json";
  if (mt.includes("dsse")) return "dsse.json";
  if (mt.includes("spdx")) return mt.includes("xml") ? "spdx.xml" : "spdx.json";
  if (mt.includes("cyclonedx")) return mt.includes("xml") ? "cdx.xml" : "cdx.json";
  return mt.endsWith("+json") || mt === "application/json" ? "json" : "bin";
}

/** What GET /api/artifacts/<repo>/<digest> serves for an artifact manifest, or null. */
export async function resolveArtifactDownload(
  repo: RepoRow,
  orgSlug: string,
  digest: string,
  raw: boolean,
): Promise<ArtifactDownload | null> {
  const row = await db.query.manifests.findFirst({ where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)) });
  if (!row) return null;
  const parsed = parseArtifactManifest(row.payload);
  const layer = parsed.layers?.[0];
  if (!layer?.digest) return null;
  const cached = await db.query.manifestArtifacts.findFirst({
    where: and(eq(manifestArtifacts.repositoryId, repo.id), eq(manifestArtifacts.digest, digest)),
  });
  const ref: ArtifactRef = {
    digest: row.digest,
    mediaType: row.mediaType,
    artifactType: row.artifactType,
    payload: row.payload,
    size: row.size,
    subjectDigest: row.subjectDigest ?? "",
    source: row.subjectDigest ? "referrer" : "tag",
    tag: null,
    createdAt: row.createdAt,
  };
  const cls: Classification = cached
    ? {
        kind: cached.kind,
        subkind: (cached.subkind as ArtifactSubkind | null) ?? null,
        format: cached.format as Classification["format"],
        predicateType: null,
      }
    : classifyArtifact(descriptorOf(ref, parsed));
  const decode = !raw && (cls.format === "sigstore-bundle" || cls.format === "dsse");
  const prefix = `${repo.name.replace(/\//g, "-")}-${digestHex(digest).slice(0, 12)}`;
  const mediaType = decode ? "application/json" : (layer.mediaType ?? "application/octet-stream").split(";")[0].trim();
  return {
    repositoryPath: imagePath(orgSlug, repo.name),
    layerDigest: layer.digest,
    mediaType,
    filename: `${prefix}.${extensionFor(layer.mediaType ?? "", cls.subkind, decode)}`,
    decode,
  };
}

/** The predicate inside a DSSE envelope or Sigstore bundle blob, serialised; null when absent. */
export function extractPredicate(blob: Buffer): string | null {
  const obj = parseJson(blob) as (SigstoreBundle & DsseEnvelope) | null;
  if (!obj) return null;
  const decoded = decodeStatement(obj.dsseEnvelope ?? obj);
  if (!decoded?.statement) return null;
  return JSON.stringify(decoded.statement.predicate ?? null, null, 2);
}
