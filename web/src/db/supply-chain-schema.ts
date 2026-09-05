// Supply chain: trusted cosign keys, signature verification results and the
// cached classification of artifacts attached to images (referrers and
// cosign tag-convention manifests). Written and read by the web app only;
// registryd enforces the outcome through manifest_blocks (registry-schema).
import { sql } from "drizzle-orm";
import { foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";
import { manifests, repositories } from "./registry-schema";

/**
 * Public keys an organization (or one repository) trusts for cosign
 * signatures. Anything Node's crypto.createPublicKey accepts: ECDSA P-256 /
 * P-384 / P-521, Ed25519, RSA. The fingerprint is sha256 over the DER SPKI —
 * the same value Sigstore bundles carry (base64) as the key hint.
 */
export const signingKeysTrusted = pgTable(
  "signing_keys_trusted",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** null = trusted for every repository of the organization. */
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    publicKeyPem: text("public_key_pem").notNull(),
    /** sha256 hex of the DER-encoded SubjectPublicKeyInfo. */
    fingerprint: text("fingerprint").notNull(),
    /** Human-readable algorithm, e.g. "ECDSA P-256", "Ed25519", "RSA 3072". */
    keyType: text("key_type").notNull().default(""),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("signing_keys_trusted_org_idx").on(t.organizationId), index("signing_keys_trusted_repo_idx").on(t.repositoryId)],
);

/**
 * Personal signing keys, registered by a user under Settings → Signing keys.
 * A signature made with one counts as verified in every repository the
 * owner may push to (writer role in the organization, or instance admin)
 * as long as the organization trusts members' keys
 * (organization_settings.trust_member_keys). The fingerprint is unique
 * across users so a key has exactly one owner to attribute signatures to.
 */
export const userSigningKeys = pgTable(
  "user_signing_keys",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    publicKeyPem: text("public_key_pem").notNull(),
    /** sha256 hex of the DER-encoded SubjectPublicKeyInfo. */
    fingerprint: text("fingerprint").notNull().unique(),
    keyType: text("key_type").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("user_signing_keys_user_idx").on(t.userId)],
);

/**
 * Keyless (Sigstore) identities an organization (or one repository) trusts:
 * the OIDC issuer of the Fulcio certificate plus the subject it names —
 * an email, or the workflow URI of a CI system, with `*` wildcards. A
 * keyless signature counts as verified only when its certificate chains to
 * the Sigstore root, its Rekor entry checks out and the identity matches
 * one of these rows (lib/sigstore.ts, lib/signatures.ts).
 */
export const signingIdentitiesTrusted = pgTable(
  "signing_identities_trusted",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** null = trusted for every repository of the organization. */
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** OIDC issuer URL exactly as Fulcio recorded it, e.g. https://token.actions.githubusercontent.com */
    issuer: text("issuer").notNull(),
    /** Subject pattern: exact value or glob with `*`, e.g. https://github.com/acme/app/.github/workflows/release.yml@refs/tags/* */
    subject: text("subject").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("signing_identities_trusted_org_idx").on(t.organizationId),
    index("signing_identities_trusted_repo_idx").on(t.repositoryId),
  ],
);

export const SIGNATURE_STATUSES = ["verified", "untrusted", "invalid", "keyless"] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];

/**
 * Outcome of checking one signature-bearing artifact (a cosign `.sig`
 * manifest, a Sigstore bundle referrer, a DSSE attestation) against the
 * trusted keys in scope. `kind` separates image signatures — the only rows
 * the "require signatures" pull policy counts — from signed attestations.
 * Recomputed on push, when trusted keys change, and on demand.
 */
export const manifestSignatures = pgTable(
  "manifest_signatures",
  {
    repositoryId: text("repository_id").notNull(),
    /** The image (subject) the signature is about. */
    manifestDigest: text("manifest_digest").notNull(),
    /** The signature / attestation manifest itself. */
    signatureDigest: text("signature_digest").notNull(),
    kind: text("kind", { enum: ["signature", "attestation"] }).notNull().default("signature"),
    status: text("status", { enum: SIGNATURE_STATUSES }).notNull(),
    /** The trusted key that verified it (null unless status = verified). */
    keyId: text("key_id").references(() => signingKeysTrusted.id, { onDelete: "set null" }),
    /** The member's personal key that verified it instead (null unless status = verified through one). */
    userKeyId: text("user_key_id").references(() => userSigningKeys.id, { onDelete: "set null" }),
    /** The trusted keyless identity that verified it (null unless status = verified through one). */
    identityId: text("identity_id").references(() => signingIdentitiesTrusted.id, { onDelete: "set null" }),
    /** Certificate identity of a keyless signature, e.g. "user@example.com (https://accounts.google.com)". */
    identity: text("identity"),
    /** Per-signature detail (format, key fingerprint, reason, signed reference); see lib/signatures-shared.ts SignatureCheck. */
    details: jsonb("details"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.manifestDigest, t.signatureDigest] }),
    foreignKey({
      columns: [t.repositoryId, t.signatureDigest],
      foreignColumns: [manifests.repositoryId, manifests.digest],
      name: "manifest_signatures_signature_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.repositoryId, t.manifestDigest],
      foreignColumns: [manifests.repositoryId, manifests.digest],
      name: "manifest_signatures_subject_fk",
    }).onDelete("cascade"),
    index("manifest_signatures_subject_idx").on(t.repositoryId, t.manifestDigest, t.status),
  ],
);

/**
 * Cached classification and parsed summary of an artifact manifest (what
 * kind it is, and for SBOMs / provenance the parsed numbers). Content
 * addressed, so a row never goes stale; it disappears with the manifest.
 */
export const manifestArtifacts = pgTable(
  "manifest_artifacts",
  {
    repositoryId: text("repository_id").notNull(),
    /** The artifact manifest. */
    digest: text("digest").notNull(),
    /** The image it is attached to. */
    subjectDigest: text("subject_digest").notNull(),
    kind: text("kind", { enum: ["signature", "attestation", "sbom", "other"] }).notNull(),
    /** provenance | spdx | cyclonedx | vuln | cosign-sign | custom, when known. */
    subkind: text("subkind"),
    /** cosign-legacy | sigstore-bundle | dsse | raw | unknown */
    format: text("format").notNull().default("unknown"),
    /** Parsed summary; shape depends on kind (lib/signatures-shared.ts ArtifactSummary). */
    summary: jsonb("summary"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.digest] }),
    foreignKey({
      columns: [t.repositoryId, t.digest],
      foreignColumns: [manifests.repositoryId, manifests.digest],
      name: "manifest_artifacts_manifest_fk",
    }).onDelete("cascade"),
    index("manifest_artifacts_subject_idx").on(t.repositoryId, t.subjectDigest),
  ],
);
