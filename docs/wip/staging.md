# Shared upload staging (scale-out) — docs for merge

Slug: `staging`. Section (a) is README-ready, section (b) is ARCHITECTURE-ready.

---

## (a) README sections

### Running several registryd replicas

A single registryd is enough for most installations, but the registry is
built so that several replicas can sit behind one load balancer. What has to
be shared, and what stays per replica:

| Concern | Shared how |
| --- | --- |
| Blob content | The storage backend (S3, bunny, or a filesystem every replica mounts). |
| Metadata | Postgres — already shared. |
| **In-flight uploads** | `STORAGE_STAGING=shared` (below). Without it upload sessions are node-local and the load balancer needs sticky routing on `/v2/*/blobs/uploads/*`. |
| Pull rate-limit counters | Per replica: three replicas give each client three times the budget (see *Rate limits*). |
| Traffic statistics | Per replica, flushed to Postgres every 10 s; a crash loses at most 10 s. |
| Proxy-cache downloads | The per-digest singleflight is per replica: two replicas asked for the same missing layer at the same moment both fetch it (the second one finds the blob already stored and links it). |
| Job schedules | The web app takes an advisory lock, so only one web replica runs jobs. |

#### Upload staging

A blob upload is a session: `POST` opens it, one or more `PATCH` requests
append bytes, `PUT ?digest=` verifies and commits. Where those bytes wait is
`STORAGE_STAGING`:

- `local` (default) — files under `STORAGE_STAGING_DIR` on the replica that
  received them. Fast and simple; every request of a session must reach the
  same replica.
- `shared` — the session (offset, chunk list) lives in Postgres and the
  chunk bytes go to the storage backend under the reserved `_uploads/`
  prefix. Any replica can continue, inspect, cancel or commit any session;
  no sticky routing needed. Two replicas that append to the same session at
  the same moment are serialised: one wins, the other answers
  `416 RANGE_INVALID` with the offset to resume from (that is also what a
  client that retried a chunk sees). The commit streams the chunks through
  the digest check straight into the backend, and the blob only becomes
  visible once the digest matched; the chunks and the session row are
  deleted afterwards. Expired sessions (`UPLOAD_SESSION_TTL`, 24 h idle) and
  chunk objects that belong to no session are removed by garbage collection
  (Administration → Garbage collection, or the `gc` job) and by the hourly
  sweep.

`shared` works with every bundled driver — `s3`, `bunny` and `filesystem`
(for a shared mount). Run every replica in the same mode; a mixed fleet
behaves like `local`. The admin health page shows the mode
("Upload staging: shared … · n in flight") and skips the staging-disk check
in shared mode. The proxy-cache path stages upstream downloads the same way,
so in shared mode a cache miss costs one extra write and read against the
backend.

#### Example: two replicas behind Traefik (compose)

Not enabled by default — add to `docker-compose.prod.yml` on a host with the
capacity for it. Uploads in flight are held in S3 here, so `registry-data`
is not needed:

```yaml
  registryd:
    deploy:
      replicas: 2
    environment:
      STORAGE_DRIVER: s3
      S3_BUCKET: ${S3_BUCKET}
      S3_ENDPOINT: ${S3_ENDPOINT}
      S3_ACCESS_KEY: ${S3_ACCESS_KEY}
      S3_SECRET_KEY: ${S3_SECRET_KEY}
      STORAGE_STAGING: shared
      # … the rest of the registryd environment stays as it is
    labels:
      - traefik.enable=true
      - traefik.http.routers.registry.rule=Host(`${DOMAIN}`) && (Path(`/v2`) || PathPrefix(`/v2/`))
      - traefik.http.routers.registry.priority=100
      - traefik.http.routers.registry.entrypoints=websecure
      - traefik.http.routers.registry.tls.certresolver=le
      - traefik.http.services.registry.loadbalancer.server.port=5000
      # No sticky sessions required with STORAGE_STAGING=shared. For
      # STORAGE_STAGING=local you would need instead:
      # - traefik.http.services.registry.loadbalancer.sticky.cookie=true
      # - traefik.http.services.registry.loadbalancer.sticky.cookie.name=registryd
```

