// Supply-chain helpers that are safe for client components: media-type
// classification of artifacts attached to an image (cosign signatures,
// Sigstore bundles, in-toto attestations, SBOMs), the cosign tag convention,
// parsers for SBOM / SLSA provenance summaries and the wording of
// verification statuses. No Node APIs, no database.

export type ArtifactKind = "signature" | "attestation" | "sbom" | "other";
export type ArtifactSubkind = "provenance" | "spdx" | "cyclonedx" | "vuln" | "cosign-sign" | "notation" | "custom";
/** `in-toto`: bare in-toto statements without a signature — what BuildKit attaches (`--attest`), never verified. */
export type ArtifactFormat = "cosign-legacy" | "sigstore-bundle" | "dsse" | "in-toto" | "notation" | "raw" | "unknown";
export type SignatureStatus = "verified" | "untrusted" | "invalid" | "keyless";

// --- Media types and annotations ---------------------------------------------------

export const COSIGN_SIMPLE_SIGNING = "application/vnd.dev.cosign.simplesigning.v1+json";
export const DSSE_ENVELOPE = "application/vnd.dsse.envelope.v1+json";
export const IN_TOTO_JSON = "application/vnd.in-toto+json";
/** BuildKit's attestation entries in an image index (`unknown/unknown`): SBOM and provenance as bare in-toto statements. */
export const BUILDKIT_ATTESTATION_MANIFEST = "application/vnd.docker.attestation.manifest.v1+json";
export const SIGSTORE_BUNDLE_PREFIX = "application/vnd.dev.sigstore.bundle";
export const SPDX_JSON = "application/spdx+json";
export const CYCLONEDX_JSON = "application/vnd.cyclonedx+json";
export const OCI_EMPTY_CONFIG = "application/vnd.oci.empty.v1+json";
/** Notation (notaryproject.dev): signatures are referrers of this artifact type with one JWS or COSE layer. */
export const NOTATION_ARTIFACT_TYPE = "application/vnd.cncf.notary.signature";
export const NOTATION_JWS = "application/jose+json";
export const NOTATION_COSE = "application/cose";
export const NOTATION_PAYLOAD_TYPE = "application/vnd.cncf.notary.payload.v1+json";

/** Layer media types that carry an SBOM document as-is. */
export const SBOM_MEDIA_TYPES = [
  SPDX_JSON,
  CYCLONEDX_JSON,
  "text/spdx+json",
  "text/spdx",
  "application/vnd.syft+json",
  "application/vnd.cyclonedx+xml",
  "text/spdx+xml",
];

/** Cosign's legacy signature annotation: base64 of the signature over the raw payload blob. */
export const ANNOTATION_SIGNATURE = "dev.cosignproject.cosign/signature";
/** PEM certificate of a keyless (Fulcio) signature. */
export const ANNOTATION_CERTIFICATE = "dev.sigstore.cosign/certificate";
export const ANNOTATION_CHAIN = "dev.sigstore.cosign/chain";
/** Rekor transparency-log entry of a legacy (tag-convention) keyless signature. */
export const ANNOTATION_REKOR_BUNDLE = "dev.sigstore.cosign/bundle";
/** Sigstore bundle referrers: "dsse-envelope" | "message-signature". */
export const ANNOTATION_BUNDLE_CONTENT = "dev.sigstore.bundle.content";
export const ANNOTATION_BUNDLE_PREDICATE = "dev.sigstore.bundle.predicateType";

export const PREDICATE_COSIGN_SIGN = "https://sigstore.dev/cosign/sign/v1";

export function isSbomMediaType(mediaType: string | null | undefined): boolean {
  return !!mediaType && SBOM_MEDIA_TYPES.includes(mediaType.split(";")[0].trim());
}

