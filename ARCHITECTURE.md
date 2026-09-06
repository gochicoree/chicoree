# Chicorée architecture

Two services share one Postgres database and one contract: **registryd** (Go)
speaks the OCI Distribution Spec and moves bytes; the **web app** (Next.js)
owns identity, authorization and everything a human looks at.

```
                 docker / podman / oras / CI
                        │        ▲
              (1) 401 + │        │ (3) push/pull with
                  realm │        │     Bearer JWT
                        ▼        │
   browser ──────► web app ◄─────┼──────────── registryd ──► blob storage
      ▲            (Next.js)     │             (Go)          filesystem | S3 | bunny
      │               │ (2) authorize scopes,     │
      └───────────────┤     sign ES256 JWT        │
                      │                           │
                      │        Postgres           │
                      └──────► (shared) ◄─────────┘
                      │                           
                      └──► Clair v4 (indexer/matcher), fetches layers
                           back through registryd with a pull token —
                           or Trivy, run by the web app and pulling
                           through registryd with the same token

   registryd ──► upstream registries (Docker Hub, GHCR, Quay, …) on a cache
                 miss in a proxy-cache organization; stored like a push
   Prometheus ──► web app /api/metrics (computed from Postgres) and
                  registryd /metrics (process counters), one bearer token
```

## Token auth (Docker's standard flow)

1. A client hits `registryd`; without a valid token it gets `401` with
   `WWW-Authenticate: Bearer realm=<web>/api/registry/token, service=…, scope=…`.
2. The client calls the realm with Basic credentials. The web app identifies
   the caller — personal access token (`chc_pat_…`), service-account secret
   (`chc_sa_…`), or email+password (refused when the account has 2FA) —
   refusing expired credentials and attaching a token's organization /
   repository restriction (`lib/credential-auth.ts`), checks each requested
   scope against org membership / SA permissions / repository visibility /
   the restriction, and returns a 5-minute ES256 JWT whose `access` claim
   lists exactly what was granted and whose header `kid` names the signing
   key.
3. `registryd` verifies the signature with the file public key
   (`secrets/registry-token.pub`) or a database key from
   `token_signing_keys` (see *Signing keys* below) and enforces `access` per
   route. It holds no credential state of its own; revoking a PAT/SA takes
   effect within the token TTL.

Grants: org `owner`/`admin` → `pull,push,delete`; `member` → `pull,push`;
`viewer` → `pull` (private repositories included); anonymous / non-members →
`pull` on public repositories only; instance admins → everything plus
`registry:catalog:*`. Roles are declared once in `web/src/lib/org-roles.ts`
through better-auth's organization access control and shared by server,
client and the token service. Repositories are auto-created on first push
(private) when the pusher may write to the org namespace.