Traefik's docker provider load-balances across the replicas of a service
automatically; `deploy.replicas` needs `docker compose up` (v2) — the
`container_name` must not be set on a replicated service. With
`STORAGE_DRIVER=filesystem` mount the same NFS/shared volume into every
replica (`FILESYSTEM_ROOT`), otherwise each replica has a different blob tree.

Environment reference addition (registryd):

| Variable | Default | Meaning |
| --- | --- | --- |
| `STORAGE_STAGING` | `local` | `local`: uploads wait in `STORAGE_STAGING_DIR` on the receiving replica. `shared`: sessions in Postgres, chunks in the storage backend — replicas are interchangeable. |
| `UPLOAD_SESSION_TTL` | `24h` | Idle time after which a session is discarded (both modes). |

---

## (b) ARCHITECTURE notes

### Upload staging (`internal/storage/staging.go`, `shared.go`)

`storage.Staging` is the interface the API handlers use for in-flight
uploads: `Create`, `Get` (org, repo, offset), `Append(id, expectedOffset, r)`,
`Open` (ordered stream + size), `Remove`, `Sweep`, `Mode`. `Append` takes the
offset the handler verified the client continues from and returns
`ErrOffsetMismatch` when the session has moved on — the handler maps that to
`416 RANGE_INVALID` with the current `Range` header so the client can resume.

- **`LocalStaging`** (`STORAGE_STAGING=local`, default): unchanged layout —
  `<id>.data` grows with every chunk, `<id>.json` holds `{org, repo,
  startedAt}` under `STORAGE_STAGING_DIR`. Node-local; scale-out needs sticky
  routing on `/blobs/uploads/`.
- **`SharedStaging`** (`STORAGE_STAGING=shared`): session rows in
  `upload_sessions`; each `PATCH`/`PUT` body is streamed into its own object
  `_uploads/<session>/<seq>-<nonce>` via the driver's `ObjectStore`, then the
  row is advanced with the optimistic lock
  `UPDATE upload_sessions SET offset = offset + n, chunks = chunks || …
  WHERE id = $1 AND offset = $expected`. Zero rows → the chunk object is
  deleted again and `ErrOffsetMismatch` reports the real offset (the random
  nonce keeps two racing replicas from writing the same key). `Open` returns
  a reader that concatenates the chunk objects lazily, in order. `Remove`
  deletes the row (returning its chunk list) and then the objects; failures
  are logged and left to GC. `expires_at` is set to now + `UPLOAD_SESSION_TTL`
  on create and pushed forward by every append.
- **Commit** (`internal/api/uploads.go`): one pass in both modes. The staged
  stream is wrapped in `storage.VerifyingReader` (hashes while reading, turns
  the final `io.EOF` into `ErrDigestMismatch` when the hash differs) and
  handed to `Driver.Put`. The driver contract is now explicit: `Put` must
  not publish the blob until the reader ended cleanly and the size matched —
  filesystem writes a temp file and renames, S3 completes a multipart upload
  only then (or aborts), bunny's request fails on a body error and the zone
  additionally verifies the `Checksum` header. A mismatch answers
  `400 DIGEST_INVALID` naming both digests and discards the session. When
  the driver already has the blob (dedup) the content is still hashed
  through `StagedDigest`, so a wrong digest can never link content the client
  did not send. Quota checks use the client's declared digest and the staged
  size before the write, exactly as before. `PUT` without a body stages no
  empty chunk. Session cleanup after commit runs on its own 30 s context so a
  client that disconnected still gets cleaned up.
- **Sweep**: `Sweep(ctx)` on both implementations; called hourly by
  `main.go` and by `POST /internal/v1/gc` (`sweptUploads`). Shared mode
  deletes rows with `expires_at < now()` plus their chunks, then lists
  `_uploads/` and removes objects whose session id has no row (leftovers of
  crashed replicas or failed deletes). Objects are listed before the live ids
  are read so a session opened meanwhile is never mistaken for an orphan.
