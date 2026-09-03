# Registry traffic: range requests, egress/ingress accounting, pull rate limits

Work-in-progress notes for the `traffic` feature set. Section (a) is written to
be folded into `README.md`, section (b) into `ARCHITECTURE.md`.

---

## (a) README-ready sections

### Partial downloads (HTTP Range)

`GET /v2/<name>/blobs/<digest>` honours a single `Range: bytes=…` header and
answers `206 Partial Content` with `Content-Range`, so resumable and parallel
layer downloads (`containerd`, `oras`, download managers) fetch only the bytes
they need:

```sh
curl -sS -H "Authorization: Bearer $TOKEN" -r 0-9 "https://cr.example.com/v2/acme/app/blobs/sha256:…"   # 206, 10 bytes
curl -sS -H "Authorization: Bearer $TOKEN" -r 5- …          # 206, from byte 5 to the end
curl -sS -H "Authorization: Bearer $TOKEN" -r -100 …        # 206, the last 100 bytes
curl -sS -H "Authorization: Bearer $TOKEN" -r 999999999- …  # 416, Content-Range: bytes */<size>
```

Every blob response (200, 206 and HEAD) carries `Accept-Ranges: bytes`. A
multi-range request (`bytes=0-9,20-29`) is served as a normal `200` with the
whole blob, which the HTTP specification allows. The filesystem backend seeks,
S3 sends the range to the bucket, bunny.net sends it to Edge Storage; when
S3/bunny redirects are enabled the client repeats its `Range` header against
the presigned URL, which both services honour.

### Traffic statistics

Chicorée counts the bytes that actually move through the registry, per
repository and day:

- **Egress** — bytes served for blob and manifest downloads (a partial
  download counts what was sent).
- **Redirected** — blob sizes handed to the storage backend via a presigned
  redirect (S3 `S3_REDIRECT_GET`, bunny `BUNNY_CDN_URL`); those bytes leave S3
  or the CDN, not the registry, so they are shown separately.
- **Ingress** — bytes received for successful layer uploads and manifest pushes.

*Administration → Metrics* shows egress and ingress per day for the last 30
days, the repositories with the most egress and the totals per organization.
Every organization page and repository page shows its egress for the last 30
days next to the pull counts, with an "Egress per day" chart.

The counters are aggregated in memory and written every 10 seconds (and on
shutdown), so a hard crash can lose at most the last few seconds.

### Pull rate limits

*Administration → Rate limits* caps how many image pulls a client may make in
a window, Docker Hub style: every manifest request (`GET` or `HEAD`) counts as
a pull, blob downloads never do.

| Setting | Applies to | Example |
| --- | --- | --- |
| Anonymous clients | per client IP address | `100/6h` |
| Authenticated clients | per user or service account | `200/6h` |
| Trusted proxies | CIDRs whose `X-Forwarded-For` is believed | `10.0.0.0/8` |

Limits are written as `<count>/<window>` with a window in `s`, `m`, `h` or
`d`; an empty field means unlimited. Changes apply within 30 seconds. The
matching environment variables `RATE_LIMIT_ANONYMOUS`,
`RATE_LIMIT_AUTHENTICATED` and `RATE_LIMIT_TRUSTED_PROXIES` are the defaults
while the section has never been saved (both the web app and `registryd`
read them).

Every limited response carries `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset` (seconds until the window restarts) plus
`RateLimit-Policy: <count>;w=<window seconds>`, so clients can see their
budget. Over the limit the registry answers `429 Too Many Requests` with the
OCI error code `TOOMANYREQUESTS` and a `Retry-After` header:

```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 4711
Retry-After: 4711
{"errors":[{"code":"TOOMANYREQUESTS","message":"pull rate limit exceeded: 100 pulls per 6h for anonymous clients; sign in for a separate budget; retry in 4711s"}]}
```

Instance administrators, the web app's own reads, mirrors and proxy caches are
never limited. The counters are per registry replica: with three replicas
behind a load balancer a client effectively gets three budgets. The client
address is the connecting peer unless that peer is listed under trusted
proxies, in which case the *last* `X-Forwarded-For` hop is used (never the
first — clients can forge that one).

---

## (b) ARCHITECTURE-ready notes