/** Media types that only ever appear in attached artifacts, never in runnable images. */
export function isArtifactMediaType(mediaType: string | null | undefined): boolean {
  if (!mediaType) return false;
  const mt = mediaType.split(";")[0].trim();
  return (
    mt === COSIGN_SIMPLE_SIGNING ||
    mt === DSSE_ENVELOPE ||
    mt === IN_TOTO_JSON ||
    mt === NOTATION_JWS ||
    mt === NOTATION_COSE ||
    mt.startsWith(SIGSTORE_BUNDLE_PREFIX) ||
    isSbomMediaType(mt)
  );
}

// --- Cosign tag convention ------------------------------------------------------------

export const COSIGN_TAG_RE = /^sha256-([a-f0-9]{64})\.(sig|att|sbom)$/;
export const COSIGN_TAG_SUFFIXES = ["sig", "att", "sbom"] as const;

export function digestHex(digest: string): string {
  return digest.includes(":") ? digest.slice(digest.indexOf(":") + 1) : digest;
}

/** `sha256-<hex>.sig` for a subject digest. */
export function cosignArtifactTag(digest: string, suffix: (typeof COSIGN_TAG_SUFFIXES)[number]): string {
  return `sha256-${digestHex(digest)}.${suffix}`;
}

export function parseCosignTag(tag: string | null | undefined): { digest: string; suffix: string } | null {
  if (!tag) return null;
  const m = COSIGN_TAG_RE.exec(tag);
  return m ? { digest: `sha256:${m[1]}`, suffix: m[2] } : null;
}

// --- Classification --------------------------------------------------------------------

export interface ArtifactDescriptor {
  mediaType: string;
  artifactType?: string | null;
  configMediaType?: string | null;
  layerMediaTypes: string[];
  /** Manifest annotations merged with the first layer's annotations. */
  annotations?: Record<string, string> | null;
  /** The cosign tag the manifest was pushed under, when discovered that way. */
  tag?: string | null;
  hasSubject: boolean;
}

export interface Classification {
  kind: ArtifactKind;
  subkind: ArtifactSubkind | null;
  format: ArtifactFormat;
  predicateType: string | null;
}

/** in-toto predicateType → what the attestation is about. */
export function predicateSubkind(predicateType: string | null | undefined): ArtifactSubkind {
  const t = (predicateType ?? "").toLowerCase();
  if (!t) return "custom";
  if (t.includes("sigstore.dev/cosign/sign")) return "cosign-sign";
  if (t.includes("slsa.dev/provenance") || t.includes("in-toto.io/provenance")) return "provenance";
  if (t.includes("spdx")) return "spdx";
  if (t.includes("cyclonedx")) return "cyclonedx";
  if (t.includes("vuln")) return "vuln";
  return "custom";
}

export function kindForSubkind(subkind: ArtifactSubkind): ArtifactKind {
  if (subkind === "cosign-sign" || subkind === "notation") return "signature";
  if (subkind === "spdx" || subkind === "cyclonedx") return "sbom";
  return "attestation";
}

/**
 * What an attached manifest is, judged from its descriptors alone. The
 * blob may refine it later (a DSSE envelope's statement names the real
 * predicate type).
 */
