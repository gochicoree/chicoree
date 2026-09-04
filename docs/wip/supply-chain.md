# Supply chain: signatures, attestations, SBOMs and a signature pull policy

Work-in-progress notes for the `supply-chain` feature set. Section (a) is
README-ready user documentation, section (b) holds the ARCHITECTURE notes.

## (a) README sections

### Signatures, SBOMs and provenance

Every tag page has an **Attestations** tab that lists what is attached to
the image: cosign signatures, SBOMs (SPDX / CycloneDX), SLSA provenance and
any other OCI referrer. Chicorée reads both ways of attaching artifacts:

- the **OCI referrers API** (`subject` in the manifest — what cosign v3,
  `oras attach` and `cosign … --registry-referrers-mode=oci-1-1` push);
- cosign's **tag convention**: `sha256-<digest>.sig`, `.att` and `.sbom`
  tags in the same repository (cosign v2, `cosign attach signature|sbom`).

For a multi-arch image the tab shows what is attached to the index and to
each platform variant (`cosign sign --recursive` signs all of them).

Signing and attesting with cosign v3 (the registry has no TLS in this
example, hence `--allow-http-registry`; drop it for a real deployment):

```sh
cosign generate-key-pair                             # cosign.key / cosign.pub
IMAGE=cr.example.com/acme/app@sha256:…               # always sign by digest

# signature (stored as a Sigstore bundle through the referrers API)
cosign sign --key cosign.key --use-signing-config=false --tlog-upload=false \
  --registry-username you@example.com --registry-password "$PAT" \
  --allow-http-registry --allow-insecure-registry "$IMAGE"

# SBOM and provenance as in-toto attestations
cosign attest --key cosign.key --use-signing-config=false --tlog-upload=false \
  --type spdxjson --predicate sbom.spdx.json "$IMAGE"
cosign attest --key cosign.key --use-signing-config=false --tlog-upload=false \
  --type slsaprovenance1 --predicate provenance.json "$IMAGE"

# plain SBOM under the sha256-….sbom tag
cosign attach sbom --sbom sbom.cdx.json --type cyclonedx "$IMAGE"

# any other artifact through the referrers API
oras attach --artifact-type application/spdx+json "$IMAGE" sbom.spdx.json:application/spdx+json

# and cosign's own verification works against the registry
cosign verify --key cosign.pub --insecure-ignore-tlog=true "$IMAGE"
cosign verify-attestation --key cosign.pub --type spdxjson --insecure-ignore-tlog=true "$IMAGE"
```

The tab shows, per signature, its format (Sigstore bundle, classic cosign
signature, DSSE envelope), how it was found (referrer or tag), the payload
digest and the **verification status** against the trusted keys:

| Status | Meaning |
| --- | --- |
| *verified by key `<name>`* | the signature verifies with a trusted key in scope and names this image and repository |
| *unverified: no trusted key* | well-formed, but no trusted key verifies it |
| *invalid: …* | the payload names another image or repository, the bundle points at a trusted key that does not verify it, or the signature is malformed |
| *keyless (identity), not verified* | signed with a Fulcio certificate; the certificate identity and OIDC issuer are shown, but the Fulcio/Rekor chain is **not** verified by the registry |

SBOM cards show the format, the package count, the first components and
who generated the document; **Download SBOM** hands out the document
itself (for attested SBOMs the predicate of the in-toto statement; *raw
envelope* gives the DSSE/bundle bytes). The provenance card summarises the
SLSA predicate (v1 and v0.2): builder, build type, source repository and
commit, entry point, invocation, build times, dependencies and parameters.
Attestations are verified with the same trusted keys and carry their own
status. Images with a verified signature get a **signed** shield in the
repository's tag list and on the tag page. **Re-verify** (members and up)
re-checks everything attached to the image.

### Trusted signing keys

