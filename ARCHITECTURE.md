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
                           back through registryd with a pull token

   registryd ──► upstream registries (Docker Hub, GHCR, Quay, …) on a cache
                 miss in a proxy-cache organization; stored like a push
```

## Token auth (Docker's standard flow)

1. A client hits `registryd`; without a valid token it gets `401` with
   `WWW-Authenticate: Bearer realm=<web>/api/registry/token, service=…, scope=…`.
2. The client calls the realm with Basic credentials. The web app identifies
   the caller — personal access token (`chc_pat_…`), service-account secret
   (`chc_sa_…`), or email+password (refused when the account has 2FA) — checks
   each requested scope against org membership / SA permissions / repository
   visibility, and returns a 5-minute ES256 JWT whose `access` claim lists
   exactly what was granted.
3. `registryd` verifies the signature with the public key
   (`secrets/registry-token.pub`) and enforces `access` per route. It holds no
   credential state of its own; revoking a PAT/SA takes effect within the
   token TTL.

Grants: org `owner`/`admin` → `pull,push,delete`; `member` → `pull,push`;
`viewer` → `pull` (private repositories included); anonymous / non-members →
`pull` on public repositories only; instance admins → everything plus
`registry:catalog:*`. Roles are declared once in `web/src/lib/org-roles.ts`
through better-auth's organization access control and shared by server,
client and the token service. Repositories are auto-created on first push
(private) when the pusher may write to the org namespace.

Three refinements: a `*` action (`repository:<name>:*`, what `skopeo delete`
requests) expands to every valid action and is then filtered by what the
caller may do; repositories in proxy-cache organizations grant `pull` only,
and one the proxy has not created yet counts as the organization's default
visibility for anonymous access (`lib/access.ts`); instance admins always
receive `registry:catalog:*`, which `registryd` also uses to recognise them
for the rate-limit exemption.

## registryd (Go, no framework)

- **Names**: `<org>/<repo>` or a bare `<repo>`, which resolves to the
  `library` organization (`nginx` ≡ `library/nginx`). Proxy-cache
  organizations are the one exception to the two-level rule:
  `<org>/<a>/<b>/…` is accepted there, the repository being everything before
  the first route marker (`manifests`, `blobs`, `tags`, `referrers`), and
  Docker Hub proxies canonicalize `library/x` → `x`
  (`internal/upstream/names.go`) while the token scope keeps the name the
  client asked for. The token service and the UI apply the same rules
  (`web/src/lib/proxy-shared.ts`).
- **Routes**: the full distribution spec — blob get/head/delete, uploads
  (chunked PATCH + monolithic POST, cross-repo mount, resume, cancel),
  manifests (image + index, tag or digest refs), `tags/list`, `referrers`
  (with `artifactType` filter), `_catalog` (admin-gated) — plus the internal
  API, bearer = `WEBHOOK_SECRET` except for `healthz`:
  `GET /internal/v1/healthz`, `GET /internal/v1/status` (build version from
  `internal/version.Version`, set with `-ldflags -X` / the Dockerfile's
  `ARG VERSION`; Go version, storage driver, staging dir and its free bytes,
  blob count and physical bytes, start time and uptime, the hex SHA-256
  fingerprint of the trusted public key's PKIX DER, `authDisabled`, and
  `status: degraded` plus `databaseError` when the database is unreadable),
  `POST /internal/v1/gc` and `POST /internal/v1/proxies/reload`.
- **Content addressing**: blob bytes are stored once per digest
  (`blobs/sha256/ab/<hex>`); *repository membership* lives in
  `repository_blobs`, which is also the ACL boundary — a blob is only served
  through repositories it is linked to, so dedup never leaks private content.
- **Uploads** are staged on local disk and only handed to the storage driver
  after the digest verifies, so partial pushes never pollute the backend.
  (Sessions are node-local: scale-out needs sticky routing on
  `/blobs/uploads/` or a shared staging volume.)
- **Storage plugins**: backends register themselves with
  `storage.Register` in `init()` (the `database/sql` driver pattern) and are
  selected by name; options resolve from `<NAME>_*` environment variables.
  Bundled: `filesystem`, `s3` (any S3-compatible endpoint, optional presigned
  redirects) and `bunny` (bunny.net Edge Storage; uploads carry the SHA256
  `Checksum` header so the zone verifies content; optional signed pull-zone
  redirects). `registryd plugins` documents them. Each lives in its own
  package under `internal/storage/<name>`.
- **Default visibility**: repositories auto-created by a push take the
  organization's `organization_settings.default_visibility`, else the
  pushing user's `user_settings.default_visibility`, else private — and the
  matching repository quota is checked before anything is written.
- **Quotas**: before committing a blob (or mounting one into another org)
  and before auto-creating a repository, `registryd` checks the organization's
  limits and every owner's account limits (`internal/store/quota.go`) and
  answers `403 DENIED` with the reason. The web app applies the same rules
  (`web/src/lib/quota.ts`) when repositories or organizations are created
  through the UI.
- **Manifests** are stored verbatim in Postgres (`manifests.payload`) —
  digests must verify byte-for-byte — together with parsed metadata
  (media type, config digest, subject digest for referrers) and an explicit
  reference table (`manifest_refs`) that drives GC and layer statistics.
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
  `mirror:*`, `proxy:*`. Fixed window per key (starts with the first request,
  expired keys swept once per window), process-local — limits are per
  replica. The client address is the last `X-Forwarded-For` hop only when the
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
  to the web app (config caching, repository webhooks, Clair scan — with
  Clair on, the scan pulls every layer through registryd and thereby
  prefetches them). Storage quotas are checked before a download when the
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
- **Webhook**: manifest pushes/deletes POST an HMAC-signed event to the web
  app, which caches the image config, fans out webhooks and kicks off
  scanning. `manifest.delete` is posted for tag deletes too (with the digest
  the tag pointed at, resolved before the delete) and carries `tags` — every
  tag that pointed at a manifest deleted by digest.
- **GC** (`POST /internal/v1/gc`, bearer = webhook secret, optional
  `?grace=30m`): drop repo→blob links no manifest references, delete blob
  rows with zero links, remove their bytes from storage, sweep stale upload
  sessions. The grace window (default 1h) protects pushes in flight.

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
  `last_checked_at`), `repository_traffic` (sole writer) and
  `instance_settings` (the `ratelimit` row). Web-only additions of this
  generation: `audit_log` (`db/audit-schema.ts`), `job_schedules`,
  `notification_preferences`, `notification_state`, `retention_policies`,
  and `repository_webhooks.organization_id` (with `repository_id` now
  nullable) for organization hooks.
- **Data flow**: server components query Postgres directly (`src/lib/data.ts`);
  mutations are server actions with per-org role checks; better-auth handles
  org/member/invitation/2FA/passkey flows through its own client API.
- **Scanning** (`src/lib/scan.ts`): on push (webhook) or on demand (Re-scan),
  the app submits the manifest's layers to Clair's indexer — Clair fetches
  the layers straight from registryd using a system pull token — polls
  indexing, then stores the matcher's report plus a per-severity summary in
  `vulnerability_scans` (keyed by digest: scans are content-addressed and
  shared across repos). Index (multi-arch) manifests aggregate their
  children's scans in the UI.
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
  `mirror.completed`, `mirror.failed`, `retention.completed` and
  `quota.warning` (organization hooks only). *Send test* on an organization
  hook uses the most recently pushed tag of any repository in the
  organization.
- **Notifications** (`src/lib/notify.ts`, `notify-shared.ts`):
  `notify(input)` resolves recipients (owners/admins of the organization, or
  instance admins for `job.failed`), drops those who switched the event off
  in `notification_preferences` (defaults from the catalogue; only
  `scan.completed` is off), sends one mail per recipient through `sendMail`
  (logged when SMTP is not configured) and forwards organization-scoped
  events to webhooks; `webhook.failed` and `job.failed` never fan out to
  webhooks. Hooked from `runJob` and the scheduler's stuck-run sweep
  (`job.failed`), `scan.ts` after a stored scan (`scan.completed`),
  `pull-policy.ts#refreshRepositoryBlocks` for digests that were not blocked
  before (`scan.blocked`), `mirror.ts` (`mirror.failed` / the
  `mirror.completed` webhook) and `webhooks.ts#deliverWebhook` after the
  last attempt (`webhook.failed`). `checkQuotaWarnings(orgId)` — after every
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
- **Jobs** (`src/lib/jobs.ts`): `gc`, `scan-stale`, `prune-untagged`,
  `mirror-sync`, `proxy-evict`, `retention` — each run recorded in
  `job_runs` with its trigger (`user:<id>`, `api-token`, `schedule`); a
  failed run raises `job.failed`. Exposed on `/admin/jobs` and as
  `POST /api/jobs/<name>` for automation (bearer `JOBS_API_TOKEN` or an admin
  PAT with write scope). Jobs are read from the `JOBS` registry, so a new
  job gets its API route and schedule block without further code.
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
  `organizationHooks`. CSV exports are logged as `audit.export`. Once an hour
  after an insert, rows older than `AUDIT_RETENTION_DAYS` are deleted.
  registryd never writes it.
