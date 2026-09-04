# Repository tools: tag comparison, shared layers, rename & transfer

Work-in-progress notes for the `repo-tools` feature set. Section (a) is
README-ready user documentation, section (b) holds the ARCHITECTURE notes.

## (a) README sections

### Comparing two tags

Every repository has a compare page: pick two references in the **Compare**
picker above the tag list (or press **Compare** on a tag page and choose the
other side there). The URL is shareable:
`/<org>/<repo>/compare?from=<tag|digest>&to=<tag|digest>[&platform=linux/arm64]`.

The page shows a **summary** (digests, platform, size and layer count of both
images, when they were pushed and built, and the size / layer / config /
findings deltas) and four sections:

- **Layers** — the layer sequence of the new image with the old image's
  material interleaved: `+` layers only in the new image, `−` layers only in
  the old one, `=` shared layers, each with the Dockerfile instruction
  reconstructed from the image config history, its digest and size. Layers
  are matched by digest, so a rebuilt layer with identical content counts as
  unchanged.
- **Config** — entrypoint, command, user, working directory, exposed ports,
  volumes, stop signal, platform, every environment variable and every
  label, side by side; differences are highlighted (old value in red, new in
  green, *not set* where a side lacks the key).
- **Vulnerabilities** (when scanning is configured) — findings that are
  **new** in the target image, findings **fixed** since the source image, and
  the unchanged ones folded away. A finding is the pair *vulnerability id +
  package*, so a CVE that moved from one package to another shows up as
  fixed and new. Both images need a finished scan.
- **Annotations** — OCI annotations of the two manifests (index annotations
  included), same layout as the config section.

For multi-arch images the comparison runs on one platform: the first
platform both indexes offer is chosen and a **Platform** dropdown switches to
another. When the two images share no platform the page says so and
compares the first variant of each.

### Shared layers and storage

On a tag page, the **Layers** tab has a **Shared** column: *unique* when no
other image references the layer, otherwise *shared ×N*. Clicking it lists
the other images (`org/repo:tag`, or the digest for untagged manifests) —
only those you may see; layers also used by private repositories you cannot
access are counted as *+N private* and never named.

The repository header carries a **Storage** line: the *logical* size (every
tag counted on its own), the *stored* size (distinct layers, deduplicated)
and how much of that is shared with other repositories of the registry.

### Renaming and moving repositories

*Repository → Settings → Danger zone* offers, for owners and admins:

- **Rename** — the repository gets a new name inside its organization.
- **Move to another organization** — pick any organization you are an
  owner or admin of (instance administrators see them all). The target's
  repository and storage quotas are checked first; layers the target
  organization already holds are not counted again. Repository-scoped tag
  rules, retention policy, webhooks, mirrors and scan results move with the
  repository; organization-wide rules, retention defaults, webhooks and the
  pull policy of the old organization stop applying and those of the new one
  take over (the pull policy is re-evaluated right after the move).
  Members of the old organization lose access unless the repository is
  public; service accounts restricted to the repository lose it.

Both show a confirmation that lists the consequences and the new
`docker pull` reference. Afterwards the **old name keeps working for pulls**:
`docker pull`, tag lists, referrers and blob downloads of the former
`<org>/<name>` are served from the new location, and the old web address
answers a permanent redirect. Pushes and deletes against the old name are
refused so nothing lands in a stale place:

```
denied: repository moved to acme/alpine2; push to the new name (create a repository with the old name in the web UI to reuse it)
```

Repositories in proxy-cache organizations cannot be renamed or moved (their
names are the upstream paths).

### Renaming an organization

*Organization → Settings → Danger zone → Change the organization slug*
(owners only; `library` cannot be renamed). The slug is the image
namespace, so `<registry>/<old-slug>/<repo>` keeps working for pulls and
every web address under `/<old-slug>` redirects to the new one; pushes to
the old namespace are refused with the new name. Members, repositories,
service accounts, webhooks, rules and policies are unchanged. Update CI
pipelines that push.

### Reusing old names

An old name stays reserved for the redirect until somebody creates a
repository (or organization) with it: creating one through the web UI ends
the redirect and the new repository is served under that name from then on.
The Danger zone lists the former names still redirecting to a repository or
organization. Registry pushes never re-create a redirected name.

*Webhooks* gained two events: **Repository renamed** and **Repository
transferred** (payload: the usual repository block for the new name plus
`previous: { organization, name, path }` and the acting user).