- **Proxy cache**: `downloadProxiedBlob` uses the same `Staging`, so in
  shared mode an upstream download is staged in the backend (one extra write
  and read per cached layer). Local mode is unchanged.

### Storage driver extensions (`internal/storage/driver.go`)

- `storage.ObjectStore` (optional): `PutObject(key, r, size|-1) (n, err)`,
  `GetObject`, `DeleteObject`, `ListObjects(prefix)`. Implemented by
  `filesystem` (temp file + rename, `WalkDir` listing, empty session
  directories are removed with their last object), `s3` (same upload path as
  blobs, `ListObjectsV2` paginator) and `bunny` (arbitrary paths; a body of
  unknown size is spooled through a temp file because the Edge Storage API
  needs `Content-Length`; listing walks directories recursively).
  `storage.ValidObjectKey` rejects `..`, empty and absolute segments.
  `storage.UploadsPrefix` = `_uploads/`. `OpenStaging` returns
  `ErrSharedStagingUnsupported` for a driver without `ObjectStore`.
- **S3 `Put` is now multipart-capable**: bodies up to 8 MiB go in one
  `PutObject`, larger ones as a multipart upload with 8 MiB parts buffered in
  memory (`CreateMultipartUpload` → `UploadPart`… → `CompleteMultipartUpload`,
  `AbortMultipartUpload` on any error, short write or digest mismatch). Parts
  are `bytes.Reader`s, so SigV4 can sign the payload over plain HTTP (MinIO
  in compose) — a non-seekable body would otherwise fail there — and objects
  larger than 5 GiB work. Memory cost: one 8 MiB buffer per concurrent
  upload.
- `storage.VerifyingReader`, `storage.DigestOf`, `storage.ErrDigestMismatch`,
  `storage.ErrOffsetMismatch`, `storage.StagedDigest`.

### Table `upload_sessions` (`web/src/db/registry-schema.ts`, `internal/store/uploads.go`)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | the Docker-Upload-UUID |
| `organization`, `repository` | text | resolved org slug + repo name; every request on the session must match (the token itself is checked per request by `withAuth`) |
| `offset` | bigint | bytes staged; the optimistic-lock column (quoted in SQL — reserved word) |
| `chunks` | jsonb `[{seq,size,key}]` | ordered chunk objects |
| `node` | text null | hostname of the replica that opened it (diagnostics) |
| `created_at`, `updated_at`, `expires_at` | timestamptz | `expires_at` indexed (`upload_sessions_expires_idx`) |

Written by registryd only. The web app never reads it except through
`/internal/v1/status`.

### Endpoints / status

- `GET /internal/v1/status` gains `staging` (`local`|`shared`) and
  `uploadSessions` (in-flight shared sessions, `-1` in local mode); in shared
  mode `stagingDir` is `""` and `stagingFreeBytes` `-1`. `lib/health.ts`
  shows "Upload staging: shared (sessions in Postgres, chunks in <driver>
  storage) · n in flight" or "local (<dir>)" on the registry card and marks
  the "Upload staging disk" check as not applicable in shared mode.
- Startup log: `registryd listening … staging=shared`.
- `POST /internal/v1/gc` → `sweptUploads` counts expired sessions + orphaned
  session prefixes in shared mode.

### Operational notes

- All replicas must run the same `STORAGE_STAGING`; the filesystem driver's
  `_uploads/` directory under `FILESYSTEM_ROOT` doubles as the default
  `STORAGE_STAGING_DIR`, which is harmless (local files are `<id>.data/.json`,
  shared chunks live in `<id>/` directories) but do not run one replica in
  each mode against the same root.
- Shared mode costs one extra backend write + read per uploaded blob (chunk
  in, chunk out) and, on S3, a `DeleteObject` per chunk after commit.
- The `Location` headers stay relative, so the load balancer needs no
  rewriting.
