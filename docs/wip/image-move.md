# Move or copy a single image

Working notes for the `image-move` branch. Part (a) is ready to fold into
`README.md`, part (b) into `ARCHITECTURE.md`.

---

## (a) README-ready

### Moving or copying one image

A whole repository can be transferred between organizations
(**Repository → Settings → Danger zone → Transfer**). To promote or lift a
**single tag** — `staging/app:sha-abc` → `prod/app:1.2.3`, or
`library/dubcall:0.7.1` → `ruohki/dubcall:0.7.1` — open the tag page and press
**Move or copy**.

The modal asks for four things:

| Field | Meaning |
| --- | --- |
| **What should happen** | **Copy** keeps the source tag; **Move** deletes it once the destination has the image. |
| **Destination organization** | Only organizations you may push to. Instance administrators see all of them. Proxy caches are never listed. |
| **Destination repository** | An existing repository of that organization, or **New repository…** and a name. |
| **Destination tag** | Defaults to the source tag. |

Nothing is re-uploaded. Layers are content-addressed and already stored, so the
copy links them into the destination with the OCI cross-repository blob mount
and replays the manifests. The destination therefore serves the **identical
digest** — `docker pull` of either reference gives you byte-for-byte the same
image — and the copy takes about as long as a few HTTP round trips no matter how
large the image is.

What travels with the image:

- **Multi-architecture images.** An index brings every platform variant; all of
  them are pullable from the destination.
- **Attached artifacts.** Cosign signatures, in-toto attestations and SBOMs —
  found through the referrers API (`subject`) or cosign's
  `sha256-<hex>.sig` / `.att` / `.sbom` tag convention — are copied too, under
  the same tag names. The destination re-verifies them against its own trusted
  keys.

What does **not** travel: pull counts, scan results (the destination is
re-scanned on arrival), tag rules, retention policies and webhooks. They belong
to the repository, not to the image.

### Permissions and limits

- You need **push access on both sides** (`member`, `admin` or `owner`;
  instance administrators may do anything). A viewer sees no **Move or copy**
  button, and the organization picker only lists organizations you can push to.
- Neither side may be a **proxy cache**: its images belong to the upstream.
- A destination repository that does not exist yet is created with the
  organization's **default visibility**, after its repository quota is checked —
  exactly like pressing *New repository*.
- **Storage quota**: only bytes that are *new to the destination organization*
  are charged. Copying an image whose layers the organization already holds
  somewhere costs nothing.
- **Tag rules**: an immutable destination tag that already points at a
  *different* image is refused (re-copying the same digest onto it is fine); a
  protected source tag cannot be **moved** away, only copied.

### After a move

The source tag is deleted through the normal tag-removal path, so `latest`
follows the newest remaining image if it pointed at the one you moved. If the
move leaves the source manifest with no tags at all, it simply stays untagged in
the source repository; retention policies and the prune job clean it up later.
Its layers are never deleted while the copy references them.

Both outcomes are written to the audit log as `image.copy` / `image.move` in
**both** organizations, with the source and destination references, the digest,
how many layers were linked and how many bytes the destination gained. The push
into the destination and the delete in the source are ordinary registry
operations, so they also appear in the repository's event log and fire its
webhooks (`push` / `delete`) and a vulnerability scan.

---

## (b) ARCHITECTURE-ready

### Where it lives

| File | Role |
| --- | --- |
| `web/src/app/actions/images.ts` | Server actions `moveImage` and `listDestinationRepositories`. All rules are enforced here. |
| `web/src/lib/image-move.ts` | The copy engine: `planImageCopy`, `executeImageCopy`, `tagDigest`. |
| `web/src/lib/image-move-shared.ts` | Pure helpers shared with the client: `tagNameProblem`, `TAG_NAME_RE`, `pullPath`, `pullReference`, `ImageMoveMode`. |
| `web/src/lib/storage-accounting.ts` | `repositoryBytesNewToOrg` (was `bytesNewToOrg` inside `repo-tools.ts`) and `blobBytesNewToOrg`. |
| `web/src/app/(app)/[org]/[repo]/tags/[tag]/move-image.tsx` | The `MoveImageButton` client component and its modal. |
| `web/src/app/(app)/[org]/[repo]/tags/[tag]/page.tsx` | Renders the button and computes the destination organizations. |
| `registryd/internal/api/uploads.go` | `splitMountSource`: cross-repo mount sources may now be top-level (library) names. |