export function classifyArtifact(d: ArtifactDescriptor): Classification {
  const layers = d.layerMediaTypes.map((m) => m.split(";")[0].trim());
  const ann = d.annotations ?? {};
  const tagSuffix = parseCosignTag(d.tag)?.suffix ?? null;

  if (d.artifactType === NOTATION_ARTIFACT_TYPE || layers.includes(NOTATION_JWS) || layers.includes(NOTATION_COSE)) {
    return { kind: "signature", subkind: "notation", format: "notation", predicateType: null };
  }
  if (layers.some((m) => m.startsWith(SIGSTORE_BUNDLE_PREFIX)) || (d.artifactType ?? "").startsWith(SIGSTORE_BUNDLE_PREFIX)) {
    const predicateType = ann[ANNOTATION_BUNDLE_PREDICATE] ?? null;
    if (ann[ANNOTATION_BUNDLE_CONTENT] === "message-signature") {
      return { kind: "signature", subkind: "cosign-sign", format: "sigstore-bundle", predicateType: null };
    }
    const subkind = predicateType ? predicateSubkind(predicateType) : "custom";
    return { kind: kindForSubkind(subkind), subkind, format: "sigstore-bundle", predicateType };
  }
  if (layers.includes(COSIGN_SIMPLE_SIGNING) || tagSuffix === "sig") {
    return { kind: "signature", subkind: "cosign-sign", format: "cosign-legacy", predicateType: null };
  }
  // BuildKit stores its SBOM and provenance as plain statements, one per
  // layer, with nothing signed: not an envelope to verify, so not "invalid".
  if (d.artifactType === BUILDKIT_ATTESTATION_MANIFEST || ann["vnd.docker.reference.type"] === "attestation-manifest") {
    return { kind: "attestation", subkind: "custom", format: "in-toto", predicateType: null };
  }
  if (layers.includes(DSSE_ENVELOPE) || layers.includes(IN_TOTO_JSON) || tagSuffix === "att") {
    const predicateType = ann.predicateType ?? ann[ANNOTATION_BUNDLE_PREDICATE] ?? null;
    const subkind = predicateType ? predicateSubkind(predicateType) : "custom";
    return { kind: kindForSubkind(subkind), subkind, format: "dsse", predicateType };
  }
  if (layers.some(isSbomMediaType) || tagSuffix === "sbom") {
    const mt = layers.find(isSbomMediaType) ?? "";
    const subkind: ArtifactSubkind | null = mt.includes("spdx") ? "spdx" : mt.includes("cyclonedx") ? "cyclonedx" : null;
    return { kind: "sbom", subkind, format: "raw", predicateType: null };
  }
  return { kind: "other", subkind: null, format: "unknown", predicateType: null };
}

/**
 * Whether a manifest is an attached artifact rather than an image: it names
 * a subject, sits under a cosign tag, or consists of artifact-only layers.
 * The signature pull policy never blocks these.
 */
export function looksLikeArtifact(m: {
  hasSubject: boolean;
  tags: string[];
  layerMediaTypes: string[];
  configMediaType?: string | null;
}): boolean {
  if (m.hasSubject) return true;
  if (m.tags.some((t) => parseCosignTag(t))) return true;
  if (m.configMediaType === OCI_EMPTY_CONFIG) return true;
  return m.layerMediaTypes.length > 0 && m.layerMediaTypes.every(isArtifactMediaType);
}

// --- Payload parsers ---------------------------------------------------------------------

export interface SimpleSigningPayload {
  manifestDigest: string | null;
  dockerReference: string | null;
  type: string | null;
}

/** Cosign's simple-signing payload: {"critical":{"identity":{"docker-reference"},"image":{"docker-manifest-digest"},"type"}}. */
export function parseSimpleSigning(obj: unknown): SimpleSigningPayload | null {
  if (!obj || typeof obj !== "object") return null;
  const critical = (obj as { critical?: Record<string, unknown> }).critical;
  if (!critical || typeof critical !== "object") return null;
  const image = critical.image as Record<string, unknown> | undefined;
  const identity = critical.identity as Record<string, unknown> | undefined;
  return {
    manifestDigest: typeof image?.["docker-manifest-digest"] === "string" ? (image["docker-manifest-digest"] as string) : null,
    dockerReference: typeof identity?.["docker-reference"] === "string" ? (identity["docker-reference"] as string) : null,
    type: typeof critical.type === "string" ? critical.type : null,
  };
}

export interface InTotoStatement {
  type: string | null;
  predicateType: string | null;
  subjects: { name: string | null; digests: Record<string, string> }[];
  predicate: unknown;
}

export function parseInTotoStatement(obj: unknown): InTotoStatement | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const type = typeof o._type === "string" ? o._type : null;
  const predicateType = typeof o.predicateType === "string" ? o.predicateType : null;
  if (!type && !predicateType) return null;
  const subjects = Array.isArray(o.subject)
    ? o.subject
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s) => ({
          name: typeof s.name === "string" ? s.name : null,
          digests: Object.fromEntries(
            Object.entries((s.digest as Record<string, unknown>) ?? {}).filter(([, v]) => typeof v === "string"),
          ) as Record<string, string>,
        }))
    : [];
  return { type, predicateType, subjects, predicate: o.predicate ?? null };
}