*Organization → Settings → Policies* and *Repository → Settings → Policies*
have a **Trusted signing keys** card. Paste the PEM of a `cosign.pub`
(ECDSA P-256 / P-384 / P-521, Ed25519 or RSA ≥ 2048) with a name; the card
lists name, fingerprint (sha256 of the DER public key — the same value
Sigstore bundles carry as the key hint), type and scope. Organization keys
apply to every repository; repository keys add to them (shown read-only as
*inherited* on repository pages). Adding or removing a key re-verifies every
signature in scope right away. Owners and admins manage keys; at most 50
per scope.

### Require signatures (pull policy)

The **Require signatures** card on the same pages refuses pulls of images
that carry no cosign signature verified by a trusted key. The organization
switch applies everywhere; a repository can inherit it, require signatures,
or opt out. `docker pull` then answers:

```
denied: pull blocked by policy: no signature from a trusted key (signature policy)
```

Rules: attached artifacts (signatures, attestations, SBOMs, anything with
a `subject` or under a cosign tag) are never blocked; a signed multi-arch
index covers its platform variants; a vulnerability block and a signature
block can apply to the same image — the reason lists both. The policy
targets **consumers**: credentials that can only pull (viewers, pull
service accounts, read-only access tokens, anonymous pulls of public
repositories) get the 403. Whoever may push to the repository (owners,
admins, members, push service accounts, read & write tokens) can still read
an image blocked only by the signature policy — they are the ones who sign
it, and `cosign sign` has to fetch the manifest before it can attach the
signature. The vulnerability policy has no such exemption. While the
policy is on, blocks are recomputed on every push (pushing an image first
and its signature a few seconds later is fine: the image is blocked only in
between), and always when trusted keys change, when the policy changes and
on *Re-verify*. With no trusted
key in scope the policy blocks every image, which the card points out.
The tag page shows the block notice with the policy that caused it.

New notification / webhook event **`signature.blocked`** (organization
owners and admins; on by default): sent when a policy or key change blocks
images — not for the brief window between an image push and its signature.

## (b) ARCHITECTURE notes

### Tables (`web/src/db/supply-chain-schema.ts`, columns in `registry-schema.ts`)

- `manifest_blocks.pushers_exempt boolean NOT NULL DEFAULT false` — set by
  the web app for blocks caused by the signature policy alone; registryd
  (`store.ManifestBlock` → `ManifestBlockRow`, `api.blockApplies`, tests in
  `blocks_test.go`) lets a token whose `access` grants `push` on the
  repository through such a block (`identity.Can("repository", name,
  "push")`). Because cosign — like every go-containerregistry client — reads
  with a pull-only scope before it pushes the signature, the token endpoint
  (`api/registry/token/route.ts`) adds `push` to a repository grant whenever
  the caller asked for `pull` only but is allowed to push; that is the only
  behaviour keyed on it. A combined vulnerability + signature block is never
  exempt.
- `organization_settings.require_signature boolean NOT NULL DEFAULT false`;
  `repositories.require_signature boolean` (NULL = inherit, true/false =
  override). registryd does not read either — it only enforces
  `manifest_blocks`.
- `signing_keys_trusted` (id, organization_id NOT NULL, repository_id NULL =
  whole organization, name, public_key_pem (normalised SPKI PEM),
  fingerprint (sha256 hex of the DER SPKI), key_type ("ECDSA P-256"…),
  created_by, created_at); indexes on organization_id and repository_id.
- `manifest_signatures` (repository_id, manifest_digest = the image,
  signature_digest = the artifact manifest, kind `signature` | `attestation`,
  status `verified` | `untrusted` | `invalid` | `keyless`, key_id → trusted
  key (SET NULL), identity, details jsonb = `SignatureCheck[]` (per
  signature: format, key fingerprint / hint, signed reference and digest,
  reason, keyless identity + issuer), checked_at). PK (repository_id,
  manifest_digest, signature_digest); FKs to `manifests` on both digests
  (cascade), index (repository_id, manifest_digest, status). Only rows with
  `kind = 'signature'` count for the policy; attested SBOMs / provenance are
  `attestation` rows (their DSSE signature is verified with the same keys).
