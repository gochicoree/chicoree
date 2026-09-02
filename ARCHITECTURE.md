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
      ▲            (Next.js)     │             (Go)          filesystem | S3
      │               │ (2) authorize scopes,     │
      └───────────────┤     sign ES256 JWT        │
                      │                           │
                      │        Postgres           │
                      └──────► (shared) ◄─────────┘
                      │                           
                      └──► Clair v4 (indexer/matcher), fetches layers
                           back through registryd with a pull token
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

## registryd (Go, no framework)

- **Names**: `<org>/<repo>` or a bare `<repo>`, which resolves to the
  `library` organization (`nginx` ≡ `library/nginx`). The token service and
  the UI apply the same rule.
- **Routes**: the full distribution spec — blob get/head/delete, uploads
  (chunked PATCH + monolithic POST, cross-repo mount, resume, cancel),
  manifests (image + index, tag or digest refs), `tags/list`, `referrers`
  (with `artifactType` filter), `_catalog` (admin-gated) — plus
  `/internal/v1/healthz` and `/internal/v1/gc`.
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
- **Events**: every push/pull/delete is recorded (`events`) off the hot path;
  pulls also bump `repositories.pull_count`. A manifest request — GET or
  HEAD — counts as a pull (Docker Hub semantics; warm client caches
  revalidate with HEAD).
- **Webhook**: manifest pushes/deletes POST an HMAC-signed event to the web
  app, which caches the image config and kicks off scanning.
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
- **Schema**: drizzle owns migrations (`web/drizzle/`, applied on container
  start). `web/src/db/registry-schema.ts` is the cross-service contract —
  registryd's SQL in `registryd/internal/store/store.go` must match it.
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
- **Webhooks** (`src/lib/webhooks.ts`): after a push event arrives from
  registryd (and the image config is cached), the app builds one payload and
  delivers it to every enabled hook of the repository — custom method,
  headers, auth (secrets encrypted with AES-GCM under a key derived from
  `AUTH_SECRET`, see `src/lib/crypto.ts`), HMAC signature, retries, and a
  bounded delivery log (`webhook_deliveries`).
- **Mirrors** (`src/lib/mirror.ts`, `src/lib/remote-registry.ts`): a small
  client for foreign registries (Bearer/Basic challenge handling, paginated
  tag lists, manifest/blob fetches) feeds an importer that pushes through
  registryd as a normal client with a `mirror:<id>` token — so quota, dedup,
  webhooks and scanning behave exactly as for `docker push`. Selection
  (all/glob/regex/list + exclude) and relabelling (template + regex rewrite)
  are pure functions; every run is recorded in `mirror_runs` with a per-tag log.
- **Jobs** (`src/lib/jobs.ts`): `gc`, `scan-stale`, `prune-untagged`, `mirror-sync` — each
  run recorded in `job_runs`. Exposed on `/admin/jobs` and as
  `POST /api/jobs/<name>` for automation (bearer `JOBS_API_TOKEN` or an admin
  PAT with write scope).
- **Administration**: `/admin/users/[id]` and `/admin/organizations/[id]`
  manage roles, bans, limits (`user_limits`, `organization_limits`),
  memberships and repositories directly in the database (admins are not org
  members, so better-auth's member-scoped endpoints don't apply).
  Impersonation uses better-auth's admin plugin; the session carries
  `impersonatedBy`, which the app layout turns into a persistent banner.
- **Statistics**: pulls/day (zero-filled series from `events`), storage
  per-repo/org (linked-blob sums), instance-wide physical vs logical bytes
  (dedup savings), and per-image layer breakdowns (sizes + Dockerfile
  instructions reconstructed from the cached image config history).

## Credentials at a glance

| Credential | Prefix | Scope | Created in |
| --- | --- | --- | --- |
| Personal access token | `chc_pat_` | acts as the user; `read` or `write`; admins' write tokens also unlock the jobs API | Settings → Access tokens |
| Service account | `chc_sa_` | one org; `pull` / `push` / `admin` (+delete), optional repo allowlist & expiry | Org → Service accounts |

Only sha256 hashes are stored; secrets are displayed once at creation.

## Notes & known trade-offs

- Clair is pinned to 4.8.0 — 4.9.0's OSV updater panics on current upstream
  data. Fresh installs report few/no findings until Clair finishes syncing
  its vulnerability databases (minutes to an hour).
- Manifest DELETE removes the manifest row; blob bytes are reclaimed by the
  next GC pass, never inline.
- The registry enforces exactly two-level names (`<org>/<repo>`).
- `AUTH_DISABLED=true` on registryd turns every request into an admin — a
  dev-only escape hatch, loudly logged at startup.