- **Branding** (`src/lib/branding.ts`, `branding-shared.ts`; settings section
  `branding`, env defaults `INSTANCE_NAME`, `INSTANCE_TAGLINE`): the logo is
  validated (PNG magic bytes, or SVG without `<script>`, event handlers,
  `foreignObject` or external references; ≤ 64 KB) and stored as a data URL
  inside the settings JSON. `getBranding` reads `headers()` before touching
  the database so the root layout stays buildable, and falls back to defaults
  on any error; it feeds `generateMetadata`, the `--brand` accent on
  `<body>`, `components/brand.tsx` (`BrandMark`, `BrandLockup`) and
  `mailLayout`. The announcement bar's dismissal is a FNV-1a hash of level +
  text in `localStorage`; `danger` is never dismissible.
- **Health** (`src/lib/health.ts`): `runHealthChecks()` for `/admin/health`
  and `quickHealth()` for `GET /api/health` (database + registry ping, `ok`
  / `degraded`, no internals). Every check is wrapped in a 3-second timeout
  and a catch-all that turns exceptions into a red card. The registry check
  reads `/internal/v1/status` and compares its public-key fingerprint with
  the one derived from `JWT_PRIVATE_KEY_FILE` with node's `crypto`. Clair's
  `/healthz` lives on its introspection port, so the probe falls back to
  `GET /indexer/api/v1/index_state`; updater freshness comes from
  `GET /matcher/api/v1/internal/update_operation` (newest `date` across
  updaters, warn after 48 h or when no updater has run). Postgres:
  `pg_database_size`, `pg_stat_activity` vs `max_connections`, and the
  `drizzle.__drizzle_migrations` row count.