### Range requests (`registryd/internal/api/ranges.go`, `internal/storage/range.go`)

- `parseRange(header, size)` classifies a `Range` header as *none* (absent,
  unknown unit, malformed, or multi-range → serve 200), *ok* (one satisfiable
  `a-b`, `a-`, `-n` → 206) or *unsatisfiable* (`a >= size`, `-0`, any range on
  an empty blob → 416 with `Content-Range: bytes */<size>`).
- `writeBlobContent(w, r, driver, digest, size)` streams the full blob or the
  range and reports the bytes written and the status, which the handler feeds
  into traffic accounting. Storage errors come back unmapped so the handler
  keeps its existing 404/500 mapping. `Accept-Ranges: bytes` is set on GET,
  HEAD and 206.
- `storage.RangeReader` is an optional driver interface
  (`OpenRange(ctx, digest, offset, length)`); `storage.OpenRange` uses it when
  implemented and otherwise falls back to `Get` + `SkipAndLimit` (discard
  `offset` bytes, limit to `length`). Implementations: filesystem (`Seek`), S3
  (`Range` on `GetObject`; a reply without `Content-Range` is treated as the
  whole object and skipped), bunny (`Range` header on the storage API, 206
  expected, 200 tolerated).
- Redirect responses (`RedirectURL != ""`) are unchanged: the 307 is sent
  before the `Range` header is looked at, the client repeats the header against
  the presigned URL (S3 and bunny CDN both honour it).
- HEAD ignores `Range` (allowed by RFC 9110).

### Traffic accounting

- Table `repository_traffic` (`web/src/db/registry-schema.ts`, contract for
  `registryd/internal/store/traffic.go`): `repository_id` (FK, cascade),
  `day date` (UTC), `pull_bytes`, `push_bytes`, `redirect_bytes`,
  `blob_pulls`, `manifest_pulls` (all `bigint`, default 0); primary key
  `(repository_id, day)`, index on `day`. registryd is the only writer.
- `registryd/internal/traffic`: `Counter.Add(repoID, Delta)` keys by
  `(repo, today-in-UTC)` at the time of the request, so a flush that straddles
  midnight writes two rows instead of misattributing the earlier traffic.
  `Counter.Run(ctx, 10s)` flushes on a ticker and once more when the context
  ends; `main.go` waits for that final flush before exiting. A failed flush
  merges the batch back and retries next tick.
- `Store.UpsertTraffic` pipelines one
  `INSERT … SELECT … WHERE EXISTS (repository) ON CONFLICT DO UPDATE SET col =
  col + EXCLUDED.col` per row in a `pgx.Batch`; rows of repositories deleted
  in the meantime are skipped rather than failing the batch.
- What is counted (all in `internal/api`, via `Server.countTraffic`):
  blob GET 200/206 → `pull_bytes += bytes written`, `blob_pulls += 1`; blob GET
  redirect → `redirect_bytes += blob size`, `blob_pulls += 1`; manifest
  GET → `pull_bytes += payload`, manifest GET/HEAD → `manifest_pulls += 1`
  (same semantics as `pull_count`); upload commit (monolithic POST or final
  PUT after PATCHes) → `push_bytes += staged size` (dedup'd content still
  counts, cross-repo mounts count nothing); manifest PUT → `push_bytes +=
  payload`. 416 and error responses count nothing.
- Web reads: `lib/admin-stats.ts` (`trafficBytesSeries`,
  `topRepositoriesByEgress`, `trafficByOrganization`), `lib/data.ts`
  (`egressSeries`, `trafficSummary` scoped to a repo or org),
  `lib/metrics.ts` exposes `chicoree_repository_egress_bytes_total`,
  `chicoree_repository_ingress_bytes_total`,
  `chicoree_repository_redirect_bytes_total` (labels `organization`,
  `repository`) and `chicoree_traffic_bytes_total{direction="egress"|"ingress"|"redirect"}`,
  all summed from the table at scrape time.
- `components/pulls-chart.tsx` gained `kind="bytes"` (binary-unit axis
  rounding, byte labels/tooltip) and `emptyLabel`; the pulls chart is unchanged
  by default.

### Pull rate limiting (`registryd/internal/ratelimit`, `internal/api/ratelimit.go`)

