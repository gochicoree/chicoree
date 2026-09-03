# Pull-through proxy cache

Work-in-progress notes for the `proxy` feature. Section (a) is README-ready,
section (b) is ARCHITECTURE-ready.

## (a) README: Proxy caches

An organization can be turned into a **pull-through cache** of an upstream
registry — Docker Hub, GHCR, Quay, or any registry that speaks the OCI
distribution API (another Chicorée included). Pulling
`<registry>/<proxy-org>/<upstream path>:<tag>` serves the image from the local
cache when it is present and fresh; otherwise the registry fetches the
manifest and layers from the upstream on demand, stores them exactly like a
push (deduplication, quotas, the event log, webhooks, vulnerability scanning
and the pull policy all apply) and serves them. Later pulls — from any host in
your network — never leave the registry.

```sh
# Docker Hub proxy in the "dockerhub" organization
docker pull cr.example.com/dockerhub/alpine:3.20          # docker.io/library/alpine
docker pull cr.example.com/dockerhub/library/alpine:3.20  # same repository
docker pull cr.example.com/dockerhub/bitnami/redis:7.4    # docker.io/bitnami/redis

# GHCR proxy in the "ghcr" organization
docker pull cr.example.com/ghcr/oras-project/oras:v1.2.0
```

**Setting it up.** Tick *Make this a proxy cache* on *New organization* and
pick the upstream (Docker Hub, GitHub Container Registry, Quay.io or a custom
URL), or open *Organization → Settings → Proxy* on an existing one. The tab
holds:

- the upstream (a preset fills in the API URL; `https://registry-1.docker.io`
  for Docker Hub);
- optional **credentials** (username + password or access token; stored
  encrypted and never shown again — the tab only says *configured*). A bare
  token without a username is sent as the Basic password;
- **Allowed images**: space-separated globs on the upstream path
  (`library/* bitnami/redis`; `*` also matches slashes). Empty allows
  everything; anything else answers `403 DENIED` with the pattern that
  failed;
- **Tag freshness** (default 300 s): how long a cached `tag → digest`
  mapping is trusted. After that the next pull revalidates the tag against
  the upstream with a `HEAD` request (free on Docker Hub) and only downloads
  when the digest changed. Pulls by digest never re-check;
- **Fetch from the upstream** (pause switch): unticked, cached images stay
  pullable but nothing new is fetched;
- **Test upstream**: contacts the upstream with the values in the form (a
  `HEAD` of `library/alpine:latest` on Docker Hub, which also reports the
  remaining pull quota; `/v2/` elsewhere);
- the outcome of the latest upstream contact (*last error*).

**Names.** The repository name is the upstream path, so it may have several
components (`bitnami/redis`, `org/team/app`). Docker Hub's *library* images
are stored under their short name: `dockerhub/nginx` and
`dockerhub/library/nginx` are the same repository, shown as `dockerhub/nginx`.
Only proxy organizations accept names deeper than `<org>/<repo>`.

**Access.** Nobody can push into a proxy organization — the proxy fills it.
Cached repositories take the organization's default visibility (*Settings →
Policies*; the *New organization* shortcut sets it to public), so anonymous
`docker pull` works as on the upstream when it is public. Members and service
accounts get pull only; the pull policy still blocks vulnerable images.

**Docker Hub rate limits.** Anonymous pulls are limited per IP (100 per six
hours at the time of writing; the cache counts as one client for your whole
network). Add a Docker Hub account or a read-only access token under
*Settings → Proxy* to raise the limit; the registry answers
`429 TOOMANYREQUESTS` with a hint when the upstream refuses.

**When the upstream is down.** Cached tags keep working — a failed
revalidation serves the cached image and records the error on the proxy.
Images that were never cached fail with `502` and the upstream's reason.

**Eviction.** The `proxy-evict` job (*Administration → Jobs*, or
`POST /api/jobs/proxy-evict?unusedFor=30d`) removes tags in proxy
organizations that nobody pulled within the window (`dryRun=true` only
counts). They are fetched again on the next pull; run `prune-untagged` and
`gc` afterwards to reclaim the space.

## (b) ARCHITECTURE notes

**Table `organization_proxies`** (one row turns an organization into a
proxy): `organization_id` PK → organization, `upstream_url`, `preset`
(`dockerhub|ghcr|quay|custom`), `auth` (encrypted `user:password` or bare
token, `lib/crypto.ts`), `allowed_patterns`, `tag_ttl_seconds` (default
300), `enabled`, `created_by`, `created_at`, `updated_at`, `last_error`,
`last_checked_at` (the last two are written by registryd). **`tags`** gained
`proxy_checked_at` (when the upstream last confirmed the tag) and
`last_pulled_at` (any manifest request by tag in a proxy org; eviction key).
`events.actor_type` gained the values `proxy` and `mirror`; proxied
manifests are stored with `pushed_by = 'proxy'`.