Per-repository grants (`repository_grants`: repository, subject `user` |
`team`, permission `pull` | `push` | `admin`) and teams (`teams`,
`team_members`; a team never outgrows the organization's membership, and
`afterRemoveMember` drops a leaver's seats and grants) raise the role's
baseline for one repository, never lower it: `lib/repo-access.ts`
`grantedPermission(userId, repoId)` is the maximum over the person's own
and their teams' grants, and `effectivePermission` folds it into the role
(members only). The token service (`allowedRepositoryActions`), the REST
API (`loadRepo` → `can.manage/write/delete`) and the pages
(`getRepoContext`) all consult it, so a `viewer` with a `push` grant pushes
one repository and nothing else. Service accounts keep their own permission
plus optional repository list.

Refinements: a `*` action (`repository:<name>:*`, what `skopeo delete`
requests) expands to every valid action and is then filtered by what the
caller may do; repositories in proxy-cache organizations grant `pull` only,
and one the proxy has not created yet counts as the organization's default
visibility for anonymous access (`lib/access.ts`); instance admins always
receive `registry:catalog:*`, which `registryd` also uses to recognise them
for the rate-limit exemption — unless the token is restricted to an
organization, which is not an instance-wide credential (`mayAccessCatalog`
refuses it too); a caller who may push gets `push` added to a pull-only
request (cosign reads with a pull scope before it attaches a signature, and
`manifest_blocks.pushers_exempt` lets such tokens read an image blocked only
by the signature policy — nothing else keys on it); a scope naming a
repository's former name (`repository_redirects`, see *Redirects*) is
reduced to `pull` and authorized against the target repository, so writes
through an old name get no grant at all.

## registryd (Go, no framework)

- **Names**: `<org>/<repo>` or a bare `<repo>`, which resolves to the
  `library` organization (`nginx` ≡ `library/nginx`). Proxy-cache
  organizations are the one exception to the two-level rule:
  `<org>/<a>/<b>/…` is accepted there, the repository being everything before
  the first route marker (`manifests`, `blobs`, `tags`, `referrers`), and
  Docker Hub proxies canonicalize `library/x` → `x`
  (`internal/upstream/names.go`) while the token scope keeps the name the
  client asked for. The token service and the UI apply the same rules
  (`web/src/lib/proxy-shared.ts`). A cross-repository mount's `?from=` name
  resolves the same way: `splitMountSource` (`internal/api/uploads.go`) maps
  no slash to the `library` organization, one slash to `<org>/<repo>` and
  refuses anything deeper, which only proxy caches have. It replaces an older
  check that required exactly one slash, under which a top-level `library`
  name could never be a mount source and a copy out of it re-uploaded every
  layer (`uploads_test.go`).
- **Redirects** (`internal/store/redirects.go`, `internal/api/redirects.go`):
  a renamed or transferred repository leaves a row in `repository_redirects`
  (`organization_slug` as it was at the time, `repository_name`,
  `repository_id`); a renamed organization one in `organization_redirects`
  (`old_slug` → `organization_id`). Resolution of a `<org>/<name>` that does
  not exist — identical in Go (`ResolveMoved`) and TypeScript
  (`lib/redirects.ts`): first the organization redirect (swap in the current
  slug; a repository that exists there wins), then repository redirects
  under the requested slug, the organization's current slug and every former
  slug; targets are addressed by id, so a later rename of the target is
  followed. `redirectCache` snapshots both tables for 30 s (a failed reload
  keeps serving the old snapshot). `lookupRepoRead` (exact name, then
  redirect) serves manifest GET/HEAD, tags, referrers and blob GET/HEAD from
  the target — event, pull count and traffic land there, the response keeps
  the requested name. Writes never follow a redirect: upload commit, mount,
  manifest PUT and both DELETEs answer `403 DENIED "repository moved to
  <org>/<name>; push to the new name (…)"`. `EnsureRepository` deletes the
  redirect rows for a name it creates in the same transaction (the web app's
  create action does the same), so a name taken over stops redirecting; the
  cache needs no invalidation because the exact name is always tried first.
- **Routes**: the full distribution spec — blob get/head/delete, uploads
  (chunked PATCH + monolithic POST, cross-repo mount, resume, cancel),
  manifests (image + index, tag or digest refs), `tags/list`, `referrers`
  (with `artifactType` filter; each descriptor carries the referrer's
  `annotations`, which the spec requires and cosign v3 reads to tell
  signatures from attestations — `store.ListReferrers` selects
  `(payload::jsonb)->'annotations'`), `_catalog` (admin-gated) — plus
  `GET /metrics` (= `GET /internal/v1/metrics`, see *Metrics*) and the
  internal API, bearer = `WEBHOOK_SECRET` except for `healthz`:
  `GET /internal/v1/healthz`, `GET /internal/v1/status` (build version from
  `internal/version.Version`, set with `-ldflags -X` / the Dockerfile's
  `ARG VERSION`; Go version, storage driver, `staging` mode with the staging
  dir and its free bytes in local mode or the in-flight `uploadSessions` in
  shared mode, blob count and physical bytes, start time and uptime, the
  file key's fingerprint as `publicKeyFingerprint` plus
  `publicKeyFingerprints` and `trustedKeys[{kid, fingerprint, source,
  retiredAt}]` for every key the verifier accepts, `authDisabled`, and
  `status: degraded` plus `databaseError` when the database is unreadable),
  `POST /internal/v1/gc` and `POST /internal/v1/proxies/reload`.
- **Content addressing**: blob bytes are stored once per digest
  (`blobs/sha256/ab/<hex>`); *repository membership* lives in
  `repository_blobs`, which is also the ACL boundary — a blob is only served
  through repositories it is linked to, so dedup never leaks private content.
- **Upload staging** (`internal/storage/staging.go`, `shared.go`,
  `verify.go`; `internal/api/uploads.go`): `storage.Staging` is what the
  handlers use for in-flight uploads — `Create`, `Get` (org, repo, offset),
  `Append(id, expectedOffset, r)`, `Open`, `Remove`, `Sweep`, `Mode`.
  `Append` returns `ErrOffsetMismatch` when the session has moved on, which
  the handler maps to `416 RANGE_INVALID` with the current `Range` so the
  client resumes. `LocalStaging` (`STORAGE_STAGING=local`, default) keeps
  `<id>.data` / `<id>.json` under `STORAGE_STAGING_DIR` — node-local, so
  scale-out needs sticky routing on `/blobs/uploads/`. `SharedStaging`
  (`shared`) keeps session rows in `upload_sessions` (`id`, `organization`,
  `repository`, `offset`, `chunks [{seq,size,key}]`, `node`, timestamps,
  `expires_at` indexed; registryd is the only writer) and streams every
  `PATCH`/`PUT` body into its own object `_uploads/<session>/<seq>-<nonce>`
  through the driver's `ObjectStore`, then advances the row with the
  optimistic lock `UPDATE … SET offset = offset + n … WHERE id = $1 AND
  offset = $expected` — zero rows means another replica won: the chunk
  object is deleted again and the real offset reported. `Open` concatenates
  the chunk objects lazily in order; `Remove` deletes the row and then the
  objects (failures are left to GC); `expires_at` = now + `UPLOAD_SESSION_TTL`,
  pushed forward by every append. **Commit** is one pass in both modes: the
  staged stream is wrapped in `storage.VerifyingReader` (hashes while
  reading, turns the final EOF into `ErrDigestMismatch`) and handed to
  `Driver.Put`, whose contract is now explicit — never publish the blob
  until the reader ended cleanly and the size matched (filesystem writes a
  temp file and renames; S3 completes the multipart upload only then, or
  aborts; bunny's request fails on a body error and the zone verifies the
  `Checksum` header). A mismatch answers `400 DIGEST_INVALID` naming both
  digests and discards the session; when the driver already has the blob
  (dedup) the content is still hashed through `StagedDigest`, so a wrong
  digest can never link content the client did not send. Quota checks use
  the declared digest and the staged size before the write. Session cleanup
  after commit runs on its own 30 s context so a client that disconnected is
  still cleaned up. `Sweep` runs hourly from `main.go` and inside
  `POST /internal/v1/gc` (`sweptUploads`): local mode drops files older than
  the TTL; shared mode deletes rows with `expires_at < now()` plus their
  chunks, then lists `_uploads/` and removes objects whose session has no
  row (objects are listed before the live ids are read, so a session opened
  meanwhile is never mistaken for an orphan). All replicas must run the same
  mode; the filesystem driver's `_uploads/` under `FILESYSTEM_ROOT` doubles
  as the default local staging dir, which is harmless (`<id>.data` files vs
  `<id>/` chunk directories) as long as no fleet mixes modes on one root.
- **Storage plugins**: backends register themselves with
  `storage.Register` in `init()` (the `database/sql` driver pattern) and are
  selected by name; options resolve from `<NAME>_*` environment variables.
  Bundled: `filesystem`, `s3` (any S3-compatible endpoint, optional presigned
  redirects) and `bunny` (bunny.net Edge Storage; uploads carry the SHA256
  `Checksum` header so the zone verifies content; optional signed pull-zone
  redirects). `registryd plugins` documents them. Each lives in its own
  package under `internal/storage/<name>`. The optional `storage.ObjectStore`
  interface (`PutObject`, `GetObject`, `DeleteObject`, `ListObjects(prefix)`;
  keys validated by `ValidObjectKey`) is what shared staging needs — all
  three bundled drivers implement it (bunny spools bodies of unknown size
  through a temp file because the Edge Storage API needs `Content-Length`);
  `OpenStaging` returns `ErrSharedStagingUnsupported` for a driver without
  it. S3 `Put` is multipart-capable: bodies up to 8 MiB go in one
  `PutObject`, larger ones as a multipart upload with 8 MiB parts buffered
  in memory (`bytes.Reader` parts, so SigV4 can sign the payload over plain
  HTTP as with MinIO in compose) and `AbortMultipartUpload` on any error,
  short write or digest mismatch — one 8 MiB buffer per concurrent upload,
  objects above 5 GiB work.
- **Default visibility**: repositories auto-created by a push take the
  organization's `organization_settings.default_visibility`, else the
  pushing user's `user_settings.default_visibility`, else private — and the
  matching repository quota is checked before anything is written.
- **Quotas**: before committing a blob (or mounting one into another org)
  and before auto-creating a repository, `registryd` checks the organization's
  own limit or, when it has none of that kind, every owner's account limit
  (`internal/store/quota.go`) and answers `403 DENIED` with the reason. An
  organization with its own limit is outside the owners' pool: the owner-side
  usage sums (`ownerStorageUsedSQL`, the repository count) left-join
  `organization_limits` and skip organizations whose limit of that kind is
  set. The web app applies the same rules
  (`web/src/lib/quota.ts`) when repositories or organizations are created
  through the UI or the REST API. `organization_limits.max_members` is
  web-only: `checkMemberQuota` runs in the organization hooks
  (`beforeCreateInvitation` counts open invitations as taken seats,
  `beforeAcceptInvitation` / `beforeAddMember` count members), in
  `POST /api/v1/orgs/{org}/invitations` and in `syncGroupBindings` (which
  skips the membership and audits `org.member.limit`). Limits rows are
  written through `web/src/lib/limits.ts` — admin screens, the
  Administration endpoints of the API (`/orgs/{org}/limits`,
  `/users/{userId}/limits`) and the sign-up / creation defaults
  (`instance_settings` row `quotas`, applied in the user `create.after` and
  `afterCreateOrganization` hooks and in `POST /api/v1/orgs`) — so audit
  and quota warnings are uniform. Each row has a `label` the owner sees and
  a `note` only administrators see. The `portal` settings row enables the
  better-auth `oneTimeToken` plugin; the Manage button on the settings pages
  generates a token and redirects to the portal with it.
- **Storage enforcement**: the `quota-enforce` job (`lib/quota-enforce.ts`)
  finds targets above a storage limit (`findBreaches`: organizations with
  their own limit, accounts across their pool), keeps them in
  `quota_breaches` (first seen, notices sent, pruned), notifies through
  `lib/notify.ts` (`quota.exceeded`, `quota.pruned`; organization webhooks
  too) and, once `graceDays` have passed, prunes with the pure planner in
  `lib/quota-enforce-shared.ts` (`planPruneToFit`: distinct blob bytes of
  live manifests, oldest untagged then oldest tags, cascading to referrers
  and orphaned index children, protected tags excluded) through `deleteTag`
  / `deleteManifestByDigest`, then triggers GC.
- **Manifests** are stored verbatim in Postgres (`manifests.payload`) —
  digests must verify byte-for-byte — together with parsed metadata
  (media type, config digest, subject digest for referrers) and an explicit
  reference table (`manifest_refs`) that drives GC and layer statistics.
- **Pull-policy blocks**: `manifest_blocks` (written by the web app) is the
  whole contract — manifest GET/HEAD answers `403 DENIED "pull blocked by
  policy: <reason>"` (vulnerability reasons end in `policy blocks <level>`,
  signature reasons in `(signature policy)`, both joined with `; ` when they
  coincide). `pushers_exempt`, set only for blocks caused by the signature
  policy alone, lets a token whose `access` grants `push` on the repository
  through (`api.blockApplies`); a combined block is never exempt.
- **Tag rules** (`internal/store/tagrules.go`, read from `tag_rules`):
  manifest PUT by tag runs `CheckTagImmutable` before anything is written,
  then writes the tag with `UpsertTagGuarded`, which locks the tag row
  `FOR UPDATE` and repeats the check inside the transaction so concurrent
  pushes cannot race past it (same digest → allowed, new tag → allowed).
  DELETE by tag runs `CheckTagDeletable`; DELETE by digest
  `CheckManifestDeletable`, refused when any tag pointing at the digest is
  protected. Violations are `*store.PolicyError` → `403 DENIED` with the
  message; pull paths are untouched. Repository rules are evaluated before
  organization rules; `MatchTagGlob` (`*`, `?`, literal, case-sensitive) is
  mirrored in `web/src/lib/tag-rules-shared.ts`. Because every write goes
  through these handlers, mirrors, the web app's own "move latest" PUT and
  docker/skopeo clients are all covered.
- **Range requests** (`internal/api/ranges.go`, `internal/storage/range.go`):
  `parseRange` classifies a `Range` header as none (absent, unknown unit,
  malformed or multi-range → 200 with the whole blob), ok (one satisfiable
  `a-b`, `a-`, `-n` → 206) or unsatisfiable (→ 416 with
  `Content-Range: bytes */<size>`). `storage.RangeReader` is an optional
  driver interface (`OpenRange(ctx, digest, offset, length)`);
  `storage.OpenRange` falls back to `Get` + skip/limit. Filesystem seeks, S3
  sends `Range` on `GetObject`, bunny sends it to the storage API. Redirect
  responses are unchanged — the 307 goes out before `Range` is looked at and
  the client repeats it against the presigned URL. HEAD ignores `Range`.
- **Traffic accounting** (`internal/traffic`, `internal/store/traffic.go`):
  handlers call `Server.countTraffic` — blob GET 200/206 → `pull_bytes` +=
  bytes written, `blob_pulls`++; blob redirect → `redirect_bytes` += blob
  size, `blob_pulls`++; manifest GET → `pull_bytes` += payload, GET or HEAD →
  `manifest_pulls`++ (same semantics as `pull_count`); upload commit →
  `push_bytes` += staged size (deduplicated content still counts, cross-repo
  mounts count nothing); manifest PUT → `push_bytes` += payload; 416 and
  error responses count nothing. `Counter` keys by `(repository, UTC day)`
  at request time (a flush that straddles midnight writes two rows), flushes
  every 10 s and once more on shutdown — `main.go` waits for it — with one
  `INSERT … ON CONFLICT DO UPDATE SET col = col + EXCLUDED.col` per row in a
  `pgx.Batch`; rows of repositories deleted meanwhile are skipped, a failed
  flush is merged back and retried. `repository_traffic` has registryd as its
  only writer.
- **Pull rate limiting** (`internal/ratelimit`, `internal/api/ratelimit.go`):
  configuration is the `instance_settings` row `ratelimit`
  (`{anonymous, authenticated, trustedProxies}`, written by the web app),
  with `RATE_LIMIT_ANONYMOUS/AUTHENTICATED/TRUSTED_PROXIES` as fallback for
  every missing field — the same precedence the web app shows. Loaded at
  start (a malformed value is fatal), re-read every 30 s, limiters swapped
  only when something changed (counters restart; a reload error keeps the
  previous limits). Enforced at the top of manifest GET/HEAD, before any
  database work; keyed `ip:<addr>` for anonymous tokens, else the token
  subject (`user:<id>` / `sa:<id>`). Exempt: tokens carrying
  `registry:catalog:*` (instance admins), and the subjects `user:system`,
  `mirror:*`, `proxy:*`. Fixed window per key, counted in Postgres
  (`rate_limit_counters`, one row per `<class>|<client>`): the window is
  aligned to the wall clock so every replica agrees on the boundary without
  coordinating, and a single `INSERT … ON CONFLICT DO UPDATE … RETURNING
  count` makes the tally exact across replicas. Rows whose window is two
  windows old are swept every five minutes. When the counter cannot be
  reached the request passes (a database outage must not block every pull)
  and the reason is logged at most once a minute. The client address is the last `X-Forwarded-For` hop only when the
  peer is inside a trusted prefix (IPv4-mapped IPv6 peers unmapped first),
  else the peer. Every limited response carries `RateLimit-Limit`,
  `RateLimit-Policy` (`<count>;w=<seconds>`), `RateLimit-Remaining` and
  `RateLimit-Reset`; 429 adds `Retry-After` and the OCI `TOOMANYREQUESTS`
  error body.
- **Proxy caches** (`internal/api/proxy.go`, `internal/upstream`).
  Configuration: credentials are encrypted with the web app's key, so
  registryd never reads `organization_proxies` for configuration. It calls
  `GET {INTERNAL_API_URL}/proxies` (bearer = `WEBHOOK_SECRET`;
  `INTERNAL_API_URL` defaults to `WEBHOOK_URL` minus its last path segment,
  i.e. `…/api/internal`), which returns every proxy — enabled or not, since
  disabled ones still route nested names — with decrypted credentials, and
  caches the result for 60 s. The cache is refreshed early on an upstream
  401, on a miss for a nested name (at most every 5 s), and immediately by
  `POST /internal/v1/proxies/reload`, which the web app calls after every
  save; per-slug upstream clients (and their cached tokens) survive
  refreshes when URL and credentials are unchanged. `upstream.Client`
  handles `WWW-Authenticate` challenges (Bearer via the realm with
  `service`/`scope`, Basic to the realm when credentials exist, anonymous
  Docker Hub tokens), caches tokens per scope, retries connection errors and
  5xx, verifies manifest digests, follows blob redirects (Go drops
  `Authorization` on cross-host redirects, as CDNs require) and logs every
  upstream request. Fetch path: manifest GET/HEAD by tag — fresh local tag
  (`tags.proxy_checked_at` within the TTL) → serve; else `HEAD` upstream,
  same digest → touch and serve, otherwise `GET`, store, serve (a first fetch
  skips the `HEAD`); upstream failure with a local copy → serve stale and
  record `last_error`, with nothing local → 404/403/429/502 mapped from the
  upstream error. Manifest GET by digest → fetched for the same repository
  when missing (index children). Blob miss → only digests some cached
  manifest of that repository references are fetched; content another
  repository already holds is linked (quota checked) without upstream
  contact, otherwise a per-digest `upstream.Group` (context-aware
  singleflight: waiters are bounded by their request, the leader runs
  detached so a hung-up client does not abort the download) streams the blob
  into `storage.Staging`, verifies the digest, commits it through the driver
  and registers the blob row; each requesting repository then links it. At
  most 8 upstream downloads run at once. Storing a manifest reuses the push
  path — auto-creation with the organization's default visibility and the
  repository quota, `UpsertManifest` + refs, `UpsertProxyTag`, a `push` event
  with actor `proxy` (`pushed_by = 'proxy'`), and the `manifest.push` webhook
  to the web app (config caching, repository webhooks, signature checks,
  the scan — the scanner pulls every layer through registryd and thereby
  prefetches them). `downloadProxiedBlob` stages through the same
  `storage.Staging`, so in shared mode an upstream download costs one extra
  backend write and read. Storage quotas are checked before a download when the
  upstream sends a length, else before linking. `allowed_patterns` and
  `enabled` are checked before any upstream contact; the pull policy
  (`manifest_blocks`) applies on serve as for every image.
  `last_checked_at` / `last_error` are written at most every 30 s per
  organization unless the message changes; manifest requests by tag stamp
  `tags.last_pulled_at`, the eviction key.
- **Events**: every push/pull/delete is recorded (`events`) off the hot path
  (`actor_type` includes `proxy` and `mirror`); pulls also bump
  `repositories.pull_count`. A manifest request — GET or HEAD — counts as a
  pull (Docker Hub semantics; warm client caches revalidate with HEAD).
- **Events to the web app**: manifest pushes/deletes are first written to
  `registry_event_outbox` (`store/outbox.go`, synchronous, before the client
  gets its response) and then POSTed as an HMAC-signed event carrying the
  row `id` (`hooks/webhook.go`, four attempts with backoff, in memory). The
  web app claims the row (`claimed_at`) before it caches the image config,
  fans out webhooks and quota warnings, verifies signatures and kicks off
  scanning, and marks it `delivered_at` afterwards; a claim older than ten
  minutes counts as abandoned. Its scheduler tick drains rows that were
  never claimed or whose claim went stale (`lib/registry-events.ts`, 30 s
  cadence, backoff 30 s → 1 h, 25 attempts, delivered rows swept after a
  week), so an outage delays events instead of losing them; the HTTP path
  is only the low-latency fast path. `manifest.delete` is posted for tag
  deletes too (with the digest the tag pointed at, resolved before the
  delete) and carries `tags` — every tag that pointed at a manifest deleted
  by digest. `/internal/v1/healthz` pings the database and `Stat`s an
  impossible digest on the storage backend (3 s budget) and answers 503
  when either fails.
- **GC** (`POST /internal/v1/gc`, bearer = webhook secret, optional
  `?grace=30m`): drop repo→blob links no manifest references, delete blob
  rows with zero links, remove their bytes from storage, sweep stale upload
  sessions and orphaned staging chunks (`sweptUploads`). The grace window
  (default 1h) protects pushes in flight.
- **Signing keys** (`internal/auth/token.go`, `internal/store/signingkeys.go`):
  the `Verifier` keeps the file key (`fileKid` = its fingerprint) plus a map
  of database keys loaded through a `KeySource` over `token_signing_keys`
  (active keys and those retired less than the drop window ago). The JWT
  keyfunc resolves `kid`: empty or the file fingerprint → file key; else a
  database key inside the window; else `errUnknownKid`, on which `Identify`
  refreshes the keys once (at most every 5 s) and retries, so a key
  generated a moment ago works immediately. `RunKeyReload` polls every
  `TOKEN_KEY_RELOAD_INTERVAL` (default 60 s, minimum 5 s); the drop window
  is `TOKEN_KEY_DROP_WINDOW` (default 10 m, minimum 5 m — the token
  lifetime). A failing reload keeps the previous keys. `TrustedKeys` /
  `PublicKeyFingerprints` feed `/internal/v1/status`.
- **Metrics** (`internal/metrics`, `internal/api/metrics.go`): a private
  `prometheus.Registry` with the Go and process collectors plus the
  `chicoree_registryd_*` series; `Metrics` is nil-safe so `Server{}`
  literals in tests need no setup. `RouteTemplate(path)` maps paths to a
  bounded vocabulary (`manifest`, `blob`, `upload`, `tags`, `referrers`,
  `catalog`, `base`, `internal`, `metrics`, `other`) by scanning for the
  last marker segment, so nested proxy names and a repository literally
  called `manifests` classify correctly. Instrumentation: `logMiddleware`
  (request counter, latency histogram, in-flight gauge), `countTraffic`
  (upload bytes), `handleBlobGet` (bytes served by `stream` / `redirect`
  mode), `enforcePullLimit` (429s by subject) and the proxy (`noteUpstream`
  per upstream call, cache hit / miss per manifest and blob — a blob linked
  by dedup counts as a hit); series the alert rules rely on are pre-created
  so a fresh process exposes 0. `staging_free_bytes` is a `GaugeFunc`
  evaluated per scrape. The endpoint is gated by `metricsGate`: the
  `instance_settings` row `metrics` (`{enabled, tokenHash}`), polled every
  30 s by `RunMetricsReload` like the rate limits, and `METRICS_TOKEN` from
  the environment. The row's `token` is encrypted with the web app's
  `AUTH_SECRET`-derived key, which registryd does not have, so
  `saveMetricsSettings` also stores `tokenHash = sha256(token)` in the clear
  and registryd compares `sha256(bearer)` against it in constant time.
  Either credential is accepted while configured; 404 when neither is, 401
  otherwise. A row saved before `tokenHash` existed counts as disabled until
  the section is saved again.
- **Scan workers** (`lib/scan-tasks.ts`, `lib/scan-worker-auth.ts`,
  `app/api/internal/worker/*`; the worker program itself is a separate
  repository, `chicoree-scan-worker`, built against `lib/scanners/trivy.ts`):
  with *Offload scans to workers* on, a push's
  scan becomes a `scan_tasks` row instead of running trivy in the web
  container. Workers authenticate with `SCAN_WORKER_TOKEN`, claim the oldest
  due row atomically (`FOR UPDATE SKIP LOCKED`, twenty-minute lease), get the
  manifest, layers, registry address and a scoped pull token, and post the
  normalised findings back; `finishScan` then does exactly what the inline
  path does (store, pull-policy refresh, notification). The scheduler tick
  releases expired leases and, while no worker has reported in for two
  minutes, runs queued tasks inline — the option degrades to today's
  behaviour rather than stalling. Workers hold no database credentials.

## Web app (Next.js App Router)

- **Auth**: better-auth with the organization, two-factor (TOTP + email OTP),
  magic-link, email-OTP, passkey (WebAuthn) and admin plugins; GitHub/Google
  and any OIDC issuer as social providers; an in-house `ldap` plugin
  (`lib/auth-ldap.ts`, `lib/ldap.ts`) adds `POST /sign-in/ldap`, which binds
  against the directory, provisions the account, and raises the two-factor
  challenge itself (the two-factor plugin only hooks its own routes). The
  docker token endpoint accepts the same directory credentials.
  `AUTH_GROUP_BINDINGS` (`lib/group-bindings.ts`) maps LDAP group DNs,
  GitHub orgs/teams, Google Workspace groups and OIDC group claims to the
  instance role and org memberships; LDAP applies it inline, social logins
  through the account create/update database hooks (`lib/oauth-groups.ts`).
  The first registered account
  becomes instance admin (database hook). Org slugs are validated to be OCI
  path components and reserved route names are blocked.
- **Sign-up policy** (`lib/signup-policy.ts`, settings section `access`
  with `SIGNUP_MODE`, `SIGNUP_ALLOWED_DOMAINS`, `ORG_CREATION` as env
  defaults): better-auth's `databaseHooks.user.create.before` is the single
  choke point for email sign-up, magic link / email OTP, OAuth/OIDC first
  login and LDAP provisioning (browser and token endpoint); it throws an
  `APIError` with a user-facing message. Order: domain list (always) →
  sign-up mode (skipped for the first account). Invite mode accepts a
  pending, unexpired invitation whose email matches — the sign-up form sends
  the invitation id in the `x-chicoree-invitation` header so the check is
  exact, otherwise any pending invitation for the address counts (so social
  logins work for invitees). `organizationHooks.beforeCreateOrganization`
  refuses non-admins when the policy is `admins`. The auth instance is
  rebuilt on settings save, so the hooks always see the current policy.
- **Schema**: drizzle owns migrations (`web/drizzle/`, applied on container
  start). `web/src/db/registry-schema.ts` is the cross-service contract —
  registryd's SQL in `registryd/internal/store/` must match it. Tables
  registryd reads or writes: `organization`, `member`, `repositories`,
  `blobs`, `repository_blobs`, `manifests`, `manifest_refs`, `tags` (with
  `proxy_checked_at` and `last_pulled_at`), `events`, `manifest_blocks`,
  `organization_settings`, `user_settings`, `organization_limits`,
  `user_limits`, `tag_rules`, `organization_proxies` (only `last_error` /
  `last_checked_at`), `repository_traffic` (sole writer), `manifest_blocks`
  (with `pushers_exempt`), `repository_redirects` and
  `organization_redirects` (read), `token_signing_keys` (read),
  `upload_sessions` (sole writer) and `instance_settings` (the `ratelimit`
  and `metrics` rows). Web-only tables: `audit_log` (`db/audit-schema.ts`),
  `job_schedules`, `notification_preferences`, `notification_state`,
  `retention_policies`, `repository_webhooks` (with `organization_id` for
  organization hooks and `format` = json | slack | discord | teams | text,
  rendered by `lib/webhook-chat.ts`), `login_attempts` (docker-login
  throttle counters per address and account, `lib/login-throttle.ts`),
  `repository_stars`, `repository_visits`,
  `vulnerability_scans` (+ `findings`, `scanner`, `scanner_version`),
  `scan_findings` and `vulnerability_exceptions` (`db/scanning-schema.ts`),
  `signing_keys_trusted`, `user_signing_keys`, `signing_identities_trusted`
  (issuer + subject pattern per organization / repository),
  `manifest_signatures` (+ `identity_id`) and `manifest_artifacts`
  (`db/supply-chain-schema.ts`), `access_tokens` (+
  `last_used_ip`, `description`, `organization_id`, `repository_ids`),
  `service_accounts` (+ `last_used_ip`); columns `repositories.readme` /
  `require_signature` / `logo`, `organization_settings.require_signature` /
  `trust_member_keys`,
  `user_settings.onboarding_dismissed_at` / `admin_checklist_dismissed_at`.
  registryd's `INSERT INTO repositories` names its columns and no query there
  selects `*`, so nullable additions like `repositories.logo` (see *Pictures*)
  need no Go change.
- **Data flow**: server components query Postgres directly (`src/lib/data.ts`);
  mutations are server actions with per-org role checks; better-auth handles
  org/member/invitation/2FA/passkey flows through its own client API.
- **Pagination** (`src/lib/paginate-shared.ts`,
  `components/ui/pagination.tsx`): a pure module (no `@/db`, no Node
  built-ins) imported by server queries, server components and client
  components alike. `PAGE_SIZES` holds the rows per page of every list in one
  object; `FINDINGS_PAGE_SIZES` the 25 / 50 / 100 choices of the findings
  table, `WEBHOOK_LOG_MAX` (50) the per-hook cap the delivery writer prunes to
  and the reader honours. `parsePage` / `pageParam` read a page out of a
  search parameter (positive safe integers only, the first value of an array,
  anything else page 1); `paginate(total, page, pageSize)` clamps it into
  `1…pages` and derives `offset`, `first`, `last`, `hasPrev`, `hasNext` as a
  plain `PageState` a server component can hand to a client one; `pageSlice`
  does the same for a list already in memory; `pageHref` builds a link that
  keeps every other query parameter and drops the key entirely on page 1;
  `pageWindow` returns the numbers to render with `0` for an ellipsis,
  bounded by `max` (7) so the control cannot grow wide enough to overflow;
  `rangeLabel` formats `151–200 of 334 entries`. Every paged list is one
  `COUNT(*)` plus one `LIMIT/OFFSET` slice over the same `WHERE` clause, run
  in parallel by `paginatedQuery`, which re-reads the last page when the
  requested one turned out to be past the end (the only case with a second
  slice query), so a filter can never drift between the count and the rows.
  The queries live next to the list they serve: `queryAudit`
  (`lib/audit-query.ts`), `blockedImages` / `listExceptions` /
  `searchFindings` (`lib/security.ts`), `jobRunsPage` (`lib/jobs.ts`;
  `recentJobRuns` stays for the admin overview card and `/api/jobs*`),
  `listAdminUsers` / `orgReposPage` / `recentActivity` / `listRepoTags`
  (`lib/data.ts`), `listAdminOrganizations` (`lib/admin-data.ts`),
  `untaggedManifestsPage` (`lib/manifests.ts`; `listUntaggedManifests` still
  returns everything, which the retention planner needs) and
  `searchRepositoriesPage` / `searchTagsPage` / `searchDigestsPage` /
  `searchOrganizationsPage` behind `searchAll` (`lib/search.ts`). Two
  supporting queries: `repoTagOverview(repoId)` returns the tag count, the
  newest tag names (capped at `COMPARE_TAG_LIMIT` = 500, for the compare
  selector), the digest of `latest` and the newest proxy check in one go, so
  the repository and compare pages no longer scan the full tag list; and
  `listWebhookRows` reads the complete (≤ `WEBHOOK_LOG_MAX`) log of every
  hook of a scope with one `row_number() OVER (PARTITION BY webhook_id ORDER
  BY created_at DESC)` query instead of one query per hook, the manager
  paging it in the browser. `Pagination` / `PaginationFooter` are the one
  control, stateless and hook-free so the same file renders in server and
  client components: URL mode takes `basePath` + `params` (+ `paramKey`) and
  renders `next/link` anchors, ends as `<span aria-disabled="true">`;
  component mode takes `onPage`, plus `pageSizeOptions` / `onPageSize` for
  the findings table's rows-per-page select. The markup carries
  `data-pagination`, `data-page`, `data-pages`, `data-total` and
  `[data-pagination-range]` as stable hooks for UI checks; page numbers are
  `hidden sm:flex` with a compact `page/pages` counter below `sm`. No
  filter form carries a page field, so submitting one produces a URL without
  the parameter and the list starts over at page 1; client-filtered lists
  reset explicitly. Read-side only: no schema change.
- **Scanning** (`src/lib/scanners/`, `src/lib/scan.ts`,
  `scanner-shared.ts`): `Scanner { name, label, version(), scan(input),
  health() }` is the backend contract; `ScanInput` carries the repository
  path, digest, parsed manifest, layer descriptors, `REGISTRY_INTERNAL_URL`
  and a two-hour system pull token for that repository, `scan` returns
  normalised `findings`, the backend's `raw` report, the severity `summary`
  and the scanner version. `clair.ts` submits the layers to Clair's indexer
  (Clair fetches them from registryd with the token), polls `index_report`
  (5-minute deadline), fetches the `vulnerability_report` and normalises it
  (id = advisory name, severity from `normalized_severity`, `fixedIn`,
  introducing layer, `os` for apk/dpkg/rpm databases else `library`).
  `trivy.ts` runs `trivy image --format json --quiet --scanners vuln
  --image-src remote --timeout <n>s --cache-dir <dir> [--insecure]
  [--server <url>] <registry-host>/<org>/<repo>@<digest>` with `execFile`
  (hard kill at timeout + 30 s); the same JWT is handed over as a
  `registrytoken` in a temporary `DOCKER_CONFIG` scoped to the registry host
  only (a global `--registry-token` would be sent to the registries Trivy
  downloads its database from, and nothing secret goes on the command
  line); `--insecure` when the internal URL is `http://`. Indexes are never
  handed to a scanner: each platform child is scanned on its own push
  event. `index.ts` (`scannerFromSettings`, `getScanner`,
  `scanningEnabled`, `scannerLabel`) is the single answer to "is scanning
  on?" for the tag-list column, the tab, the jobs list, the health card, the
  metrics gauge and `runScan`; the settings section `scanner`
  (`{ backend, clairUrl, trivyServerUrl, trivyTimeoutSeconds }`, env defaults
  `SCANNER` / `CLAIR_URL` / `TRIVY_SERVER_URL` / `TRIVY_TIMEOUT_SECONDS`;
  `TRIVY_BIN` and `TRIVY_CACHE_DIR` env-only) is saved from `/admin/scanning`,
  whose *Test* builds a scanner from the unsaved form and calls `health()`.
  `runScan` → status `indexing` → `scanner.scan` → `storeScanResult`
  (`vulnerability_scans` keyed by digest — content-addressed and shared
  across repositories — gets `findings` jsonb, `summary` computed from them,
  `report` raw, `scanner`, `scanner_version`; `replaceScanFindings` rewrites
  the `scan_findings` side rows — one per (digest, id, package, version),
  indexed on digest, id and package — in a transaction) →
  `refreshRepositoryBlocks` → `scan.completed`. `ensureFindings(row)`
  returns stored findings or normalises a legacy Clair row on first view
  (`normalize.ts` `reportKind` / `findingsOf`) and writes them back;
  `normalizeLegacyScans` backs the `scan-normalize` job. Exceptions
  (`vulnerability_exceptions`: organization, optional repository, id,
  optional package, justification, `expires_at`) are applied in
  `lib/pull-policy.ts`: `effectiveScanSummary` = counts after removing
  accepted findings, and `violation()` is judged on that, so blocks change
  on create / revoke (both recompute) and on expiry whenever blocks are
  recomputed (`exceptions-expire` job, which also prunes rows expired > 30
  days). Repository-scoped rules win over organization-wide ones; ids compare
  case-insensitively; a package-limited rule needs an exact package match.
  `lib/security.ts` starts every dashboard from the CTE `tagged` (each
  tag's manifest plus, via `manifest_refs`, the platform children of index
  tags, deduplicated by digest) with a reusable `EXCEPTED` `EXISTS`:
  `securityTotals`, `worstRepositories`, `blockedImages`, `listExceptions`,
  `searchFindings` (`vulnerability_id ILIKE %q% OR package ILIKE %q%`, 200
  rows) behind `/<org>/security` and `/admin/security`. Index (multi-arch)
  manifests aggregate their children's scans in the UI.
- **Notation** (`lib/notation.ts`): a referrer of artifact type
  `application/vnd.cncf.notary.signature` with a JWS layer is parsed
  (`parseNotationJws`, pure), the signature checked with the leaf certificate
  from `x5c` (PS256/384/512 with RSA-PSS salt = hash length, ES256/384/512
  in IEEE P1363 form) over `protected.payload`, the payload's
  `targetArtifact.digest` compared to the subject and `io.cncf.notary.expiry`
  honoured; it is *verified* when the SPKI fingerprint of any chain
  certificate matches a trusted key row (leaf or issuing CA), otherwise
  *untrusted* with the certificate subject as identity. COSE layers are
  listed as untrusted with a reason; trust-policy files, revocation and
  timestamps are not implemented.
- **Signatures** (`src/lib/signatures.ts`, `signatures-shared.ts`,
  `app/api/artifacts/[repo]/[digest]/route.ts`): `discoverArtifacts` finds
  manifests whose `subject_digest` is one of the subjects ∪ manifests under
  `sha256-<hex>.sig|att|sbom` tags; `classifyArtifact` maps a descriptor to
  kind (`signature` | `attestation` | `sbom` | `other`), subkind
  (`provenance`, `spdx`, `cyclonedx`, `vuln`, `cosign-sign`, `notation`,
  `custom`) and format (`cosign-legacy`, `sigstore-bundle`, `dsse`,
  `notation`, `raw`); the parsed
  summary (SBOM package count and preview, SLSA v1 / v0.2 fields) is cached
  content-addressed in `manifest_artifacts` (the first layer blob is loaded
  through registryd with a system pull token, ≤ 16 MiB; a summary computed
  while the blob was unreachable is not cached). Trusted keys
  (`signing_keys_trusted`: organization, optional repository, normalised
  SPKI PEM, fingerprint = sha256 of the DER SPKI — the value Sigstore
  bundles carry as the key hint, type; ≤ 50 per scope) are parsed with
  Node's `createPublicKey` (ECDSA, Ed25519, RSA ≥ 2048) or taken from an
  X.509 certificate PEM (the certificate's public key; how Notation
  signing certificates and CAs are trusted). Personal keys
  (`user_signing_keys`: owner, name, PEM, globally unique fingerprint; ≤ 10
  per user, *Settings → Signing keys*) join them through
  `effectiveVerificationKeys(orgId, repoId)`, which yields `VerificationKey`s
  of scope `trusted` (organization / repository rows) or `user` —
  `listMemberKeys(orgId)`: keys of non-banned users who are members with a
  `WRITER_ROLES` role or instance admins — unless
  `organization_settings.trust_member_keys` (default true) is off. A
  verified row records either `key_id` or `user_key_id`; checks carry
  `signer` for the wording *verified by Alice's key laptop*. Personal key
  changes re-verify every organization the owner may push to after the
  response (`reverifyForUser`, `after()`); `afterRemoveMember` /
  `afterUpdateMemberRole` re-verify the organization in the background; the
  `reverify-signatures` job re-checks everything on demand.
  `checkArtifactSignatures` verifies cosign legacy layers (simple-signing
  payload must name this digest and repository; annotation signature over
  the raw payload), Sigstore bundles (`dsseEnvelope` — statement subject
  must cover the digest, PAE verified — or `messageSignature` over the
  subject manifest bytes; a key hint matching a trusted key that fails →
  *invalid*) and DSSE envelopes. Fulcio certificates go through
  `lib/sigstore.ts` (sigstore-js `@sigstore/verify` with the vendored
  `sigstore-trusted-root.json`, or `SIGSTORE_TRUSTED_ROOT`): certificate
  chain + SCT, Rekor entry (inclusion promise or proof), validity at the
  logged time and the signature itself; legacy `.sig` / `.att` layers are
  converted to a v0.1 bundle from their `dev.sigstore.cosign/certificate`,
  `/chain` and `/bundle` annotations first (no Rekor annotation → cannot be
  verified). A verified chain whose issuer + SAN match a
  `signing_identities_trusted` row in scope (`matchTrustedIdentity`, glob
  subjects) is `verified` with `identity_id`; a verified chain without a
  match, or a failed check, stays `keyless` with `chainVerified` and the
  reason in the details. Results are upserted into `manifest_signatures`
  (repository, image digest, artifact digest, kind `signature` |
  `attestation`, status `verified` | `untrusted` | `invalid` | `keyless`,
  key id / identity id, identity, per-signature details) by
  `verifyManifestSignatures`; `reverifyRepository` / `reverifyOrganization`
  run after every key, identity or policy change; `onManifestPushed` (from the
  `manifest.push` event) re-verifies an artifact's subject or checks a new
  image for existing artifacts, and refreshes blocks quietly when the
  signature policy is on. Policy: `organization_settings.require_signature`
  with `repositories.require_signature` (NULL = inherit) →
  `effectiveSignaturePolicy`; `refreshRepositoryBlocks` then blocks every
  manifest that is not itself an artifact (`looksLikeArtifact`: subject,
  cosign tag, artifact-only layers or the empty config), has no
  `manifest_signatures` row with `kind = signature, status = verified` and is
  not a child of a verified index — reason `SIGNATURE_BLOCK_REASON`, merged
  with the vulnerability reason, `pushers_exempt` when it stands alone.
  Newly blocked digests notify `scan.blocked` or `signature.blocked` (the
  latter skipped when quiet, i.e. between an image push and its signature).
  The artifacts route serves the predicate JSON out of a DSSE envelope /
  bundle, or with `raw=1` (and for plain `.sbom` artifacts) the first layer
  blob, after a repository read check.
- **Discovery** (`src/lib/viewer.ts`, `search.ts`, `search-shared.ts`,
  `readme.ts`, `stars.ts`, `onboarding.ts`, `admin-checklist.ts`):
  `viewerFromSession` → anonymous | user (with `isAdmin`), and
  `visibleRepositoriesFilter(viewer)` is one SQL condition over a
  `repositories r` alias — `visibility = 'public'` for anonymous, `TRUE`
  for admins, `public OR organization_id IN (member's orgs)` otherwise —
  that every discovery query composes (search, Explore, starred, recently
  viewed, organization search); it mirrors `lib/access.ts`. Search is
  `ILIKE` on name, description and `org/name` (pattern escaped), prefix
  matches first; `searchTags` (`repo:tag` narrows), `searchDigests` (exact
  `sha256:` or `LIKE 'sha256:<12+ hex>%'`), `searchOrganizations`;
  `quickSearch` trims to 8 for the typeahead (`GET /api/search`, from 2
  characters, `Cache-Control: private, no-store`), `searchAll` feeds
  `/search`. Large instances can add `pg_trgm` GIN indexes on
  `repositories.name` / `description` and `tags.name` — deliberately not in
  the drizzle schema so `drizzle-kit push` needs no extension. READMEs:
  `renderReadme` = `marked` (GFM) → `sanitize-html` with an explicit
  allowlist, `allowedSchemesByTag.img = ["https"]`, `rel="nofollow
  noopener"` on links, task-list inputs forced to disabled checkboxes, then
  `dangerouslySetInnerHTML`; `imageAbout` reads the `latest`/newest tag's
  `config.Labels`, then manifest annotations, then the first child of an
  index. `repository_stars` (PK user + repo) and `repository_visits`
  (upserted from the repository page inside `after()`, the `ON CONFLICT …
  WHERE last_visited_at < now() - interval '1 minute'` clause throttles
  writes) back the Star button and the dashboard lists; `userOnboarding`
  derives the three steps from membership, `access_tokens` and a push event;
  `adminSetupChecklist` reads settings, schedules, `scanningEnabled()` and
  `quickHealth()`; dismissals are timestamps on `user_settings`.
- **Repository tools** (`src/lib/redirects.ts`, `compare-shared.ts`,
  `compare.ts`, `shared-layers.ts`, `app/actions/repo-tools.ts`):
  `renameRepository` (managers; not in proxy organizations; reserved names
  now include `audit` and `compare`; transaction: rename, clear redirects
  for the new name, add the old one), `transferRepository` (a thin wrapper
  over `moveRepositoryToOrganization`, see *Moving repositories* below) and
  `renameOrganization` (owners;
  `library` excluded; `organization_redirects`). Layouts cannot see the
  request URL, so `src/proxy.ts` (Next proxy, page routes only) sets an
  `x-pathname` header for the organization layout; pages call
  `redirectMovedRepository` / `redirectMovedOrganization`
  (`permanentRedirect`, HTTP 308). Creating a repository or organization
  clears the redirect for that name. Comparison is pure
  (`diffLayers` by digest with a reorder-safe two-pointer walk that keeps
  the target order, `diffConfig`, `diffAnnotations`, `diffFindings` keyed
  by id + package, `commonPlatforms`); `loadCompareSide` resolves a tag or
  digest, picks the platform child of an index (attestations skipped), loads
  the cached config (or fetches it through the registry) and the scan row;
  `web/scripts/check-compare.ts` exercises it on fixtures.
  `sharedLayerRefs` is one query per manifest joining its refs with every
  other `manifest_refs` row for the same digests, visibility computed in
  SQL, aggregated to total / hidden / up to 25 visible labels per layer;
  `repositoryStorage` gives logical bytes (union of each tag's blobs, index
  children included), physical bytes (distinct linked blobs) and bytes
  shared with other repositories.
- **Moving repositories** (`src/lib/repo-move.ts`, `repo-move-shared.ts`,
  `storage-accounting.ts`, `app/actions/bulk-move.ts`,
  `app/(app)/admin/organizations/move/`): the transfer rules live in one
  place, split so a caller can preview.
  `planRepositoryMove({repositoryId, targetOrganizationId, actor, batch?})`
  runs every check and writes nothing; `moveRepositoryToOrganization(…)`
  re-plans and then performs, so a stale preview can never let a move
  through. `MovePlan` carries `ok`, a machine-readable `MoveSkipCode`, the
  human-readable `message` (the wording the danger zone has always shown),
  both organizations and `bytesNew`; `MoveResult` adds `moved`, `href` and
  `pullReference`; `skipLabel` turns a code into the badge text. Checks in
  order: the repository exists, the actor manages the source (instance admins
  manage everything), both organizations exist and differ, the actor manages
  the target, neither side is a proxy cache, the name is valid as a
  non-nested repository name, the name is free in the target,
  `checkRepoQuota`, `checkStorageQuota` over `bytesNew`. The move itself is
  one transaction (re-home `repositories`, re-home the repository-scoped
  `tag_rules` and `retention_policies` rows whose `organization_id` must
  follow, clear a redirect that pointed the name inside the target, insert
  the `repository_redirects` row for the old `source-slug/name`), then two
  `repo.transfer` audit rows and, in `after()`, `refreshRepositoryBlocks`
  (the pull policy is the target's now), `checkQuotaWarnings` and the
  `repository.transferred` webhook.
  `app/actions/repo-tools.ts#transferRepository` is now a wrapper around it
  with its form fields and UI unchanged. Runs are sequential, so repository
  *i+1* is checked after *i* has committed and the quota queries see reality;
  only the **preview** simulates, through `BatchContext` (`repositoryIds`,
  claimed `names`, `pendingPublic`, `pendingPrivate`, `pendingBytes`), which
  `planBulkMove` folds each accepted plan into with `applyToBatch`. That is
  why the preview catches a name collision between two selected repositories,
  counts a layer shared by two of them once, and skips at the same repository
  the real run will. Two supporting changes:
  `repositoryBytesNewToOrg(repositoryId, organizationId, exclude[])` moved
  into `lib/storage-accounting.ts` (with `blobBytesNewToOrg` beside it for
  the image copy) and gained the `exclude` argument, parameterised as
  `ANY(string_to_array($n, ','))` like `lib/shared-layers.ts`; and
  `checkRepoQuota` gained a fourth optional `pending = 0` added to the
  current usage before the limit comparison. The two admin actions
  (`previewBulkMove`, `runBulkMove`) are `requireAdmin`, take `FormData`,
  de-duplicate ids while keeping the administrator's order, refuse more than
  `MAX_BULK_MOVE` (50), and the run wraps each move in `try/catch` so a throw
  becomes a `failed` row and the loop continues, finishing with one
  `repo.bulk_transfer` audit row on the target. No schema change, and nothing
  in `registryd/`: the Go side already serves moved repositories through
  `repository_redirects` and already refuses pushes to a redirected name.
- **Moving one image** (`src/lib/image-move.ts`, `image-move-shared.ts`,
  `app/actions/images.ts`, the tag page's `move-image.tsx`): `planImageCopy`
  reads Postgres only. It walks the source manifest depth-first over
  `manifests`, visiting an index's children before the index itself so the
  push order satisfies registryd's "child manifest must already exist" check,
  and collects config and layer digests on the way (foreign /
  non-distributable layers skipped). `discoverArtifacts`
  (`lib/signatures.ts`) then adds everything attached to any of the image
  digests, each artifact walked the same way and remembering the cosign tag
  it was found under. The plan is
  `{rootDigest, manifests[], blobs[], imageDigests[], artifactCount}`;
  manifest bytes come from `manifests.payload`, the exact bytes as pushed, so
  the digest is preserved and an image the pull policy blocks can still be
  promoted. `executeImageCopy` signs one hour-long ES256 token (subject
  `user:<id>`) carrying `pull` on the source path and `pull,push` on the
  destination, and uses it for everything: per blob
  `POST /v2/<dest>/blobs/uploads/?mount=<digest>&from=<sourcePath>`, where
  `201` means the blob was linked with no upload and `202` means registryd
  fell through to an upload session, on which the engine streams the bytes
  through `openBlobStream` + `LocalPusher.putBlob` (`lib/mirror.ts`) so the
  copy still completes; then each manifest in plan order as
  `PUT /v2/<dest>/manifests/<ref>`, `<ref>` being the destination tag for the
  image itself, the cosign tag for an artifact that had one, and the digest
  for everything else. Because this is an ordinary authenticated push,
  registryd applies its own manifest validation, storage and repository
  quotas, the immutable-tag guard, the `events` rows and the webhook to the
  web app, which caches image configs, fans out repository webhooks, verifies
  signatures and queues the scan; the feature emits no registry events of its
  own. `app/actions/images.ts` holds the rules (write access on both sides
  via `getOrgRole` + `WRITER_ROLES`, no `organization_proxies` row on either
  side, `repoNameProblem` and `tagNameProblem` on the destination, an
  immutable destination tag pointing elsewhere, a protected source tag under
  *move*), the quota (`blobBytesNewToOrg(plan.blobs, destOrgId)` into
  `checkStorageQuota`, plus `checkRepoQuota` and `resolveDefaultVisibility`
  when the destination repository has to be created, with the same
  `repo.create` audit row and redirect clearing as `createRepository`), the
  `deleteTag` (`lib/tag-admin.ts`) that a move ends with, and afterwards
  `refreshRepositoryBlocks(destination)`, `checkQuotaWarnings` and the
  `image.copy` / `image.move` audit rows in both organizations.
  `image-move-shared.ts` is the client-safe half: `TAG_NAME_RE` (registryd's
  `tagRe`), `tagNameProblem`, `pullPath`, `pullReference` and
  `ImageMoveMode`. No schema change, and the only registryd change is
  `splitMountSource` (see *Names* above).
- **Credentials** (`src/lib/token-policy-shared.ts`, `credential-auth.ts`,
  `signing-keys.ts`, `registry-jwt.ts`, `token-expiry.ts`,
  `app/actions/credentials.ts`, `signing-keys.ts`): the pure rules —
  `expiryOptions` / `resolveExpiry` (presets 7 / 30 / 90 / 365 days, custom
  date, never, the lifetime cap with a one-minute tolerance),
  `expiryState`, `normalizeRestriction` / `restrictionAllows` — are shared
  by forms and server; the policy (`maxTokenLifetimeDays`,
  `requireTokenExpiry`) lives in the `access` settings section with
  `TOKEN_MAX_LIFETIME_DAYS` / `TOKEN_REQUIRE_EXPIRY` as env defaults.
  `identifyAccessToken` / `identifyServiceAccount` look the credential up by
  hash, refuse expired ones and banned accounts, attach the PAT's
  restriction to the `Caller`, and record `last_used_at` / `last_used_ip`
  with one throttled UPDATE (`WHERE last_used_at IS NULL OR last_used_at <
  now() - interval '5 minutes'`, fire-and-forget); `allowedRepositoryActions`
  empties the grant when `restrictionAllows` fails (a repository-limited
  token never gets a not-yet-existing repository, so no auto-create), and
  `authenticateJobsRequest` refuses restricted tokens. `rotateAccessToken`
  inserts the replacement with the same settings and the original lifetime
  counted from now (capped by the current policy) and deletes the old row in
  one transaction; `rotateServiceAccount` swaps the hash in place. The
  `token-expiry` job claims `notification_state` key
  `token.expiring:<pat|sa>:<id>` with `INSERT … ON CONFLICT DO NOTHING
  RETURNING`, so each credential is warned once (a rotated PAT is a new row;
  state rows whose expiry left the window are deleted at the end of a run).
  Signing keys: `generateSigningKey` makes a P-256 pair, kid = fingerprint
  (hex SHA-256 of the PKIX DER, the convention `/internal/v1/status` already
  used), private PEM encrypted with `lib/crypto.ts` under `AUTH_SECRET`,
  `activated_at = now`; `retireSigningKey` is refused for the newest active
  key; `activeSigner()` — the newest active database key (decrypted once
  per kid), else the file key — is looked up on every token request (one
  indexed row), so all replicas switch on the next request, and
  `signRegistryToken` puts the kid in the protected header.
  `checkTokenKeys` on the health page is green when the active signer's kid
  is among the registry's `trustedKeys`, distinguishing "not picked up yet"
  from a mismatch. Sessions: `settings/security` shows `auth.api.listSessions`
  with last activity and expiry; *Sign out everywhere else* calls
  `revokeOtherSessions`, the admin page `admin.revokeUserSessions`; both
  were already audited by `lib/auth-audit.ts`.
- **Webhooks** (`src/lib/webhooks.ts`, `webhooks-shared.ts`): hooks live in
  `repository_webhooks` with either `repository_id` or `organization_id`
  set (5 per repository, 10 per organization; `webhook_deliveries` is
  shared). `hooksForRepository(repoId, orgId)` = the repository's hooks +
  the organization's, each filtered by its `events` subscription;
  `emitRepositoryEvent(repoId, event, data)` and
  `emitOrganizationEvent(orgId, "quota.warning", data)` build the envelope
  (`event`, `deliveryId`, `timestamp`, `registry`, `repository | null`) and
  deliver — custom method, headers, auth (secrets encrypted with AES-GCM
  under a key derived from `AUTH_SECRET`, see `src/lib/crypto.ts`), HMAC
  signature, retries, and a bounded delivery log. Events: `push` (payload
  unchanged from earlier versions), `delete` (from registryd's
  `manifest.delete`, tag or digest), `scan.completed`, `scan.blocked`,
  `signature.blocked`, `mirror.completed`, `mirror.failed`,
  `retention.completed`, `repository.renamed`, `repository.transferred`
  (both with `previous { organization, name, path }`) and `quota.warning`
  (organization hooks only). *Send test* on an organization hook uses the
  most recently pushed tag of any repository in the organization.
- **Notifications** (`src/lib/notify.ts`, `notify-shared.ts`):
  `notify(input)` resolves recipients (owners/admins of the organization, or
  instance admins for `job.failed`), drops those who switched the event off
  in `notification_preferences` (defaults from the catalogue; only
  `scan.completed` is off), sends one mail per recipient through `sendMail`
  (logged when SMTP is not configured) and forwards organization-scoped
  events to webhooks; `webhook.failed`, `job.failed` and the account-scoped
  `token.expiring` (PAT → its owner, service account → the organization's
  managers) never fan out to webhooks. Hooked from `runJob` and the
  scheduler's stuck-run sweep (`job.failed`), `scan.ts` after a stored scan
  (`scan.completed`), `pull-policy.ts#refreshRepositoryBlocks` for digests
  that were not blocked before (`scan.blocked`, or `signature.blocked` when
  only the signature policy applies), `mirror.ts` (`mirror.failed` / the
  `mirror.completed` webhook), `webhooks.ts#deliverWebhook` after the last
  attempt (`webhook.failed`) and `token-expiry.ts`. `checkQuotaWarnings(orgId)` — after every
  `manifest.push`, after repository creation / visibility changes and after
  an admin saves organization limits — sends the highest crossed threshold
  (95 before 80) once per `quota.warning:<org>:<kind>:<threshold>` per 24 h;
  an `INSERT … ON CONFLICT DO UPDATE … WHERE sent_at < now() - 24h RETURNING`
  on `notification_state` makes the dedupe atomic across replicas.
- **Mirrors** (`src/lib/mirror.ts`, `src/lib/remote-registry.ts`): a small
  client for foreign registries (Bearer/Basic challenge handling, paginated
  tag lists, manifest/blob fetches) feeds an importer that pushes through
  registryd as a normal client with a `mirror:<id>` token — so quota, dedup,
  webhooks, scanning and tag rules behave exactly as for `docker push` (an
  immutable tag's refusal is recorded per tag). Selection
  (all/glob/regex/list + exclude) and relabelling (template + regex rewrite)
  are pure functions; every run is recorded in `mirror_runs` with a per-tag log.
- **Proxy caches** (`src/lib/proxy.ts`, `proxy-shared.ts`,
  `app/api/internal/proxies/route.ts`, `app/actions/proxy.ts`):
  `organization_proxies` holds `upstream_url`, `preset`
  (`dockerhub|ghcr|quay|custom`), encrypted `auth` (`user:password` or a
  bare token), `allowed_patterns`, `tag_ttl_seconds` (default 300),
  `enabled`, plus `last_error` / `last_checked_at` written by registryd. The
  internal route serves every row with decrypted credentials to registryd
  (bearer = `WEBHOOK_SECRET`), and every save calls
  `POST /internal/v1/proxies/reload`. `testUpstream` reuses
  `RemoteRegistry`; `evictProxyTags` backs the `proxy-evict` job
  (`tags.last_pulled_at` older than the window). Repository links are
  `/<org>/<encodeURIComponent(name)>` — Next decodes `%2F` inside the
  `[repo]` segment, so nested names survive routing.
- **Tag rules & retention** (`src/lib/tag-rules*.ts`, `retention*.ts`,
  `manifests.ts`, `tag-admin.ts`): `tag_rules` rows are org-wide when
  `repository_id` is null; `retention_policies` has
  `UNIQUE NULLS NOT DISTINCT (organization_id, repository_id)` (Postgres
  15+) — one org default plus at most one row per repository, and a
  repository row wins even when disabled. `planRetention` is a pure planner
  over the tags (age = `tags.updated_at`, the last push), the untagged
  manifests (age = `manifests.created_at`), the policy and the effective
  rules, returning deletions and kept entries with reasons; index children
  of a live index, referrers and images with referrers are never candidates.
  `runRetention` applies plans through `deleteTag({ moveLatest: false })`
  and `deleteManifestByDigest` (a delete-scoped token against registryd),
  records counts plus at most 300 detail lines, and emits
  `retention.completed`. Both the `retention` job (as `user:system`) and
  *Run now* on the settings pages go through `runJob`. `deleteTag` refuses
  protected tags before calling the registry, surfaces the registry's 403
  message, and leaves an immutable or protected `latest` alone.
- **Jobs** (`src/lib/jobs.ts`): `gc`, `reverify-signatures` (every organization or
  `organization=<slug>`; `reverifyOrganization` each), `scan-stale` (throws when scanning
  is off and is hidden from `listJobs()`, now async for that reason),
  `scan-normalize`, `exceptions-expire`, `token-expiry`, `prune-untagged`,
  `mirror-sync`, `proxy-evict`, `retention` — each run recorded in
  `job_runs` with its trigger (`user:<id>`, `api-token`, `schedule`); a
  failed run raises `job.failed`. Exposed on `/admin/jobs` and as
  `POST /api/jobs/<name>` for automation (bearer `JOBS_API_TOKEN` or an admin
  PAT with write scope and no organization restriction). Jobs are read from
  the `JOBS` registry, so a new job gets its API route and schedule block
  without further code.
- **Scheduler** (`src/lib/scheduler.ts`, started from
  `src/instrumentation.ts` on the Node runtime only, skipped during the
  production build): one row per job in `job_schedules` (`cron`, `params`,
  `enabled`, `timezone`, `last_run_at`, `next_run_at`, `last_status`);
  `cron-parser` does the parsing and next-run maths,
  `lib/schedule-shared.ts` the validation and plain-English preview shared
  with the form. Every 30 s a tick (1) takes or confirms
  `pg_try_advisory_lock(7261637)` on a dedicated `pg.Client` — session-level,
  so the replica holding it keeps it while the connection lives; the others
  log "standing by" and retry, and a dead lock connection is rebuilt —
  (2) marks `job_runs` still `running` after 6 hours as failed, (3) runs
  enabled schedules with `next_run_at <= now()` via
  `runJob(name, params, "schedule")`, skipping a job that already has a
  `running` row (`last_status = 'skipped: already running'`, `next_run_at`
  left in the past so it starts right after). Every step is wrapped; errors
  are logged and the interval keeps running. `JOB_SCHEDULER=false` disables
  the loop; `schedulerStatus()` feeds the status line on `/admin/jobs`.
- **Audit log** (`src/lib/audit.ts`, `audit-query.ts`, `audit-shared.ts`;
  table `audit_log` in `db/audit-schema.ts`, indexed on `created_at`,
  `(organization_id, created_at)`, `(actor_id, created_at)`):
  `recordAudit({ action, … })` fills the actor from the better-auth endpoint
  context or the request session, the impersonator, the IP
  (`x-forwarded-for` / `x-real-ip`) and the user agent, runs `details`
  through `redactDetails` (drops credential-looking keys, caps size) and
  never throws. Actions are dotted (`org.create`, `repo.visibility`,
  `auth.sign_in.failed`); `organization_id` is plain text without a FK so
  history outlives the organization. Server actions call it once per
  mutation; `lib/auth-audit.ts` covers better-auth through
  `hooks.before/after` (failed sign-ins, admin routes, password and passkey
  changes, session revocation, account link/unlink), `databaseHooks`
  (`auth.sign_up`, `auth.sign_in` with the method, 2FA toggles) and
  `organizationHooks`. CSV exports are logged as `audit.export`. Actions
  added by this generation: `repo.readme`, `repo.rename`, `repo.transfer`
  (recorded in both organizations), `org.rename`, `security.exception.create`
  / `.revoke`, `scan.rescan_all`, `signing_key.add` / `.remove`,
  `signature.reverify`, `token.rotate`, `admin.token.revoke`, `sa.rotate`,
  `keys.generate`, `keys.retire`, `repo.bulk_transfer` (one summary row per
  bulk run, under the existing `repo` group) and `image.copy` / `image.move`
  (written in both organizations, under the `image` group added to
  `AUDIT_ACTION_GROUPS` for them). Once an hour after an insert, rows older
  than `AUDIT_RETENTION_DAYS` are deleted. registryd never writes it.
- **Pictures** (`src/lib/logo-shared.ts`, `logo.ts`,
  `app/api/logo/[kind]/[id]/route.ts`, `app/actions/logos.ts`,
  `components/entity-logo.tsx`, `logo-upload.tsx`): an organization, a
  repository and a user each carry a picture in a column of their own row —
  better-auth's `organization.logo` and `user.image` plus the new nullable
  `repositories.logo` (`ALTER TABLE "repositories" ADD COLUMN "logo" text`,
  the only schema change; registryd neither reads nor writes it) — stored as a
  normalised `data:<type>;base64,<payload>` URL, the way branding already
  stores the instance logo. No new table, service, dependency or environment
  variable, and no image processing: nothing is resized, re-encoded or
  rasterised, which the 64 KB cap makes unnecessary.
  **Validation** is one implementation for all four pictures,
  `validateLogoDataUrl` in `branding-shared.ts`, run in the browser for live
  feedback and again in the server action, which is the check that counts:
  `LOGO_MEDIA_TYPES` (`image/png`, `image/svg+xml`, `image/jpeg`,
  `image/webp`), `LOGO_MAX_BYTES` (64 KB decoded), the real magic bytes of a
  PNG / JPEG / WebP, and for SVG the presence of `<svg` and the absence of
  `<script`, `javascript:`, an `on…=` handler, `<foreignobject`, `<iframe`,
  `<embed`, `<object` and an external `xlink:href` (a `#fragment` or an inline
  `data:image` reference is allowed). `parseLogoDataUrl` splits the URL into
  media type, whitespace-stripped base64 and bytes; `logo-shared.ts` re-exports
  it with the entity-side pieces (`LogoKind`, `LogoRef`, `logoSrc`, `logoRef`,
  `isLogoKind`) so client components never import a module that touches the
  database.
  **Serving**: `GET /api/logo/<kind>/<id>?v=<version>` answers the decoded
  bytes with the media type from the data URL (`; charset=utf-8` for SVG), a
  strong `ETag` — `"<md5 of the stored data URL>"`, a cache key rather than a
  security primitive — `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  sandbox`, so an SVG is served inert whatever got past the upload check; an
  `If-None-Match` carrying `*` or the tag (`W/` accepted) gets `304` with the
  same headers and no body. `Cache-Control` is
  `public, max-age=31536000, immutable`, except for a **private repository's**
  picture, which is `private, …` so a shared proxy cannot hand it to somebody
  without access. An unknown kind, a missing row, an empty column and a
  repository the caller may not read all answer the same `404`, so the route
  leaks nothing: `repository` is open when the repository is public and
  otherwise needs `getOrgRole` (instance admins included, as everywhere),
  `organization` and `user` need any session. `?v=` is the first
  `LOGO_VERSION_LENGTH` (8) hex digits of that same MD5 and is never
  validated — it exists so that replacing a picture changes the URL and the
  year-long cache entry is bypassed instead of revalidated.
  **Listings carry the version, never the bytes**: a 64 KB data URL repeated
  down a fifty-row table would put megabytes into the HTML, so the queries
  select `logoVersionSql(col)` = `substr(md5(<column>), 1, 8)` — `RepoListItem`,
  `OrgWithMeta`, `NavOrgs`, `AdminOrgRow`, `OrgHit`, `SearchHit`,
  `ActivityItem`, `listMembersWithUsers`, `listAdminUsers` and
  `getAdminUserDetail().memberships` each gained a nullable `logoVersion`
  (`logoVersionOf` computes the same in Node where the row is already loaded).
  `logoRef(kind, id, version)` turns it into the `LogoRef` that `EntityLogo`
  renders as an `<img>` at exactly `size` pixels, or — when it is null — as a
  same-sized `inline-flex` box holding the call site's own icon or the default
  (a `Container` glyph, an initial-letter circle for users), so rows line up
  whether or not a picture is set and nothing cascades: a repository never
  borrows its organization's picture. `LogoUploadCard` is the only place a
  data URL is inlined, and only for the single entity a settings page is
  about.
  **Writing**: five server actions in `app/actions/logos.ts` —
  `saveOrganizationLogo` and `saveRepositoryLogo` (`MANAGER_ROLES` in the
  owning organization), `saveUserAvatar` (the caller on themselves), and the
  `requireAdmin` `adminSaveOrganizationLogo` / `adminSaveUserAvatar` — take
  one `logoDataUrl` field, empty meaning *remove*, validate it, store the
  normalised whitespace-free form so identical bytes always hash to the same
  version, `revalidatePath` the pages that show the picture and record an
  audit row (`org.logo`, `repo.logo`, `user.avatar`, `admin.org.logo`,
  `admin.user.avatar`) with `{ mediaType, bytes }` or `{ removed: true }`,
  plus `by: "admin"` for the two admin variants.
- **Branding** (`src/lib/branding.ts`, `branding-shared.ts`; settings section
  `branding`, env defaults `INSTANCE_NAME`, `INSTANCE_TAGLINE`): the logo goes
  through the same `validateLogoDataUrl` as the entity pictures (see
  *Pictures* above; the branding file input offers PNG and SVG) and is stored
  as a data URL inside the settings JSON — the one picture that *is* inlined,
  since it is on every page anyway. `getBranding` reads `headers()` before
  touching the database so the root layout stays buildable, and falls back to
  defaults on any error; it feeds `generateMetadata`, the `--brand` accent on
  `<body>`, `components/brand.tsx` (`BrandMark`, `BrandLockup`) and
  `mailLayout`. The announcement bar's dismissal is a FNV-1a hash of level +
  text in `localStorage`; `danger` is never dismissible.
- **Health** (`src/lib/health.ts`): `runHealthChecks()` for `/admin/health`
  and `quickHealth()` for `GET /api/health` (database + registry ping, `ok`
  / `degraded`, no internals). Every check is wrapped in a 3-second timeout
  and a catch-all that turns exceptions into a red card. The registry check
  reads `/internal/v1/status` (staging mode and in-flight sessions included;
  the staging-disk check is not applicable in shared mode) and the keys
  check compares the active signer with the registry's `trustedKeys`. The
  scanner card comes from `scanner.health()`: Clair's `/healthz` lives on
  its introspection port, so the probe falls back to
  `GET /indexer/api/v1/index_state`, with updater freshness from
  `GET /matcher/api/v1/internal/update_operation` (newest `date` across
  updaters, warn after 48 h or when no updater has run); Trivy runs
  `trivy version --format json` (binary + local database age) and, in
  client mode, `GET <server>/healthz`. Postgres: `pg_database_size`,
  `pg_stat_activity` vs `max_connections`, and the
  `drizzle.__drizzle_migrations` row count.
- **Administration**: `/admin/users/[id]` and `/admin/organizations/[id]`
  manage roles, bans, limits (`user_limits`, `organization_limits`),
  memberships, repositories and proxy configuration directly in the database
  (admins are not org members, so better-auth's member-scoped endpoints
  don't apply). Impersonation uses better-auth's admin plugin; the session
  carries `impersonatedBy`, which the app layout turns into a persistent
  banner. Instance settings (`lib/instance-settings.ts`) are sections of
  `instance_settings` — `smtp`, `github`, `google`, `oidc`, `ldap`,
  `bindings`, `metrics`, `access` (sign-up controls and token policy),
  `branding`, `ratelimit`, `scanner` — merged over the environment; only
  `ratelimit` and `metrics` (`enabled` + `tokenHash`) are read by registryd.
- **Statistics**: pulls/day (zero-filled series from `events`); egress /
  ingress / redirected bytes per day, per repository and per organization
  summed from `repository_traffic` at read time (`lib/admin-stats.ts`,
  `lib/data.ts`; `lib/metrics.ts` exposes
  `chicoree_repository_{egress,ingress,redirect}_bytes_total{organization,repository}`
  and `chicoree_traffic_bytes_total{direction}`); storage per-repo/org
  (linked-blob sums), instance-wide physical vs logical bytes (dedup
  savings), and per-image layer breakdowns (sizes + Dockerfile instructions
  reconstructed from the cached image config history, `lib/compare-shared.ts`).
  `addOperationalMetrics` appends, from a second `Promise.all` of aggregate
  queries, `chicoree_job_last_run_status{job,status}` (one-hot from
  `DISTINCT ON (job)` over `job_runs`),
  `chicoree_job_last_success_timestamp_seconds{job}`,
  `chicoree_vulnerability_scan_pending_oldest_seconds`,
  `chicoree_webhooks_failing`, `chicoree_webhook_deliveries_recent{status}`
  (last hour), `chicoree_mirror_last_status{status}`,
  `chicoree_proxy_organizations{enabled}` / `_failing`,
  `chicoree_organization_storage_{bytes,limit_bytes,ratio}{organization}`
  (organizations with a limit; `bytes` is the same distinct-blob sum as
  registryd's quota check), `chicoree_events_today{type}`,
  `chicoree_traffic_today_bytes{direction}`, `chicoree_audit_events_total`,
  `chicoree_rate_limit_config_info{anonymous,authenticated,source}` and
  `chicoree_scanner_up{backend}` — all computed at scrape time.
  `deploy/prometheus/` (example config + 18 alert rules, checked with
  `promtool`), `deploy/grafana/chicoree.json` (uid `chicoree-registry`,
  `DS_PROMETHEUS` input plus `web_job` / `registryd_job` variables so it
  imports through the UI and provisions from file) and
  `docker-compose.observability.yml` (profile `observability`, Prometheus
  and Grafana on loopback) are the ready-made consumers.

## REST API (`/api/v1`)

The management API lives in `web/src/app/api/v1/**/route.ts` on top of
`web/src/lib/api/`:

- `catalog.ts` — **the single description of the API**: one entry per route
  handler with method, path, group, summary, who may call it, parameters and
  an example response. Everything user-facing is rendered from it: the JSON
  index (`GET /api/v1`), the OpenAPI 3.1 document (`openapi.ts` →
  `GET /api/v1/openapi.json`, response schemas inferred from the examples),
  the in-app browser (`app/(app)/docs/api`, a client component that sends
  real requests with the session or a pasted token) and the Markdown guide
  (`docs.ts` → the *Guide* tab and, via `scripts/api-docs.mts`, the
  repository's `API.md`).
- `version.ts` — `API_VERSION` (path prefix), `API_REVISION` and the
  changelog, plus the notice that the API follows the features. **Every
  feature change that touches the API bumps the revision and adds a
  changelog line**; `npm run lint` (`api:check`) fails when a route has no
  catalog entry, a catalog entry has no route, or `API.md` is stale.
- `auth.ts` — the caller: `Authorization: Bearer` (or Basic with the secret
  as password) resolves personal access tokens and service accounts through
  `lib/credential-auth.ts` (expiry, last-use bookkeeping, restrictions);
  without a header the better-auth session cookie counts; else anonymous. A
  malformed or unknown header is a `401`, never a fall-through.
- `access.ts` — visibility and rights as SQL filters (`repoFilter`,
  `orgFilter`) and loaders (`loadOrg`, `loadRepo`) that answer `404` for
  anything the caller may not see. Users get the UI's rules (public +
  member organizations, admins everything) narrowed by a token's
  organization / repository restriction; service accounts get public +
  their organization (or list). `manage` = owner/admin with a write token;
  `delete` = manage, or an `admin` service account. The `require*` helpers
  word the `403` for the credential in use (read-only token, restriction,
  role).
- `respond.ts` / `handler.ts` — `ApiError` → `{ error, code }` with the
  status, `X-Api-Version` / `X-Api-Revision` headers, `page` / `per_page`
  paging into `{ items, page, perPage, total, pages }`, and the `route()`
  wrapper that authenticates, resolves params and logs unexpected errors as
  `500`. The wrapper (and the JSON 404 catch-all) first reads
  `access.apiEnabled` from the instance settings (env default
  `API_ENABLED`, switch on *Administration → Auth providers → Access*) and
  answers `403 api_disabled` while the API is off; the app layout, the
  docs page (a 404 while off) and the tokens page read the same flag to
  hide the API entry points.
- `queries.ts` / `serialize.ts` — the few reads the UI libraries do not
  offer (organization lists filtered by caller, the image document with
  config, layers, variants, scan, signature and block) and the row → JSON
  mappers whose field names are the contract.

- `rate-limit.ts` / `stats.ts` / `match.ts` — fixed-window request limits
  counted in `rate_limit_counters` under an `api|` key prefix (shared with
  registryd's pull limits, so every replica sees one budget; administrators
  exempt), request counters buffered per process and flushed to
  `api_request_stats` for `chicoree_api_requests_total`, and the request →
  catalog matcher that labels metrics and emits `Deprecation` / `Sunset` /
  `Link` headers for entries with `deprecated` set.
- `exports.ts` — SARIF 2.1.0 and CycloneDX 1.5 VEX renderings of an
  image's findings (`?format=` on the vulnerabilities endpoint); pure.
- `revision-notice.ts` — the acknowledged API revision (an
  `instance_settings` row of its own) behind the "API changed" card on the
  administration overview.
- `handler.ts` also computes a weak `ETag` over successful GET bodies and
  answers `304` to a matching `If-None-Match`.
- `scripts/api-smoke.mts` — contract tests that seed rows directly and run
  the request matrix against a running app; `.github/workflows/ci.yml` runs
  them against a Postgres service after `npm run lint` and `next build`.
- `scan-gate.ts`, `copy.ts`, `webhooks.ts`, `service-accounts.ts` — the
  pipeline-facing operations (wait for a scan and judge it, promote an image,
  manage hooks and service accounts) built on the same libraries as the UI.
- `lib/ci-auth.ts` — keyless CI: verifies a workflow's OIDC token against
  its issuer's JWKS (only issuers in `ci_identities_trusted` are contacted),
  matches issuer + subject pattern, and mints `chc_ci_` HMAC JWTs (key
  derived from `AUTH_SECRET`, ≤ 1 h) that the API and the docker token
  endpoint resolve to a service-account-shaped caller (`sa:ci:<identity>`
  as registry subject). Deleting the identity revokes its tokens.

Writes reuse the libraries the server actions use (`lib/tag-admin.ts`,
`lib/manifests.ts`, `lib/rescan.ts`, quotas, redirects, audit) so the API
and the UI cannot diverge in behaviour; API changes are audited with the
token's user as actor and `"via": "api"` in the details. The jobs API
(`/api/jobs*`) and the internal routes stay separate.

## Credentials at a glance

| Credential | Prefix | Scope | Expiry & restrictions | Created in |
| --- | --- | --- | --- | --- |
| Personal access token | `chc_pat_` | acts as the user; `read` or `write`; authenticates docker login and the REST API (`/api/v1`); admins' unrestricted write tokens also unlock the jobs API | 7 / 30 / 90 / 365 days, custom date or never (within the instance policy); optionally limited to one organization and, within it, a repository list — restricted tokens get no catalog grant and cannot auto-create repositories; *Rotate* = new token, old one revoked | Settings → Access tokens |
| Service account | `chc_sa_` | one org; `pull` / `push` / `admin` (+delete), optional repo allowlist; reads its organization through the REST API, `admin` may delete tags and images there | same expiry rules; *Rotate* swaps the secret in place (same id) | Org → Service accounts |

Only sha256 hashes are stored; secrets are displayed once at creation; the
last use (time and client IP) is recorded at most every five minutes, and
expired credentials are refused at the token endpoint and the jobs API.
Tokens minted for instance administrators always carry `registry:catalog:*`;
`repository:<name>:*` expands to every action the caller may perform;
callers who may push get `push` on pull-only requests; in proxy-cache
organizations every credential gets `pull` only, and so does every request
for a repository's former name. Internal callers use fixed subjects —
`user:system` (the app's own reads, retention, the scanners' two-hour pull
token, artifact blob loads) and `mirror:<id>` — which registryd exempts from
pull rate limits, as it does the reserved `proxy:` prefix; proxy fetches
themselves run inside registryd and carry no token. Registry JWTs are signed
by the newest active key in `token_signing_keys`, else the file key; the
`kid` header tells registryd which one.

## Notes & known trade-offs

- Clair is pinned to 4.8.0 — 4.9.0's OSV updater panics on current upstream
  data. Fresh installs report few/no findings until Clair finishes syncing
  its vulnerability databases (minutes to an hour). Trivy (0.74.0, a static
  binary copied into the web image) needs its database download on the
  first scan; standalone mode keeps one database per web replica unless a
  Trivy server is configured.
- Scan rows written before the normalised `findings` column exist are
  converted lazily on first view or by the `scan-normalize` job; the
  normaliser is TypeScript, so there is no SQL backfill.
- Keyless signatures verify against the vendored public Sigstore root only
  (or the file `SIGSTORE_TRUSTED_ROOT` names); the root is not refreshed
  from TUF at runtime, so a key rotation upstream needs a new snapshot.
  Legacy tag-convention signatures made without a Rekor entry cannot be
  verified at all (the certificate has long expired), and keyless
  signatures count for the policy only through a trusted identity.
- The web app's Content-Security-Policy allows inline styles
  (`style-src 'unsafe-inline'`) for style attributes and any https image
  for READMEs; scripts are nonce-only. `_global-error` is prerendered
  without a nonce and renders without its scripts.
- Docker-login throttling counts failures per address and per account; a
  proxy that hides client addresses (no `X-Forwarded-For`) makes every
  client share one address budget of thirty failures per fifteen minutes.
- Manifest DELETE removes the manifest row; blob bytes are reclaimed by the
  next GC pass, never inline.
- The registry enforces exactly two-level names (`<org>/<repo>`), except in
  proxy-cache organizations, where the upstream path may be deeper.
- A single-image copy is not transactional. When a manifest push fails after
  some blobs were mounted, the destination keeps those links; they cost no
  storage (the content is shared) and GC reclaims whatever ends up
  unreferenced.
- A bulk repository move runs the moves sequentially and is capped at 50 per
  run, so each one commits before the next is checked and the target's quotas
  are never measured against an estimate. Only the preview simulates a batch,
  and changing the selection discards it.
- Pull rate-limit counters live in Postgres, so replicas share one budget at
  the cost of one row upsert per limited request. The traffic counter and the
  `/metrics` counters are still process-local: a crash loses at most 10 s of
  traffic statistics, and Prometheus must scrape every replica. The proxy
  cache's per-digest singleflight is also per replica.
- Shared upload staging costs one extra backend write and read per uploaded
  (or proxied) blob and, on S3, a `DeleteObject` per chunk after commit; a
  mixed local/shared fleet behaves like local.
- Only one web replica runs job schedules at a time (advisory lock); the
  others stand by and take over when its connection drops.
- Entity pictures live in Postgres as data URLs rather than in blob storage.
  The 64 KB cap keeps the rows small and listings read only an 8-hex version,
  but every picture is a database read, and the route's year-long `immutable`
  caching means a replaced picture is only picked up because its URL changes.
- Search is `ILIKE`-based and works on a plain database; large instances
  should add the `pg_trgm` indexes by hand.
- `AUTH_DISABLED=true` on registryd turns every request into an admin — a
  dev-only escape hatch, loudly logged at startup.