- `manifest_artifacts` (repository_id, digest, subject_digest, kind
  `signature` | `attestation` | `sbom` | `other`, subkind `provenance` |
  `spdx` | `cyclonedx` | `vuln` | `cosign-sign` | `custom`, format
  `cosign-legacy` | `sigstore-bundle` | `dsse` | `raw` | `unknown`, summary
  jsonb = `ArtifactSummary`, computed_at) — the cached classification and
  parsed summary (SBOM package count and preview, provenance fields).
  Content-addressed, so never stale; cascades with the manifest; a summary
  computed while the blob was unreachable is not cached.

No custom migration SQL: two new tables, three new nullable/defaulted columns.

### registryd

- `GET /v2/<name>/referrers/<digest>` now includes each referrer's
  `annotations` in the descriptors (the spec requires it; cosign v3 reads
  `dev.sigstore.bundle.content` / `predicateType` from the list to tell
  signatures from attestations). `store.ListReferrers` selects
  `(payload::jsonb)->'annotations'`, `store.ParseAnnotations` decodes it,
  `api.referrerDescriptors` copies it (tests in `lists_test.go`).
- The manifest block message is now `pull blocked by policy: <reason>`
  (was `… by vulnerability policy: …`); the reason text names the policy
  (vulnerability reasons end in `policy blocks <level>`, signature reasons
  in `(signature policy)`).

### Web app

- `lib/signatures-shared.ts` (browser-safe): media-type constants,
  `classifyArtifact` (descriptor → kind/subkind/format/predicateType),
  `predicateSubkind`, `looksLikeArtifact` (subject, cosign tag,
  artifact-only layers or the empty config), cosign tag helpers
  (`cosignArtifactTag`, `parseCosignTag`), parsers (`parseSimpleSigning`,
  `parseInTotoStatement`, `statementCoversDigest`,
  `referenceMatchesRepository` — host ignored, tag/digest stripped),
  summaries (`summarizeSbom` for SPDX 2.x and CycloneDX JSON,
  `summarizeProvenance` for SLSA v1 and v0.2), the `SignatureCheck` /
  `ArtifactSummary` types, status wording and `SIGNATURE_BLOCK_REASON`.
- `lib/signatures.ts` (server):
  - keys: `parsePublicKey` (Node `createPublicKey`; ECDSA / Ed25519 / Ed448
    / RSA ≥ 2048; fingerprint = sha256 of the DER SPKI), `listTrustedKeys`,
    `effectiveTrustedKeys` (repository + organization), `addTrustedKey`,
    `removeTrustedKey`.
  - crypto: `verifyWithKey` (ECDSA sha256 with sha384/sha512 fallbacks for
    P-384/P-521, DER and IEEE-P1363 encodings; Ed25519 pure; RSA PKCS#1
    v1.5 and PSS), `dssePreAuthEncoding`, `certificateIdentity` (SAN plus
    the Fulcio issuer extensions 1.3.6.1.4.1.57264.1.8 / .1.1 through a
    small DER walk over the certificate).
  - discovery: `discoverArtifacts(repoId, subjects)` = manifests whose
    `subject_digest` is one of the subjects ∪ manifests under
    `sha256-<hex>.sig|att|sbom` tags; `artifactSubjects(repoId)`.
  - `artifactSummary` (cached in `manifest_artifacts`; loads the first
    layer blob through registryd with a system pull token, ≤ 16 MiB, once
    per operation via `makeBlobLoader`).
  - `checkArtifactSignatures`: cosign legacy layers (simple-signing payload
    must name this digest and this repository; signature annotation
    verified over the raw payload), Sigstore bundles (`dsseEnvelope`:
    statement subject must cover the digest, PAE verified; or
    `messageSignature` over the subject manifest bytes; a key hint that
    matches a trusted key which fails to verify → *invalid*), DSSE
    envelopes (`.att`). Keyless certificates (layer annotation or bundle
    verification material) yield status `keyless` with identity + issuer.
  - `verifyManifestSignatures(repo, digest)` upserts / prunes the rows of one
    image; `reverifyRepository`, `reverifyOrganization`;
    `onManifestPushed(path, digest, tag)` (called from
    `api/internal/events/route.ts` on `manifest.push`): an artifact
    re-verifies its subject, an image is checked for existing artifacts;
    when `effectiveSignaturePolicy` is on for the repository both refresh
    its blocks with `{ quiet: true }` (otherwise the scan pipeline keeps
    owning `manifest_blocks`, as before).
  - `getAttestationView` builds the tab (subjects = digest + index
    children; rows missing for signed artifacts are computed on first
    view), `resolveArtifactDownload` + `extractPredicate` back the download
    route.
