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
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  manifestArtifacts,
  manifestSignatures,
  manifests,
  member,
  organization,
  organizationSettings,
  repositories,
  signingIdentitiesTrusted,
  signingKeysTrusted,
  tags,
  user,
  userSigningKeys,
} from "@/db/schema";
import { legacyDsseBundle, legacyMessageBundle, verifyKeylessBundle } from "./sigstore";
import { imagePath, splitImagePath } from "./library";
import { WRITER_ROLES } from "./org-roles";
import { refreshRepositoryBlocks } from "./pull-policy";
import { effectiveSignaturePolicy } from "./pull-policy-shared";
import { fetchBlobBytes } from "./registry-client";
import { verifyNotationJws } from "./notation";
import {
  ANNOTATION_CERTIFICATE,
  ANNOTATION_CHAIN,
  ANNOTATION_REKOR_BUNDLE,
  ANNOTATION_SIGNATURE,
  COSIGN_TAG_SUFFIXES,
  ANNOTATION_IN_TOTO_PREDICATE,
  IN_TOTO_JSON,
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
  type StatementLayerSummary,
  type SignatureCheck,
  type SignatureStatus, NOTATION_COSE } from "./signatures-shared";

export * from "./signatures-shared";

export type TrustedKeyRow = typeof signingKeysTrusted.$inferSelect;
export type TrustedIdentityRow = typeof signingIdentitiesTrusted.$inferSelect;
export type UserKeyRow = typeof userSigningKeys.$inferSelect;
export type SignatureRow = typeof manifestSignatures.$inferSelect;
type RepoRow = typeof repositories.$inferSelect;

export const MAX_TRUSTED_KEYS_PER_SCOPE = 50;
export const MAX_TRUSTED_IDENTITIES_PER_SCOPE = 50;
export const MAX_USER_SIGNING_KEYS = 10;

/**
 * A key a signature may verify with: a key trusted by the organization or
 * repository, or the personal key of a member who may push there.
 */