No schema change. No new environment variable, endpoint, job or npm
dependency.

### How a copy runs

1. **Plan** (`planImageCopy`, reads Postgres only). Depth-first walk from the
   source manifest digest over the `manifests` table: an index's children are
   visited before the index itself, so the push order satisfies registryd's
   "child manifest must already exist" check. Config and layer digests are
   collected on the way (foreign / non-distributable layers are skipped).
   `discoverArtifacts` (`lib/signatures.ts`) then adds everything attached to
   any of the image digests; each artifact manifest is walked the same way and
   remembers the cosign tag it was found under.
   The plan is `{ rootDigest, manifests[], blobs[], imageDigests[], artifactCount }`.
   Manifest bytes come from `manifests.payload` — the exact bytes as pushed — so
   the digest is preserved and a source blocked by the pull policy can still be
   promoted.

2. **Rules** (`moveImage`). Write access on both sides via `getOrgRole` +
   `WRITER_ROLES`; neither organization may have an `organization_proxies` row;
   `repoNameProblem` (the helper the create/rename paths use) and
   `tagNameProblem` (registryd's `tagRe`) validate the destination; an immutable
   destination tag pointing at another digest and a protected source tag under
   *move* are refused with a message that names the rule pattern.

3. **Quota**. `blobBytesNewToOrg(plan.blobs, destOrgId)` sums the blobs the
   destination organization does not hold *anywhere* yet; that number goes into
   `checkStorageQuota`. A new destination repository additionally passes
   `checkRepoQuota` and is created with `resolveDefaultVisibility`, with a
   `repo.create` audit row and the redirect for that name cleared — the same
   sequence as `createRepository`.

4. **Execute** (`executeImageCopy`). One ES256 token
   (`signRegistryToken`, subject `user:<id>`) carrying two grants —
   `pull` on the source path, `pull,push` on the destination path — is used for
   everything:
   - each blob: `POST /v2/<dest>/blobs/uploads/?mount=<digest>&from=<sourcePath>`.
     `201` means the blob was linked with no upload. `202` means registryd fell
     through to a normal upload session, and the engine streams the blob from the
     source through `openBlobStream` + `LocalPusher.putBlob` (`lib/mirror.ts`)
     so the copy still completes.
   - each manifest in plan order: `PUT /v2/<dest>/manifests/<ref>`, where `<ref>`
     is the destination tag for the image itself, the cosign tag for an artifact
     that had one, and the digest for everything else.

   Because this is an ordinary authenticated push, registryd applies its own
   manifest validation, storage and repository quotas, the immutable-tag guard
   (`CheckTagImmutable` / `UpsertTagGuarded`), writes `events` rows and notifies
   the web app, which caches image configs, dispatches repository webhooks,
   verifies signatures and queues scans. The feature emits no registry events of
   its own.

5. **Move only**. `deleteTag` (`lib/tag-admin.ts`) removes the source tag; it
   refuses protected tags and re-points `latest` at the newest remaining image.
   An untagged source manifest is left for retention / prune.

6. **Afterwards**. `refreshRepositoryBlocks(destinationRepositoryId)` recomputes
   the destination's vulnerability and signature blocks, `checkQuotaWarnings`
   runs for the destination organization, and two `image.copy` / `image.move`
   audit rows are written (source organization and, when different, destination
   organization) with
   `{mode, from, to, digest, manifests, artifacts, layersLinked, layersUploaded, bytesAdded, repositoryCreated}`.

### registryd change

`tryMount` previously required the `?from=` name to contain exactly one slash,
so a top-level (library) repository could never be a mount source — a copy out
of `library/*` would have had to re-upload every layer. `splitMountSource` now
resolves the name the way `routeV2` does: no slash → the `library` organization,
one slash → `<org>/<repo>`, deeper → not mountable (those only exist in proxy
caches, which this feature refuses anyway). Covered by
`registryd/internal/api/uploads_test.go`.

### Notes and limits

- Only a **tag** can be moved. A tag page opened by digest (an index child)
  offers **Copy** only, with the *Move* option disabled and the reason shown.
- A copy is not transactional. If a manifest push fails after some blobs were
  mounted, the destination keeps those links; they cost no storage (the content
  is shared) and garbage collection reclaims anything that ends up unreferenced.
- The destination is not made public: a new repository follows the
  organization's default visibility, an existing one keeps its own.