- `lib/pull-policy.ts`: `refreshRepositoryBlocks(repositoryId, { quiet })`
  now also computes signature blocks when
  `effectiveSignaturePolicy(org, repo)` (in `pull-policy-shared.ts`) is on:
  every manifest that is not an artifact (`looksLikeArtifact` with its
  tags, layers and config media type), has no `manifest_signatures` row
  with `kind = signature, status = verified`, and is not a child of a
  verified index gets `no signature from a trusted key (signature policy)`;
  merged with the vulnerability reason as `<vuln>; <signature>`. Newly
  blocked digests notify `scan.blocked` (vulnerability) or
  `signature.blocked` (signature only, skipped when quiet).
- `lib/registry-client.ts`: `fetchBlobBytes(path, digest, maxBytes)` and
  `openBlobStream(path, digest)`.
- Notifications / webhooks: `signature.blocked` in `notify-shared.ts`
  (organization scope, email on by default), `webhooks-shared.ts`
  (`WEBHOOK_EVENTS`) and `notify.ts` (email template + one
  `emitRepositoryEvent` per image with `tag`, `tags`, `image { digest,
  reference, url }`, `reason`).
- Route `GET /api/artifacts/<repository id>/<artifact digest>[?raw=1]`:
  repository read access (public, or any organization role; instance
  admins act as owners); serves the predicate JSON of a DSSE envelope /
  bundle (`<repo>-<digest12>.spdx.json`, `.cdx.json`, `.provenance.json`,
  `.attestation.json`), or with `raw=1` — and for plain artifacts such as
  `.sbom` tags — streams the first layer blob byte for byte with its media
  type.
- Server actions: `app/actions/signing-keys.ts` (`addTrustedKeyAction`,
  `removeTrustedKeyAction` — MANAGER_ROLES, audit `signing_key.add` /
  `signing_key.remove`, then `reverifyRepository` / `reverifyOrganization`;
  `reverifyManifestAction` — WRITER_ROLES, index children included, audit
  `signature.reverify`), `app/actions/signature-policy.ts`
  (`setOrgSignaturePolicy`, `setRepoSignaturePolicy` — MANAGER_ROLES, audit
  `policy.update` with `requireSignature`, blocks refreshed).
- UI: `components/attestations-panel.tsx` (server component: status
  badges, signatures list, SBOM / provenance cards, other referrers table,
  empty state with the cosign / oras commands for the exact digest
  reference), `components/reverify-button.tsx`,
  `components/trusted-keys-manager.tsx`,
  `components/signature-policy-form.tsx`; the tag page adds the
  **Attestations** tab (index pages: a *Signatures & SBOMs* card under the
  variants), a *signed* badge and a policy-aware block notice; the
  repository tag list gets the shield from `listRepoTags().signed` (one
  `EXISTS` on `manifest_signatures`); both Policies pages add the two cards.

### Verification notes

- Unit (`npx tsx`, 58 checks): classification of every artifact shape
  cosign v3 produces (bundle sign / SPDX / SLSA referrers, legacy `.sig`,
  `cosign attach sbom`), parsers and summaries on fixtures, key parsing
  (P-256 fingerprint equals the bundle's hint; Ed25519 / RSA accepted; RSA
  1024 and garbage rejected), `verifyWithKey` for Ed25519 / RSA / P-384,
  Fulcio certificate identity + issuer, and `checkArtifactSignatures`:
  right key → verified, wrong key → untrusted, digest mismatch →
  invalid, wrong repository → invalid, corrupt signature → untrusted,
  hinted-but-failing key → invalid, keyless → identity.
- E2E against a local stack with cosign v3.1.3: see the report.