- **Administration**: `/admin/users/[id]` and `/admin/organizations/[id]`
  manage roles, bans, limits (`user_limits`, `organization_limits`),
  memberships, repositories and proxy configuration directly in the database
  (admins are not org members, so better-auth's member-scoped endpoints
  don't apply). Impersonation uses better-auth's admin plugin; the session
  carries `impersonatedBy`, which the app layout turns into a persistent
  banner. Instance settings (`lib/instance-settings.ts`) are sections of
  `instance_settings` — `smtp`, `github`, `google`, `oidc`, `ldap`,
  `bindings`, `metrics`, `access`, `branding`, `ratelimit` — merged over the
  environment; only `ratelimit` is read by registryd.
- **Statistics**: pulls/day (zero-filled series from `events`); egress /
  ingress / redirected bytes per day, per repository and per organization
  summed from `repository_traffic` at read time (`lib/admin-stats.ts`,
  `lib/data.ts`; `lib/metrics.ts` exposes
  `chicoree_repository_{egress,ingress,redirect}_bytes_total{organization,repository}`
  and `chicoree_traffic_bytes_total{direction}`); storage per-repo/org
  (linked-blob sums), instance-wide physical vs logical bytes (dedup
  savings), and per-image layer breakdowns (sizes + Dockerfile instructions
  reconstructed from the cached image config history).

## Credentials at a glance

| Credential | Prefix | Scope | Created in |
| --- | --- | --- | --- |
| Personal access token | `chc_pat_` | acts as the user; `read` or `write`; admins' write tokens also unlock the jobs API | Settings → Access tokens |
| Service account | `chc_sa_` | one org; `pull` / `push` / `admin` (+delete), optional repo allowlist & expiry | Org → Service accounts |

Only sha256 hashes are stored; secrets are displayed once at creation.
Tokens minted for instance administrators always carry `registry:catalog:*`;
`repository:<name>:*` expands to every action the caller may perform; in
proxy-cache organizations every credential gets `pull` only. Internal
callers use fixed subjects — `user:system` (the app's own reads, retention)
and `mirror:<id>` — which registryd exempts from pull rate limits, as it does
the reserved `proxy:` prefix; proxy fetches themselves run inside registryd
and carry no token.

## Notes & known trade-offs

- Clair is pinned to 4.8.0 — 4.9.0's OSV updater panics on current upstream
  data. Fresh installs report few/no findings until Clair finishes syncing
  its vulnerability databases (minutes to an hour).
- Manifest DELETE removes the manifest row; blob bytes are reclaimed by the
  next GC pass, never inline.
- The registry enforces exactly two-level names (`<org>/<repo>`), except in
  proxy-cache organizations, where the upstream path may be deeper.
- Pull rate-limit counters and the traffic counter are process-local: with
  several registryd replicas each has its own budget, and a crash loses at
  most 10 s of traffic statistics.
- Only one web replica runs job schedules at a time (advisory lock); the
  others stand by and take over when its connection drops.
- `AUTH_DISABLED=true` on registryd turns every request into an admin — a
  dev-only escape hatch, loudly logged at startup.