/** Whether a statement's subjects include the image digest. */
export function statementCoversDigest(statement: InTotoStatement, digest: string): boolean {
  const hex = digestHex(digest).toLowerCase();
  return statement.subjects.some((s) => (s.digests.sha256 ?? "").toLowerCase() === hex);
}

/**
 * Whether cosign's docker-reference names this repository. The host is
 * ignored (registries are reached under several names), tags and digests
 * are stripped; `candidates` are the acceptable paths ("acme/alpine", and
 * for library images also the bare name).
 */
export function referenceMatchesRepository(reference: string | null | undefined, candidates: string[]): boolean {
  if (!reference) return false;
  let ref = reference.trim();
  const at = ref.indexOf("@");
  if (at >= 0) ref = ref.slice(0, at);
  const lastSlash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon > lastSlash) ref = ref.slice(0, colon);
  const parts = ref.split("/").filter(Boolean);
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) parts.shift();
  const path = parts.join("/").toLowerCase();
  return candidates.some((c) => c.toLowerCase() === path);
}

// --- Summaries ---------------------------------------------------------------------------------

export interface SbomComponent {
  name: string;
  version: string | null;
  license: string | null;
}

export interface SbomSummary {
  format: "spdx" | "cyclonedx";
  /** Document / root component name. */
  name: string | null;
  /** Spec version (SPDX-2.3, CycloneDX 1.5). */
  specVersion: string | null;
  packageCount: number;
  /** The first few components, for the card. */
  components: SbomComponent[];
  tool: string | null;
  createdAt: string | null;
}

export const SBOM_COMPONENT_PREVIEW = 8;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

export interface SbomPackage {
  name: string;
  version: string | null;
  license: string | null;
}

/** Every package of an SPDX 2.x JSON or CycloneDX JSON document, in document order. */
export function sbomPackages(doc: unknown): SbomPackage[] {
  if (!doc || typeof doc !== "object") return [];
  const o = doc as Record<string, unknown>;
  if (typeof o.spdxVersion === "string" || typeof o.SPDXID === "string") {
    const packages = Array.isArray(o.packages) ? (o.packages as Record<string, unknown>[]) : [];
    return packages.map((p) => ({
      name: str(p.name) ?? "unnamed",
      version: str(p.versionInfo),
      license: str(p.licenseConcluded) ?? str(p.licenseDeclared),
    }));
  }
  if (o.bomFormat === "CycloneDX") {
    const components = Array.isArray(o.components) ? (o.components as Record<string, unknown>[]) : [];
    return components.map((c) => {
      const licenses = Array.isArray(c.licenses) ? (c.licenses as Record<string, unknown>[]) : [];
      const first = licenses[0]?.license as Record<string, unknown> | undefined;
      return {
        name: str(c.name) ?? "unnamed",
        version: str(c.version),
        license: str(first?.id) ?? str(first?.name) ?? str(licenses[0]?.expression),
      };
    });
  }
  return [];
}