- Configuration: `instance_settings` row `ratelimit` with value
  `{"anonymous": "100/6h", "authenticated": "", "trustedProxies": "10.0.0.0/8"}`
  (written by `lib/instance-settings.ts` section `ratelimit`, no secrets).
  Fields missing from the row fall back to the environment
  (`RATE_LIMIT_ANONYMOUS`, `RATE_LIMIT_AUTHENTICATED`,
  `RATE_LIMIT_TRUSTED_PROXIES`); no row at all means the environment applies
  as-is — the same precedence the web app uses. `Server.EnableRateLimiting`
  loads it at start (a malformed value is fatal at startup),
  `Server.RunRateLimitReload` re-reads it every 30 s and swaps the limiters
  only when something changed (counters restart on a change; a reload error
  keeps the previous limits and logs).
- Grammar (`ratelimit.ParseLimit`, mirrored in
  `web/src/lib/rate-limit-shared.ts`): `^\d+/\d+[smhd]$`, whitespace allowed;
  empty = unlimited. Trusted proxies: comma/space/newline separated CIDRs or
  addresses (`ParseCIDRs`).
- Enforcement is at the top of `handleManifestGet` (GET and HEAD), before any
  database work, through `Server.enforcePullLimit`. Exempt: identities whose
  token carries the `registry:catalog:*` grant (instance admins — the token
  endpoint now always adds that grant for admin callers), `user:system`,
  `mirror:*`, `proxy:*`. Key: `ip:<addr>` for anonymous tokens, the token
  subject (`user:<id>` / `sa:<id>`) otherwise.
- `ratelimit.Limiter` is a per-key fixed window: the window starts with the
  key's first request and restarts once `window` has elapsed; expired keys are
  swept once per window. Counters are process-local (documented: limits are
  per replica).
- `ratelimit.ClientIP(remoteAddr, xff, trusted)`: the last `X-Forwarded-For`
  hop only when the peer is inside a trusted prefix (IPv4-mapped IPv6 peers are
  unmapped first), else the peer.
- Headers on every limited response: `RateLimit-Limit`, `RateLimit-Policy`
  (`<count>;w=<seconds>`), `RateLimit-Remaining`, `RateLimit-Reset` (seconds,
  rounded up). 429 adds `Retry-After` (≥ 1) and the OCI error body with code
  `TOOMANYREQUESTS`.
- Tests: `internal/ratelimit/ratelimit_test.go` (grammar, CIDRs, settings
  merge, window/reset/sweep, manager reload, client IP),
  `internal/api/ratelimit_test.go` (exemptions, header formatting, end-to-end
  429 through `httptest`), `internal/api/ranges_test.go` (range parsing +
  handler through `httptest` with the filesystem driver and the generic
  fallback), `internal/storage/filesystem/filesystem_test.go`,
  `internal/storage/range_test.go`, `internal/traffic/traffic_test.go`.

### Web app

- `lib/instance-settings.ts`: section `ratelimit` (`RateLimitSettings`) at
  the end of every list; `lib/env.ts` getters `rateLimitAnonymous`,
  `rateLimitAuthenticated`, `rateLimitTrustedProxies`.
- `app/actions/instance-settings.ts`: `saveRateLimitSettings` validates with
  `lib/rate-limit-shared.ts` and normalises (`100 / 6h` → `100/6h`, proxies
  joined with `, `); `resetSection` accepts `ratelimit`.
- Page `app/(app)/admin/settings/limits/page.tsx` + `limits-form.tsx` ("Rate
  limits" tab in `admin-nav.tsx`), live per-field explanation of the parsed
  limit, "Use environment values" reset, and an explanation card.
- `app/api/registry/token/route.ts`: admin callers always receive the
  `registry:catalog:*` grant (so registryd can recognise them for the
  exemption); previously it was only added when the client asked for that scope.

### Environment variables (new)

| Variable | Read by | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_ANONYMOUS` | web, registryd | default anonymous pull limit, `<count>/<window>` |
| `RATE_LIMIT_AUTHENTICATED` | web, registryd | default authenticated pull limit |
| `RATE_LIMIT_TRUSTED_PROXIES` | web, registryd | default trusted proxy CIDR list |

No compose or Dockerfile changes were needed.