*Audit log* actions: `repo.rename` (`from`, `to`), `repo.transfer` (recorded
in both organizations with `from`, `to`, `fromOrganizationId`,
`toOrganizationId`, `visibility`, `bytesAdded`) and `org.rename` (`from`,
`to`).

## (b) ARCHITECTURE notes

### Tables (drizzle, `web/src/db/registry-schema.ts`; read by registryd)

- `repository_redirects` (id, `organization_slug` — the slug the
  repository lived under *at the time of the move*, `repository_name` — the
  former name, `repository_id` → repositories ON DELETE CASCADE,
  created_at, created_by). `UNIQUE (organization_slug, repository_name)`,
  index on repository_id. One row per former `<org>/<name>`.
- `organization_redirects` (`old_slug` PK, `organization_id` → organization
  ON DELETE CASCADE, created_at, created_by).

No custom migration SQL is needed; both tables are new and empty.

### Resolution order (identical in Go and TypeScript)

Given `<org>/<name>` that does not exist:

1. **Organization redirect first**: if `<org>` is a former slug, swap in the
   current slug and look the repository up there — a repository that exists
   under the new slug wins over any repository redirect.
2. **Repository redirects**: `<org>/<name>` under the requested slug, then
   under the organization's current slug, then under every former slug of
   the organization (so `gamma/alpine` finds the row written as
   `acme/alpine` when `acme` was renamed to `gamma` after the repository
   was). Targets are addressed by repository id, so a later rename of the
   target is followed.

`registryd/internal/store/redirects.go`: `RedirectTable` (snapshot of both
tables), `LoadRedirects`, `GetRepositoryByID`, the `RepoLookup` interface
and the pure `ResolveMoved(ctx, table, lookup, org, name)`.
`redirects_test.go` covers the order with a fake lookup; the DB-backed
`TestEnsureRepositoryClearsRedirects` runs with `REGISTRYD_TEST_DATABASE_URL`.

### registryd (`internal/api/redirects.go`)

- `redirectCache` loads both tables whole and caches them for 30 s (a
  failed reload keeps serving the previous snapshot). `Server.repoLookup`
  (the store, or a fake in tests) feeds resolution.
- `lookupRepoRead` (exact name, then redirect) replaces `GetRepository` in
  the read handlers: manifest GET/HEAD, tags list, referrers, blob GET/HEAD.
  The event, pull count and traffic land on the target repository; the
  response keeps the requested name (`tags/list` echoes it). A hit is logged
  as `redirect from=… to=…`.
- Writes never follow a redirect. `resolveRepoForWrite` (upload commit,
  mount, manifest PUT — i.e. the auto-create path) and the manifest / blob
  DELETE handlers answer `403 DENIED "repository moved to <org>/<name>;
  push to the new name (…)"` for a former name; `withAuthResolved` gives the
  same message when a token lacks push/delete on a name that is redirected
  (tokens for former names carry pull only, see below).