/** Package count and a preview of components for SPDX 2.x JSON or CycloneDX JSON. */
export function summarizeSbom(doc: unknown): SbomSummary | null {
  if (!doc || typeof doc !== "object") return null;
  const o = doc as Record<string, unknown>;
  if (typeof o.spdxVersion === "string" || typeof o.SPDXID === "string") {
    const packages = Array.isArray(o.packages) ? (o.packages as Record<string, unknown>[]) : [];
    const info = (o.creationInfo as Record<string, unknown>) ?? {};
    const creators = Array.isArray(info.creators) ? (info.creators as unknown[]).filter((c): c is string => typeof c === "string") : [];
    const tool = creators.find((c) => c.startsWith("Tool:"))?.replace(/^Tool:\s*/, "") ?? creators[0] ?? null;
    return {
      format: "spdx",
      name: str(o.name),
      specVersion: str(o.spdxVersion),
      packageCount: packages.length,
      // The first entry describes the image itself, which the card already
      // names above the list; showing it again wastes a slot.
      components: sbomPackages(o)
        .filter((p) => p.name !== str(o.name))
        .slice(0, SBOM_COMPONENT_PREVIEW),
      tool,
      createdAt: str(info.created),
    };
  }
  if (o.bomFormat === "CycloneDX") {
    const components = Array.isArray(o.components) ? (o.components as Record<string, unknown>[]) : [];
    const meta = (o.metadata as Record<string, unknown>) ?? {};
    const root = (meta.component as Record<string, unknown>) ?? {};
    let tool: string | null = null;
    const tools = meta.tools;
    if (Array.isArray(tools)) {
      const t = tools[0] as Record<string, unknown> | undefined;
      tool = t ? [str(t.name), str(t.version)].filter(Boolean).join(" ") || null : null;
    } else if (tools && typeof tools === "object") {
      const list = (tools as Record<string, unknown>).components;
      const t = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
      tool = t ? [str(t.name), str(t.version)].filter(Boolean).join(" ") || null : null;
    }
    const rootName = str(root.name);
    return {
      format: "cyclonedx",
      name: rootName ? (str(root.version) ? `${rootName}:${root.version}` : rootName) : null,
      specVersion: str(o.specVersion) ? `CycloneDX ${o.specVersion}` : null,
      packageCount: components.length,
      components: sbomPackages(o).slice(0, SBOM_COMPONENT_PREVIEW),
      tool,
      createdAt: str(meta.timestamp),
    };
  }
  return null;
}