export interface VerificationKey {
  id: string;
  name: string;
  fingerprint: string;
  publicKeyPem: string;
  scope: "trusted" | "user";
  /** Personal keys: the owner. */
  userId?: string;
  /** Personal keys: the owner's display name, shown as "verified by <signer>'s key <name>". */
  signer?: string;
}

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
  if (!pem.includes("-----BEGIN")) throw new Error("Paste a PEM-encoded public key (-----BEGIN PUBLIC KEY----- …) or an X.509 certificate (-----BEGIN CERTIFICATE----- …).");
  const isCertificate = pem.includes("-----BEGIN CERTIFICATE-----");
  let key: KeyObject;
  try {
    key = isCertificate ? new X509Certificate(pem).publicKey : createPublicKey({ key: pem, format: "pem" });
  } catch (err) {
    throw new Error(`Not a usable ${isCertificate ? "certificate" : "public key"}: ${err instanceof Error ? err.message : String(err)}`);
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
  return { key, pem: key.export({ type: "spki", format: "pem" }) as string, fingerprint: keyFingerprint(key), keyType: isCertificate ? `${keyType} (certificate)` : keyType };
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

/** Keys trusted for a repository by configuration: its own plus the organization's. */
export async function effectiveTrustedKeys(organizationId: string, repositoryId: string): Promise<TrustedKeyRow[]> {
  return db.query.signingKeysTrusted.findMany({
    where: and(
      eq(signingKeysTrusted.organizationId, organizationId),
      or(isNull(signingKeysTrusted.repositoryId), eq(signingKeysTrusted.repositoryId, repositoryId)),
    ),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}

export function trustedVerificationKey(k: TrustedKeyRow): VerificationKey {
  return { id: k.id, name: k.name, fingerprint: k.fingerprint, publicKeyPem: k.publicKeyPem, scope: "trusted" };
}

export function userVerificationKey(k: UserKeyRow, signer: string): VerificationKey {
  return { id: k.id, name: k.name, fingerprint: k.fingerprint, publicKeyPem: k.publicKeyPem, scope: "user", userId: k.userId, signer };
}

/** Whether an organization counts members' personal keys as trusted (the default). */
export async function orgTrustsMemberKeys(organizationId: string): Promise<boolean> {
  const s = await db.query.organizationSettings.findFirst({
    where: eq(organizationSettings.organizationId, organizationId),
    columns: { trustMemberKeys: true },
  });
  return s?.trustMemberKeys ?? true;
}

export type MemberKeyRow = UserKeyRow & { userName: string; userEmail: string; userRole: string | null; memberRole: string | null };

/**
 * Personal keys of everyone who may push to the organization's repositories:
 * members with a writer role (owner, admin, member) and instance
 * administrators, unless the account is banned. Whether they count is the
 * organization's decision (orgTrustsMemberKeys); this lists them regardless.
 */
export async function listMemberKeys(organizationId: string): Promise<MemberKeyRow[]> {
  const rows = await db
    .select({ key: userSigningKeys, userName: user.name, userEmail: user.email, userRole: user.role, memberRole: member.role })
    .from(userSigningKeys)
    .innerJoin(user, eq(user.id, userSigningKeys.userId))
    .leftJoin(member, and(eq(member.userId, userSigningKeys.userId), eq(member.organizationId, organizationId)))
    .where(and(or(isNull(user.banned), eq(user.banned, false)), or(eq(user.role, "admin"), inArray(member.role, WRITER_ROLES))))
    .orderBy(asc(user.name), asc(userSigningKeys.name));
  return rows.map((r) => ({ ...r.key, userName: r.userName, userEmail: r.userEmail, userRole: r.userRole, memberRole: r.memberRole }));
}

/**
 * Every key a repository's signatures may be verified with: the trusted keys
 * of the repository and organization, plus — when the organization allows
 * it — the personal keys of members who may push there.
 */
export async function effectiveVerificationKeys(organizationId: string, repositoryId: string): Promise<VerificationKey[]> {
  const [trusted, memberKeys] = await Promise.all([
    effectiveTrustedKeys(organizationId, repositoryId),
    orgTrustsMemberKeys(organizationId).then((on) => (on ? listMemberKeys(organizationId) : [])),
  ]);
  return [...trusted.map(trustedVerificationKey), ...memberKeys.map((k) => userVerificationKey(k, k.userName))];
}

// --- Trusted keyless identities --------------------------------------------------------------

/** Identities defined at exactly one scope: a repository, or the organization (repositoryId null). */
export async function listTrustedIdentities(organizationId: string, repositoryId: string | null): Promise<TrustedIdentityRow[]> {
  return db.query.signingIdentitiesTrusted.findMany({
    where: and(
      eq(signingIdentitiesTrusted.organizationId, organizationId),
      repositoryId ? eq(signingIdentitiesTrusted.repositoryId, repositoryId) : isNull(signingIdentitiesTrusted.repositoryId),
    ),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}

/** Identities trusted for a repository: its own plus the organization's. */
export async function effectiveTrustedIdentities(organizationId: string, repositoryId: string): Promise<TrustedIdentityRow[]> {
  return db.query.signingIdentitiesTrusted.findMany({
    where: and(
      eq(signingIdentitiesTrusted.organizationId, organizationId),
      or(isNull(signingIdentitiesTrusted.repositoryId), eq(signingIdentitiesTrusted.repositoryId, repositoryId)),
    ),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
}

/** Glob match for identity subjects: `*` matches anything, everything else is literal. */
export function subjectMatches(pattern: string, subject: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(subject);
}

/** The first trusted identity a chain-verified certificate satisfies. */
export function matchTrustedIdentity(
  identities: TrustedIdentityRow[],
  issuer: string | null | undefined,
  subject: string | null | undefined,
): TrustedIdentityRow | null {
  if (!issuer || !subject) return null;
  // A certificate may carry several SANs, joined with ", " by certificateIdentity.
  const subjects = subject.split(/,\s*/).filter(Boolean);
  for (const id of identities) {
    if (id.issuer !== issuer) continue;
    if (subjects.some((s) => subjectMatches(id.subject, s))) return id;
  }
  return null;
}

/** Validate and store a trusted identity; throws a user-facing message. */
export async function addTrustedIdentity(input: {
  organizationId: string;
  repositoryId: string | null;
  name: string;
  issuer: string;
  subject: string;
  createdBy: string;
}): Promise<TrustedIdentityRow> {
  const name = input.name.trim();
  const issuer = input.issuer.trim();
  const subject = input.subject.trim();
  if (!name || name.length > 80) throw new Error("Give the identity a name (up to 80 characters).");
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(issuer) || issuer.length > 200) throw new Error("The issuer must be an https:// URL, exactly as it appears in the certificate.");
  if (!subject || subject.length > 500) throw new Error("Enter the subject: an email address or a workflow URI (* matches anything).");
  if (subject === "*") throw new Error("A subject of just * would trust everyone the issuer signs in; name at least a domain, repository or address.");
  const existing = await listTrustedIdentities(input.organizationId, input.repositoryId);
  if (existing.length >= MAX_TRUSTED_IDENTITIES_PER_SCOPE) throw new Error(`At most ${MAX_TRUSTED_IDENTITIES_PER_SCOPE} trusted identities per ${input.repositoryId ? "repository" : "organization"}.`);
  if (existing.some((e) => e.issuer === issuer && e.subject === subject)) throw new Error("This identity is already trusted here.");
  const [row] = await db
    .insert(signingIdentitiesTrusted)
    .values({ organizationId: input.organizationId, repositoryId: input.repositoryId, name, issuer, subject, createdBy: input.createdBy })
    .returning();
  return row;
}

export async function removeTrustedIdentity(id: string): Promise<TrustedIdentityRow | null> {
  const [row] = await db.delete(signingIdentitiesTrusted).where(eq(signingIdentitiesTrusted.id, id)).returning();
  return row ?? null;
}

// --- Personal keys --------------------------------------------------------------------------

export async function listUserSigningKeys(userId: string): Promise<UserKeyRow[]> {
  return db.query.userSigningKeys.findMany({ where: eq(userSigningKeys.userId, userId), orderBy: (t, { asc }) => [asc(t.name)] });
}

/** Register a personal key; a public key belongs to exactly one account. */
export async function addUserSigningKey(input: { userId: string; name: string; pem: string }): Promise<UserKeyRow> {
  const name = input.name.trim();
  if (!name) throw new Error("Give the key a name.");
  if (name.length > 80) throw new Error("Key names are at most 80 characters.");
  const parsed = parsePublicKey(input.pem);
  const mine = await listUserSigningKeys(input.userId);
  if (mine.some((k) => k.name === name)) throw new Error(`You already have a key named "${name}".`);
  if (mine.length >= MAX_USER_SIGNING_KEYS) throw new Error(`At most ${MAX_USER_SIGNING_KEYS} personal signing keys per account.`);
  const taken = await db.query.userSigningKeys.findFirst({ where: eq(userSigningKeys.fingerprint, parsed.fingerprint), columns: { userId: true, name: true } });
  if (taken) {
    throw new Error(
      taken.userId === input.userId ? `This key is already registered as "${taken.name}".` : "This public key is already registered by another account.",
    );
  }
  const [row] = await db
    .insert(userSigningKeys)
    .values({ userId: input.userId, name, publicKeyPem: parsed.pem, fingerprint: parsed.fingerprint, keyType: parsed.keyType })
    .returning();
  return row;
}

export async function removeUserSigningKey(id: string, userId: string): Promise<UserKeyRow | null> {
  const [row] = await db.delete(userSigningKeys).where(and(eq(userSigningKeys.id, id), eq(userSigningKeys.userId, userId))).returning();
  return row ?? null;
}

/**
 * Organizations whose repositories a user's personal keys may verify in:
 * every organization for instance administrators, otherwise those where the
 * user holds a writer role. (Whether the organization trusts member keys is
 * checked at verification time.)
 */
export async function organizationsTrustingUser(userId: string): Promise<{ id: string; slug: string; name: string; role: string }[]> {
  const u = await db.query.user.findFirst({ where: eq(user.id, userId), columns: { role: true } });
  if (u?.role === "admin") {
    const all = await db.query.organization.findMany({ columns: { id: true, slug: true, name: true }, orderBy: (t, { asc }) => [asc(t.name)] });
    return all.map((o) => ({ ...o, role: "admin" }));
  }
  const rows = await db
    .select({ id: organization.id, slug: organization.slug, name: organization.name, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), inArray(member.role, WRITER_ROLES)))
    .orderBy(asc(organization.name));
  return rows;
}

/** Re-verify every organization a user's personal keys apply to (after the user adds or removes one). */
export async function reverifyForUser(userId: string): Promise<{ organizations: number; subjects: number; signed: number }> {
  const orgs = await organizationsTrustingUser(userId);
  let subjects = 0;
  let signed = 0;
  for (const o of orgs) {
    if (!(await orgTrustsMemberKeys(o.id))) continue;
    const out = await reverifyOrganization(o.id);
    subjects += out.subjects;
    signed += out.signed;
  }
  return { organizations: orgs.length, subjects, signed };
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

type ArtifactLayer = NonNullable<ReturnType<typeof parseArtifactManifest>["layers"]>[number];

/**
 * Summarise every statement layer of an attestation manifest. BuildKit
 * (`docker buildx build --sbom --provenance`) writes one such manifest per
 * platform image with the SBOM and the provenance as separate layers, each a
 * bare in-toto statement — no DSSE envelope, so nothing is signed; the
 * signature on the index is what covers them.
 */
async function summarizeStatementLayers(layers: ArtifactLayer[], load: BlobLoader): Promise<{ layers: StatementLayerSummary[]; complete: boolean }> {
  const out: StatementLayerSummary[] = [];
  let complete = true;
  for (const layer of layers) {
    if (!layer.digest) continue;
    const hint = layer.annotations?.[ANNOTATION_IN_TOTO_PREDICATE] ?? null;
    const blob = await load(layer.digest);
    let statement: InTotoStatement | null = null;
    let signed = false;
    let error: string | null = null;
    if (!blob) {
      complete = false;
      error = "payload blob unavailable";
    } else {
      const obj = parseJson(blob) as (SigstoreBundle & DsseEnvelope) | null;
      const envelope = obj?.dsseEnvelope ?? (typeof obj?.payload === "string" ? obj : undefined);
      if (envelope) {
        signed = true;
        statement = decodeStatement(envelope)?.statement ?? null;
        if (!statement) error = "envelope payload is not an in-toto statement";
      } else {
        statement = parseInTotoStatement(obj);
        if (!statement) error = obj ? "payload is not an in-toto statement" : "payload is not JSON";
      }
    }
    const predicateType = statement?.predicateType ?? hint;
    const subkind = predicateType ? predicateSubkind(predicateType) : "custom";
    const sbom = kindForSubkind(subkind) === "sbom" && statement ? summarizeSbom(statement.predicate) : null;
    out.push({
      layerDigest: layer.digest,
      mediaType: (layer.mediaType ?? IN_TOTO_JSON).split(";")[0].trim(),
      subkind,
      predicateType,
      sbom,
      provenance: subkind === "provenance" && statement ? summarizeProvenance(statement.predicate, predicateType) : null,
      subjects: statement?.subjects.map((s) => (s.digests.sha256 ? `sha256:${s.digests.sha256}` : (s.name ?? ""))).filter(Boolean) ?? [],
      sizeBytes: layer.size ?? blob?.length ?? 0,
      signed,
      error: error ?? (kindForSubkind(subkind) === "sbom" && !sbom ? "unrecognised SBOM predicate" : null),
    });
  }
  return { layers: out, complete };
}

/** Summaries written before bare in-toto statements were understood; recomputed on sight. */
function staleSummary(s: ArtifactSummary): boolean {
  return s.kind === "attestation" && s.error === "no DSSE envelope in the payload";
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
  if (cached?.summary && !staleSummary(cached.summary as ArtifactSummary)) {
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
    case "notation":
      summary = { kind: "signature", predicateType: null, signatures: layers.length };
      break;
    case "cosign-legacy":
      summary = { kind: "signature", predicateType: null, signatures: layers.length };
      break;
    case "sigstore-bundle":
    case "dsse": {
      // BuildKit's attestation manifests: SBOM and provenance side by side,
      // one bare statement per layer. Read every layer.
      if (cls.format === "dsse" && (layers.length > 1 || layers[0]?.annotations?.[ANNOTATION_IN_TOTO_PREDICATE])) {
        const read = await summarizeStatementLayers(layers, load);
        complete = read.complete;
        summary = { kind: "statements", layers: read.layers, sizeBytes };
        cls = { kind: "attestation", subkind: null, format: "dsse", predicateType: null };
        break;
      }
      const first = layers[0];
      const blob = first?.digest ? await load(first.digest) : null;
      if (!blob) complete = false;
      let error: string | null = null;
      let statement: InTotoStatement | null = null;
      let messageSignature = false;
      let unsigned = false;
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
          } else if ((statement = parseInTotoStatement(obj))) {
            // A bare statement: an attestation nobody signed.
            unsigned = true;
            predicateType = statement.predicateType ?? predicateType;
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
        summary = { kind, attested: true, predicateType, sbom, sizeBytes, error: error ?? (sbom ? null : "unrecognised SBOM predicate"), ...(unsigned ? { unsigned } : {}) };
      } else {
        summary = {
          kind: "attestation",
          subkind,
          predicateType,
          provenance: subkind === "provenance" && statement ? summarizeProvenance(statement.predicate, predicateType) : null,
          subjects: statement?.subjects.map((s) => (s.digests.sha256 ? `sha256:${s.digests.sha256}` : (s.name ?? ""))).filter(Boolean) ?? [],
          sizeBytes,
          error,
          ...(unsigned ? { unsigned } : {}),
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
  row: VerificationKey;
  key: KeyObject;
}

function prepareKeys(keys: VerificationKey[]): PreparedKey[] {
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
      check.keyId = k.row.scope === "trusted" ? k.row.id : null;
      check.userKeyId = k.row.scope === "user" ? k.row.id : null;
      check.signer = k.row.scope === "user" ? (k.row.signer ?? null) : null;
      check.keyName = k.row.name;
      check.keyFingerprint = k.row.fingerprint;
      check.reason = null;
      return true;
    }
  }
  return false;
}

/**
 * Record the outcome of a keyless check on a signature that no trusted key
 * verified: the certificate identity is shown either way; a chain that
 * verified and matches a trusted identity makes the signature verified, a
 * chain that verified without a match stays "keyless", and a failed check
 * stays "keyless" with the reason (a private Sigstore instance, a tampered
 * bundle, or a certificate that was already expired when logged).
 */
function applyKeyless(
  check: SignatureCheck,
  cert: string | Buffer | null | undefined,
  identities: TrustedIdentityRow[],
  verification: { ok: boolean; identity: string | null; issuer: string | null; signedAt: string | null; error: string | null } | { error: string },
): void {
  if (!cert || check.status === "verified") return;
  const id = certificateIdentity(cert);
  if (!id) return;
  check.status = "keyless";
  check.identity = id.identity ?? id.subject;
  check.issuer = id.issuer;
  if (!("ok" in verification) || !verification.ok) {
    check.chainVerified = false;
    check.reason = verification.error;
    return;
  }
  check.chainVerified = true;
  check.signedAt = verification.signedAt;
  if (verification.identity) check.identity = verification.identity;
  if (verification.issuer) check.issuer = verification.issuer;
  const match = matchTrustedIdentity(identities, check.issuer, check.identity);
  if (match) {
    check.status = "verified";
    check.identityId = match.id;
    check.identityName = match.name;
    check.keyId = null;
    check.userKeyId = null;
    check.reason = null;
  } else {
    check.reason = "identity is not trusted here";
  }
}

/** The legacy annotations (certificate, chain, Rekor entry) of a cosign tag-convention layer. */
function legacyMaterial(annotations: Record<string, string> | undefined): { certificate: string; chain: string | null; rekorBundle: string | null } | null {
  const certificate = annotations?.[ANNOTATION_CERTIFICATE];
  if (!certificate) return null;
  return { certificate, chain: annotations?.[ANNOTATION_CHAIN] ?? null, rekorBundle: annotations?.[ANNOTATION_REKOR_BUNDLE] ?? null };
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
  /** Trusted key that verified it. */
  keyId: string | null;
  /** Member's personal key that verified it instead. */
  userKeyId: string | null;
  /** Trusted keyless identity that verified it instead. */
  identityId: string | null;
  signer: string | null;
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
  keys: VerificationKey[];
  /** Keyless identities trusted in scope (chain-verified certificates that match count as verified). */
  identities?: TrustedIdentityRow[];
  load: BlobLoader;
}): Promise<SignatureResult | null> {
  const { artifact, classification, subjectDigest } = input;
  const parsed = parseArtifactManifest(artifact.payload);
  const layers = parsed.layers ?? [];
  const keys = prepareKeys(input.keys);
  const identities = input.identities ?? [];
  const candidates = repositoryPathCandidates(input.orgSlug, input.repoName);
  const checks: SignatureCheck[] = [];

  switch (classification.format) {
    case "notation": {
      for (const layer of layers) {
        const check: SignatureCheck = { payloadDigest: layer.digest ?? "", format: "notation", status: "untrusted" };
        checks.push(check);
        const mt = (layer.mediaType ?? "").split(";")[0].trim();
        if (mt === NOTATION_COSE) {
          check.reason = "COSE envelopes are listed but not verified yet; sign with the JWS envelope (notation's default) to have it checked";
          continue;
        }
        const blob = layer.digest ? await input.load(layer.digest) : null;
        if (!blob) {
          invalid(check, "envelope blob unavailable");
          continue;
        }
        verifyNotationJws(blob, subjectDigest, keys, check);
      }
      break;
    }
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
          const legacy = legacyMaterial(layer.annotations);
          if (legacy && check.status !== "verified") {
            const built = legacyMessageBundle(legacy, payload, sigB64);
            applyKeyless(check, legacy.certificate, identities, "error" in built ? built : verifyKeylessBundle(built.bundle, payload));
          }
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
        if (hinted) {
          const label = hinted.row.scope === "user" ? `${hinted.row.signer ?? "a member"}'s key "${hinted.row.name}"` : `trusted key "${hinted.row.name}"`;
          invalid(check, `does not verify with ${label}, the key it names`);
        }
      }
      const certRaw =
        bundle.verificationMaterial?.certificate?.rawBytes ?? bundle.verificationMaterial?.x509CertificateChain?.certificates?.[0]?.rawBytes;
      if (certRaw && check.status !== "verified") {
        // Message signatures sign the subject manifest bytes; DSSE bundles carry their payload.
        const artifactBytes = bundle.messageSignature && input.subjectPayload ? Buffer.from(input.subjectPayload) : undefined;
        const verification =
          bundle.messageSignature && !input.subjectPayload
            ? { error: "subject manifest unavailable" }
            : verifyKeylessBundle(bundle, artifactBytes);
        applyKeyless(check, Buffer.from(certRaw, "base64"), identities, verification);
      }
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
        if (typeof envelope.payload !== "string" && parseInTotoStatement(envelope)) {
          // A bare statement (BuildKit's SBOM / provenance): nothing to verify.
          checks.pop();
          continue;
        }
        verifyDsse(check, envelope, subjectDigest, keys);
        const legacy = legacyMaterial(layer.annotations);
        if (legacy && check.status !== "verified") {
          const built = legacyDsseBundle(legacy, envelope);
          applyKeyless(check, legacy.certificate, identities, "error" in built ? built : verifyKeylessBundle(built.bundle));
        }
      }
      break;
    }
    default:
      return null;
  }
  // Nothing carried a signature: no row, so the view shows "unsigned" rather than a verdict.
  if (checks.length === 0) return null;

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
    userKeyId: verified?.userKeyId ?? null,
    identityId: verified?.identityId ?? null,
    signer: verified?.signer ?? null,
    identity: verified?.identity ?? keyless?.identity ?? null,
    checks,
  };
}

interface VerifyContext {
  keys?: VerificationKey[];
  identities?: TrustedIdentityRow[];
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
  const keys = ctx.keys ?? (await effectiveVerificationKeys(repo.organizationId, repo.id));
  const identities = ctx.identities ?? (await effectiveTrustedIdentities(repo.organizationId, repo.id));
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
      identities,
      load,
    });
    if (!result) continue;
    kept.add(artifact.digest);
    const values = {
      kind: result.kind,
      status: result.status,
      keyId: result.keyId,
      userKeyId: result.userKeyId,
      identityId: result.identityId,
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
  const keys = await effectiveVerificationKeys(repo.organizationId, repo.id);
  const identities = await effectiveTrustedIdentities(repo.organizationId, repo.id);
  const load = makeBlobLoader(imagePath(orgSlug, repo.name));
  const subjects = await artifactSubjects(repo.id);
  let signed = 0;
  for (const s of subjects) signed += await verifyManifestSignatures(repo, s, { keys, identities, orgSlug, load });
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
    keys: await effectiveVerificationKeys(org.id, repo.id),
    identities: await effectiveTrustedIdentities(org.id, repo.id),
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
  /** Owner of the personal key that verified it; null for organization / repository keys. */
  signer: string | null;
  keyFingerprint: string | null;
  identity: string | null;
  issuer: string | null;
  /** Trusted identity that verified a keyless signature. */
  identityName: string | null;
  /** Keyless: whether the Sigstore chain verified (null when no keyless check ran). */
  chainVerified: boolean | null;
  /** Keyless: when the transparency log recorded the signature. */
  signedAt: string | null;
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
  /** The layer this entry is, when a manifest holds several statements (BuildKit); null for the whole manifest. */
  layerDigest: string | null;
  /** Whether the artifact carries a signature at all; false for BuildKit's statements and plain SBOM files. */
  signed: boolean;
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
  /** Keys in scope: trusted keys of the organization and repository … */
  trustedKeys: number;
  /** … and members' personal keys, when the organization trusts them. */
  memberKeys: number;
  /** Keyless identities trusted by the organization and repository. */
  trustedIdentities: number;
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
  const [artifacts, keys, identities] = await Promise.all([
    discoverArtifacts(repo.id, digests),
    effectiveVerificationKeys(repo.organizationId, repo.id),
    effectiveTrustedIdentities(repo.organizationId, repo.id),
  ]);
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

  // Keys that verified a row but are no longer in scope (removed, or the
  // owner lost push access) are still named, so the status reads the same.
  const keyNames = new Map(keys.map((k) => [k.id, k]));
  for (const r of rows) {
    if (r.keyId && !keyNames.has(r.keyId)) {
      const k = await db.query.signingKeysTrusted.findFirst({ where: eq(signingKeysTrusted.id, r.keyId) });
      if (k) keyNames.set(k.id, trustedVerificationKey(k));
    }
    if (r.userKeyId && !keyNames.has(r.userKeyId)) {
      const k = await db.query.userSigningKeys.findFirst({ where: eq(userSigningKeys.id, r.userKeyId) });
      if (k) {
        const owner = await db.query.user.findFirst({ where: eq(user.id, k.userId), columns: { name: true } });
        keyNames.set(k.id, userVerificationKey(k, owner?.name ?? "a former member"));
      }
    }
  }
  const identityNames = new Map<string, string>();
  for (const r of rows) {
    if (r.identityId && !identityNames.has(r.identityId)) {
      const i = await db.query.signingIdentitiesTrusted.findFirst({ where: eq(signingIdentitiesTrusted.id, r.identityId), columns: { name: true } });
      identityNames.set(r.identityId, i?.name ?? "(removed)");
    }
  }
  const statusOf = (a: ArtifactRef): SignatureStatusView | null => {
    const r = rows.find((row) => row.signatureDigest === a.digest);
    if (!r) return null;
    const key = r.keyId ? keyNames.get(r.keyId) : r.userKeyId ? keyNames.get(r.userKeyId) : undefined;
    const checks = (r.details as SignatureCheck[] | null) ?? [];
    const keyless = checks.find((c) => c.status === "keyless" || c.chainVerified != null);
    const verifiedCheck = checks.find((c) => c.status === "verified");
    const signer = key?.scope === "user" ? (key.signer ?? null) : (verifiedCheck?.signer ?? null);
    const identityName = r.identityId ? (identityNames.get(r.identityId) ?? "(removed)") : null;
    const keyName = identityName ? null : (key?.name ?? (r.status === "verified" ? "(removed)" : null));
    return {
      status: r.status,
      keyName,
      signer,
      keyFingerprint: key?.fingerprint ?? null,
      identity: r.identity ?? keyless?.identity ?? null,
      issuer: verifiedCheck?.issuer ?? keyless?.issuer ?? null,
      identityName,
      chainVerified: verifiedCheck?.chainVerified ?? keyless?.chainVerified ?? null,
      signedAt: verifiedCheck?.signedAt ?? keyless?.signedAt ?? null,
      checkedAt: r.checkedAt.toISOString(),
      description: describeSignatureStatus({
        status: r.status,
        keyName: key?.name ?? null,
        signer,
        identity: r.identity ?? keyless?.identity ?? null,
        identityName,
        chainVerified: verifiedCheck?.chainVerified ?? keyless?.chainVerified ?? null,
        reason: checks.find((c) => c.reason)?.reason ?? null,
      }),
      checks,
    };
  };

  const view: AttestationView = {
    subjects,
    signatures: [],
    sboms: [],
    provenance: [],
    others: [],
    trustedKeys: keys.filter((k) => k.scope === "trusted").length,
    memberKeys: keys.filter((k) => k.scope === "user").length,
    trustedIdentities: identities.length,
    total: artifacts.length,
  };
  for (const a of artifacts) {
    const info = infos.get(a.digest)!;
    const s = info.summary;
    const signed = s.kind === "signature" ? true : s.kind === "sbom" ? s.attested && !s.unsigned : s.kind === "attestation" ? !s.unsigned : false;
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
      layerDigest: null,
      signed,
    };
    const sig = statusOf(a);
    if (s.kind === "statements") {
      // One entry per statement, each downloadable on its own.
      for (const l of s.layers) {
        const entry: ArtifactBase = {
          ...base,
          sizeBytes: l.sizeBytes,
          mediaType: l.mediaType,
          downloadHref: `${base.downloadHref}?blob=${l.layerDigest}`,
          layerDigest: l.layerDigest,
          signed: l.signed,
        };
        const lsig = l.signed ? sig : null;
        const kind = kindForSubkind(l.subkind);
        if (kind === "sbom") {
          view.sboms.push({ ...entry, format: "dsse", attested: true, predicateType: l.predicateType, sbom: l.sbom, error: l.error, sig: lsig });
        } else if (l.subkind === "provenance") {
          view.provenance.push({ ...entry, predicateType: l.predicateType, provenance: l.provenance, error: l.error, sig: lsig });
        } else {
          view.others.push({ ...entry, kind, subkind: l.subkind, format: "dsse", predicateType: l.predicateType, sig: lsig });
        }
      }
      continue;
    }
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
  view.total = view.signatures.length + view.sboms.length + view.provenance.length + view.others.length;
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
  /** A specific layer of the manifest (BuildKit attestation entries hold one statement per layer); default: the first. */
  blobDigest?: string | null,
): Promise<ArtifactDownload | null> {
  const row = await db.query.manifests.findFirst({ where: and(eq(manifests.repositoryId, repo.id), eq(manifests.digest, digest)) });
  if (!row) return null;
  const parsed = parseArtifactManifest(row.payload);
  const layer = blobDigest ? parsed.layers?.find((l) => l.digest === blobDigest) : parsed.layers?.[0];
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
  // A manifest with several statements has no subkind of its own; the layer's annotation names the document.
  const layerPredicate = layer.annotations?.[ANNOTATION_IN_TOTO_PREDICATE];
  const subkind = cls.subkind ?? (layerPredicate ? predicateSubkind(layerPredicate) : null);
  return {
    repositoryPath: imagePath(orgSlug, repo.name),
    layerDigest: layer.digest,
    mediaType,
    filename: `${prefix}.${extensionFor(layer.mediaType ?? "", subkind, decode)}`,
    decode,
  };
}

/** The predicate inside a DSSE envelope, Sigstore bundle or bare in-toto statement blob, serialised; null when absent. */
export function extractPredicate(blob: Buffer): string | null {
  const obj = parseJson(blob) as (SigstoreBundle & DsseEnvelope) | null;
  if (!obj) return null;
  const statement = decodeStatement(obj.dsseEnvelope ?? obj)?.statement ?? parseInTotoStatement(obj);
  if (!statement) return null;
  return JSON.stringify(statement.predicate ?? null, null, 2);
}