- `Store.EnsureRepository` deletes, in the same transaction as the insert,
  every `repository_redirects` row for that name under the organization's
  current or former slugs: a repository that takes a name over ends its
  redirect (the web app's create action does the same). The cache needs no
  invalidation because the exact name is always tried first.
- `internal/api/redirects_test.go`: httptest handler tests with a fake
  lookup (manifest PUT / manifest DELETE / blob DELETE against a former name
  → 403 with the message; unknown names stay 404; cache TTL and stale
  serving).

### Token endpoint

`api/registry/token/route.ts` calls `resolveRepositoryRedirect(org, name)`
(`lib/redirects.ts`) for every repository scope. When the name is a former
one, the requested actions are reduced to `pull` and authorized against the
**target** repository (visibility / membership of the new organization), so
a repository moved into a private organization is not reachable through its
old public name by someone without access there. Pushes requested on a
former name therefore get no grant; registryd turns that into the "moved"
message.

### Web app

- `lib/redirects.ts`: `resolveOrganizationRedirect`,
  `resolveRepositoryRedirect` (same order as Go; short-circuits when both
  tables are empty), `redirectMovedRepository` / `redirectMovedOrganization`
  (`permanentRedirect` → HTTP 308, else `notFound`), and the write helpers
  `addRepositoryRedirect`, `clearRepositoryRedirects`,
  `addOrganizationRedirect`, `clearOrganizationRedirect` (all accept a
  transaction handle), plus `listRepositoryRedirects` /
  `listOrganizationRedirects` for the settings pages.
- Redirect call sites: the repository page, tag page, compare page and the
  repository settings context (`/[org]/[repo]/…` → same sub-path under the
  new name) and the organization layout / organization settings context
  (`/[old-slug]/…` → same path under the new slug). Layouts cannot see the
  request URL, so `src/proxy.ts` (Next 16 proxy, page routes only) sets an
  `x-pathname` request header; nothing else happens there.
- `app/actions/repo-tools.ts`: `renameRepository` (managers; not in proxy
  organizations; `lib/repo-names-shared.ts` `repoNameProblem` — the reserved
  list gained `audit` and `compare`; uniqueness; transaction: rename, clear
  redirects for the new name, add the old one), `transferRepository`
  (managers of both organizations, target not a proxy, uniqueness,
  `checkRepoQuota` and `checkStorageQuota` with the bytes the target does
  not hold yet; transaction: move `repositories.organization_id`, re-home
  repository-scoped `tag_rules` / `retention_policies`, redirects; then
  `refreshRepositoryBlocks`, quota warnings, webhook), `renameOrganization`
  (owners; `library` excluded; slug regex + `RESERVED_SLUGS`, now exported
  from `lib/auth.ts`; `auth.api.updateOrganization`, direct row update for
  non-member instance admins; org redirect rows). Every action records
  audit rows and returns the new URL and pull reference for the client.
- `lib/auth.ts` `beforeCreateOrganization` clears an organization redirect
  for the new slug; `createRepository` clears repository redirects for the
  new name.
- UI: `settings/repo-tools-forms.tsx` (rename and transfer cards with
  consequence modals; transfer targets computed server-side in
  `settings/danger/page.tsx`), `(org)/settings/org-rename-form.tsx`.
- `lib/webhooks-shared.ts`: events `repository.renamed`,
  `repository.transferred`, emitted through `emitRepositoryEvent` after the
  move with `previous` and `actor`.

### Tag comparison

- `lib/compare-shared.ts` (pure): `layersWithInstructions` /
  `cleanCommand` (history → Dockerfile instructions; the tag page now uses
  it too), `diffLayers` (digest identity, two-pointer walk that keeps the
  "to" order, reorder-safe), `diffConfig` (scalar rows + env / labels keyed
  rows, `changed` flags), `diffAnnotations`, `normalizeFindings` (the
  adapter: a `findings` array column — several key spellings accepted —
  else the Clair report; deduplicated by id + package), `diffFindings`
  (new / fixed / unchanged with per-severity counts), `commonPlatforms`,
  `signedDelta`. `web/scripts/check-compare.ts` (`npx tsx
  scripts/check-compare.ts`) exercises all of it on hand-made fixtures.
- `lib/compare.ts`: `findingsOf(scanRow)` (delegates to the adapter) and
  `loadCompareSide(repo, ref, platform)` — resolves a tag or digest, picks
  the platform child of an index (attestation entries skipped), loads the
  cached config (or fetches it through the registry) and the scan row.
- `app/(app)/[org]/[repo]/compare/page.tsx` (+ `compare-bar.tsx`, the
  from/to/platform picker, also used in compact form in the tag list
  header). Both sides load in parallel; when one side is an index the first
  common platform is chosen and mismatching sides are reloaded once.

### Shared layers

- `lib/shared-layers.ts`: `sharedLayerRefs(repoId, digest, viewer)` — one
  query per manifest: every ref of the manifest joined with all other
  `manifest_refs` rows for the same digests, labelled `org/repo:tag`
  (untagged children take their index's tag, else `@digest`), with
  visibility computed in SQL (public, admin, or the viewer's member
  organizations) and aggregated to `total`, `hidden` and up to 25 visible
  labels per layer. `repositoryStorage(repoId)` — logical bytes (union of
  each tag's blobs, index children included), physical bytes (distinct
  linked blobs), bytes shared with other repositories and how many.
  `memberOrgIds(userId)`.
- `components/shared-layers.tsx` `SharedLayerBadge` (popover; `+N private`
  for hidden references). The tag page's layer table gained the column; the
  repository header the storage line.

### Env / compose

No new environment variables, services or Dockerfile changes.
`web/src/proxy.ts` is picked up by the existing build (standalone output).