export interface ProvenanceSummary {
  /** "SLSA v1", "SLSA v0.2" or the predicate type. */
  version: string;
  builderId: string | null;
  buildType: string | null;
  sourceUri: string | null;
  sourceCommit: string | null;
  /** Workflow path / entry point inside the source. */
  entryPoint: string | null;
  invocationId: string | null;
  startedOn: string | null;
  finishedOn: string | null;
  /** resolvedDependencies (v1) or materials (v0.2). */
  dependencies: number;
  /** externalParameters.inputs (v1) or invocation.parameters (v0.2), trimmed for display. */
  parameters: Record<string, unknown> | null;
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function smallRecord(v: unknown): Record<string, unknown> | null {
  const r = record(v);
  const keys = Object.keys(r);
  if (keys.length === 0) return null;
  const out: Record<string, unknown> = {};
  for (const k of keys.slice(0, 12)) {
    const val = r[k];
    out[k] = typeof val === "string" || typeof val === "number" || typeof val === "boolean" ? val : val === null ? null : "…";
  }
  return out;
}

/** Builder, source and invocation from a SLSA provenance predicate (v1 or v0.2). */
export function summarizeProvenance(predicate: unknown, predicateType: string | null): ProvenanceSummary | null {
  const p = record(predicate);
  if (Object.keys(p).length === 0) return null;
  const type = predicateType ?? "";
  if (p.buildDefinition || p.runDetails || /provenance\/v1/.test(type)) {
    const def = record(p.buildDefinition);
    const run = record(p.runDetails);
    const ext = record(def.externalParameters);
    const workflow = record(ext.workflow);
    const source = record(ext.source);
    const deps = Array.isArray(def.resolvedDependencies) ? (def.resolvedDependencies as Record<string, unknown>[]) : [];
    const gitDep = deps.find((d) => record(d.digest).gitCommit || record(d.digest).sha1);
    const digest = record(gitDep?.digest);
    const meta = record(run.metadata);
    return {
      version: "SLSA v1",
      builderId: str(record(run.builder).id),
      buildType: str(def.buildType),
      sourceUri: str(workflow.repository) ?? str(source.uri) ?? str(gitDep?.uri) ?? str(deps[0]?.uri),
      sourceCommit: str(digest.gitCommit) ?? str(digest.sha1) ?? str(record(source.digest).gitCommit),
      entryPoint: str(workflow.path) ?? str(ext.entryPoint),
      invocationId: str(meta.invocationId),
      startedOn: str(meta.startedOn),
      finishedOn: str(meta.finishedOn),
      dependencies: deps.length,
      parameters: smallRecord(ext.inputs) ?? smallRecord(ext),
    };
  }
  if (p.builder || p.invocation || p.buildType || /provenance\/v0/.test(type)) {
    const inv = record(p.invocation);
    const cfg = record(inv.configSource);
    const meta = record(p.metadata);
    const materials = Array.isArray(p.materials) ? (p.materials as Record<string, unknown>[]) : [];
    const digest = record(cfg.digest);
    return {
      version: "SLSA v0.2",
      builderId: str(record(p.builder).id),
      buildType: str(p.buildType),
      sourceUri: str(cfg.uri) ?? str(materials[0]?.uri),
      sourceCommit: str(digest.sha1) ?? str(digest.gitCommit) ?? str(record(materials[0]?.digest).sha1),
      entryPoint: str(cfg.entryPoint),
      invocationId: str(meta.buildInvocationId),
      startedOn: str(meta.buildStartedOn),
      finishedOn: str(meta.buildFinishedOn),
      dependencies: materials.length,
      parameters: smallRecord(inv.parameters),
    };
  }
  return null;
}

// --- Verification results ------------------------------------------------------------------------

/** One checked signature (a legacy layer, or one DSSE / message signature of a bundle). */
export interface SignatureCheck {
  /** Digest of the signed payload blob (legacy) or the bundle blob. */
  payloadDigest: string;
  format: ArtifactFormat;
  status: SignatureStatus;
  keyId?: string | null;
  /** Set instead of keyId when a member's personal key verified the signature. */
  userKeyId?: string | null;
  /** Display name of the personal key's owner. */
  signer?: string | null;
  keyName?: string | null;
  keyFingerprint?: string | null;
  /** Key fingerprint a Sigstore bundle hints at (hex), when present. */
  hint?: string | null;
  /** Certificate identity (SAN) of a keyless signature. */
  identity?: string | null;
  /** OIDC issuer from the Fulcio certificate extension. */
  issuer?: string | null;
  /**
   * Keyless only: true when the Fulcio chain, the CT log SCT and the Rekor
   * entry verified against the Sigstore trusted root; false when the check
   * ran and failed (reason says why); absent when it could not run.
   */
  chainVerified?: boolean | null;
  /** Trusted identity (signing_identities_trusted) that matched a chain-verified signature. */
  identityId?: string | null;
  identityName?: string | null;
  /** When the transparency log recorded the signature. */
  signedAt?: string | null;
  signedDigest?: string | null;
  signedReference?: string | null;
  predicateType?: string | null;
  reason?: string | null;
}

export type ArtifactSummary =
  | { kind: "signature"; predicateType: string | null; signatures: number }
  | { kind: "sbom"; attested: boolean; predicateType: string | null; sbom: SbomSummary | null; sizeBytes: number; error: string | null }
  | {
      kind: "attestation";
      subkind: ArtifactSubkind;
      predicateType: string | null;
      provenance: ProvenanceSummary | null;
      subjects: string[];
      sizeBytes: number;
      error: string | null;
    }
  | { kind: "other"; sizeBytes: number };

export function describeSignatureStatus(check: {
  status: SignatureStatus;
  keyName?: string | null;
  /** Owner of the personal key that verified it, when it was not an organization / repository key. */
  signer?: string | null;
  identity?: string | null;
  /** Trusted identity that verified a keyless signature. */
  identityName?: string | null;
  /** Keyless: whether the Sigstore chain verified. */
  chainVerified?: boolean | null;
  reason?: string | null;
}): string {
  switch (check.status) {
    case "verified":
      if (check.identityName) return `verified by identity ${check.identityName}${check.identity ? ` (${check.identity})` : ""}`;
      if (check.signer) return `verified by ${check.signer}'s key ${check.keyName ?? "(removed)"}`;
      return `verified by key ${check.keyName ?? "(removed)"}`;
    case "untrusted":
      return check.reason ? `unverified: ${check.reason}` : "unverified: no trusted key";
    case "invalid":
      return check.reason ? `invalid: ${check.reason}` : "invalid";
    case "keyless": {
      const who = check.identity ? `keyless (${check.identity})` : "keyless";
      if (check.chainVerified) return `${who}, verified by Sigstore, identity not trusted here`;
      return check.reason ? `${who}, not verified: ${check.reason}` : `${who}, not verified`;
    }
  }
}

export function signatureFormatLabel(format: ArtifactFormat): string {
  switch (format) {
    case "cosign-legacy":
      return "cosign signature";
    case "sigstore-bundle":
      return "Sigstore bundle";
    case "dsse":
      return "DSSE envelope";
    case "notation":
      return "Notation signature";
    case "raw":
      return "raw document";
    default:
      return "unknown format";
  }
}

export function predicateLabel(predicateType: string | null | undefined, subkind: ArtifactSubkind | null | undefined): string {
  switch (subkind) {
    case "provenance":
      return /v1/.test(predicateType ?? "") ? "SLSA provenance v1" : "SLSA provenance";
    case "spdx":
      return "SPDX SBOM";
    case "cyclonedx":
      return "CycloneDX SBOM";
    case "vuln":
      return "vulnerability attestation";
    case "cosign-sign":
      return "cosign signature";
    default:
      return predicateType ?? "custom attestation";
  }
}

/** The signature-policy block reason written to manifest_blocks. */
export const SIGNATURE_BLOCK_REASON = "no signature from a trusted key or identity (signature policy)";

export function isSignatureBlockReason(reason: string | null | undefined): boolean {
  return !!reason && reason.includes("(signature policy)");
}

// --- Notation JWS envelopes (pure parsing; verification lives in lib/notation.ts) ---------------

export interface NotationJws {
  /** base64url segments exactly as signed. */
  protectedB64: string;
  payloadB64: string;
  signatureB64: string;
  protected: {
    alg?: string;
    cty?: string;
    crit?: string[];
    signingScheme?: string;
    signingTime?: string;
    authenticSigningTime?: string;
    expiry?: string;
  };
  /** targetArtifact of the payload. */
  target: { mediaType?: string; digest?: string; size?: number } | null;
  /** Certificate chain, leaf first (base64 DER). */
  x5c: string[];
  signingAgent: string | null;
}

function b64urlToUtf8(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return typeof atob === "function" ? decodeURIComponent(escape(atob(b64))) : Buffer.from(b64, "base64").toString("utf8");
}

/** Read a Notation JWS JSON serialization; null when it is not one. */
export function parseNotationJws(value: unknown): NotationJws | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.protected !== "string" || typeof o.payload !== "string" || typeof o.signature !== "string") return null;
  let prot: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    prot = JSON.parse(b64urlToUtf8(o.protected)) as Record<string, unknown>;
    payload = JSON.parse(b64urlToUtf8(o.payload)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const header = (o.header ?? {}) as Record<string, unknown>;
  const x5c = Array.isArray(header.x5c) ? header.x5c.filter((c): c is string => typeof c === "string") : [];
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    protectedB64: o.protected,
    payloadB64: o.payload,
    signatureB64: o.signature,
    protected: {
      alg: str(prot.alg),
      cty: str(prot.cty),
      crit: Array.isArray(prot.crit) ? prot.crit.filter((c): c is string => typeof c === "string") : undefined,
      signingScheme: str(prot["io.cncf.notary.signingScheme"]),
      signingTime: str(prot["io.cncf.notary.signingTime"]),
      authenticSigningTime: str(prot["io.cncf.notary.authenticSigningTime"]),
      expiry: str(prot["io.cncf.notary.expiry"]),
    },
    target: payload.targetArtifact && typeof payload.targetArtifact === "object" ? (payload.targetArtifact as NotationJws["target"]) : null,
    x5c,
    signingAgent: str(header["io.cncf.notary.signingAgent"]) ?? null,
  };
}