**Configuration flow.** Credentials are encrypted with the web app's key, so
registryd never reads `organization_proxies` for configuration. It calls
`GET {INTERNAL_API_URL}/proxies` (bearer = `WEBHOOK_SECRET`; `INTERNAL_API_URL`
defaults to `WEBHOOK_URL` minus its last path segment, i.e.
`…/api/internal`) which returns every proxy — enabled or not, disabled ones
still route nested names — with decrypted credentials, and caches the result
for 60 s (`internal/api/proxy.go`, `proxyRegistry`). The cache is refreshed
early on an upstream 401, on a miss for a nested name (throttled to once per
5 s), and immediately by `POST /internal/v1/proxies/reload` (bearer =
webhook secret), which the web app calls after every save. Per-slug upstream
clients (and their cached tokens) survive refreshes when the URL and
credentials are unchanged.

**Routing** (`internal/api/router.go`). `<org>/<a>/<b>/…/<marker>/…` is
accepted only when `<org>` is a proxy; the repository is everything before
the first route marker (`manifests`, `blobs`, `tags`, `referrers`). Other
organizations keep the exact two-level rule. In `withAuth` the repository is
canonicalized for Docker Hub proxies (`library/x` → `x`,
`internal/upstream/names.go`); the token scope keeps the name the client
asked for. The token endpoint applies the same mapping (`lib/proxy-shared.ts`,
`lib/access.ts`): nested names are refused for non-proxy organizations,
proxy repositories grant `pull` only (users, admins and service accounts
alike), and a repository the proxy has not created yet counts as the
organization's default visibility for anonymous access.

**Fetch path** (`internal/upstream`, `internal/api/proxy.go`).
`upstream.Client` handles `WWW-Authenticate` challenges (Bearer: token from
the realm with `service`/`scope`, Basic auth to the realm when credentials
exist, anonymous Docker Hub tokens; Basic: remembered), caches tokens per
scope, retries connection errors and 5xx, verifies manifest digests, follows
blob redirects (Go drops `Authorization` on cross-host redirects, as CDNs
require) and logs every upstream request (`proxy: upstream request`).

- Manifest GET/HEAD by tag: fresh local tag (`proxy_checked_at` within the
  TTL) → serve. Else `HEAD` upstream; same digest → touch and serve; different
  or nothing local → `GET`, store, serve. A first fetch skips the `HEAD`.
  Upstream failure with a local copy → serve stale and record `last_error`;
  with nothing local → 404/403/429/502 mapped from the upstream error.
- Manifest GET by digest: missing locally → fetch by digest for the same
  repository (index children).
- Blob GET/HEAD miss → only digests some cached manifest of that repository
  references are fetched. Content another repository already holds is linked
  (quota checked) without contacting the upstream; otherwise a per-digest
  `upstream.Group` (context-aware singleflight: waiters are bounded by their
  request, the leader runs detached so a hung-up client does not abort the
  download) streams the blob into `storage.Staging`, verifies the digest,
  commits it through the storage driver and registers the blob row; each
  requesting repository then links it. At most 8 upstream downloads run at
  once.
- Storing a manifest reuses the push path pieces: repository auto-creation
  with the organization default visibility and the repository quota,
  `UpsertManifest` + refs, `UpsertProxyTag`, a `push` event with actor
  `proxy`, and the `manifest.push` webhook to the web app (config caching,
  repository webhooks, Clair scan — with Clair on, the scan pulls every layer
  through registryd and thereby prefetches them). Storage quotas are checked
  before a download when the upstream sends a length, else before linking.
- `allowed_patterns` and `enabled` are checked before any upstream contact;
  the pull policy (`manifest_blocks`) applies on serve as for every image.
- `last_checked_at`/`last_error` are written at most every 30 s per
  organization unless the message changes.

**Web app.** `lib/proxy.ts` (queries, decrypted config feed, `testUpstream`
via `RemoteRegistry`, `evictProxyTags`, `reloadRegistryProxies`),
`app/api/internal/proxies/route.ts`, `app/actions/proxy.ts` (save / remove /
test / enable-on-create, manager roles), `lib/proxy-shared.ts` (presets, name
mapping, patterns, `repoHref`). Repository links use
`repoHref(org, name)` = `/<org>/<encodeURIComponent(name)>`; Next decodes
`%2F` inside the `[repo]` segment, so `/dockerhub/bitnami%2Fredis` renders
`[org]/[repo]` with `params.repo === "bitnami/redis"` (`decodeRepoParam`
guards double-encoded values). UI: *Settings → Proxy* tab (`settings/proxy`),
proxy badge and pull prefix in the organization header, *cached · checked …*
badges in repository lists (explore included), *cached from …* and the last
upstream check on the repository page, proxy card on
`/admin/organizations/[id]`, and the *Make this a proxy cache* shortcut on
`/orgs/new`. Job `proxy-evict` (`lib/jobs.ts`, params `unusedFor`, `dryRun`).

**Env / compose.** No new required variables: `INTERNAL_API_URL` is
optional (derived from `WEBHOOK_URL`). Registryd needs to reach the web app
(it already does for the webhook) and the upstream registries (outbound
HTTPS; `HTTPS_PROXY` is honoured).
