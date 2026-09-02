# Chicorée

A self-hosted OCI container registry with a proper management plane.

> Chicorée is written `Chicoree` in paths, identifiers and configuration.

- **`registryd/`** — the registry itself, written in Go from the OCI Distribution
  Spec up: chunked & monolithic blob uploads, cross-repo mounts, image + index
  manifests, tag listing, the referrers API, content-addressable deduplicated
  storage (filesystem or S3), and Docker token authentication.
- **`web/`** — the management app (Next.js + TypeScript): organizations,
  public/private repositories, members & invitations, service accounts for CI,
  personal access tokens, layer-level image inspection, pull statistics, and
  Clair vulnerability scanning. Sign-in supports email+password, magic links,
  email one-time codes, passkeys, GitHub/Google/any-OIDC OAuth, LDAP/Active
  Directory with group-based roles, and TOTP or
  email-based two-factor auth.
- **Clair v4** (combo mode) scans every pushed image; reports live next to the tag.

## Quick start

Requirements: Docker with compose.

```sh
./scripts/gen-keys.sh        # writes secrets/ (token signing keys) and .env
docker compose up --build -d
```

Then:

1. Open http://localhost:3000 and create an account — **the first account
   becomes the instance administrator**.
2. Create an organization (its slug is the image namespace).
3. Create an access token under *Settings → Access tokens*.
4. Push:

```sh
docker login localhost:5000 -u you@example.com   # password: the access token
docker tag alpine localhost:5000/<org>/alpine:latest
docker push localhost:5000/<org>/alpine:latest
```

Repositories are auto-created on first push. Their visibility follows the
organization's default, then the pusher's own default, then private. The dev
inbox (magic links, codes, invitations) is Mailpit at http://localhost:8025.

**Top-level images.** `docker push localhost:5000/nginx:1.27` (no
organization in the name) is stored and served through the built-in
`library` organization, exactly like `docker.io/nginx` ⇢ `library/nginx`.
`library` is created with the first administrator, owned by admins, and
cannot be deleted or renamed; add members to it to let others push
top-level names.

> **macOS note:** AirPlay occupies port 5000. Set `REGISTRY_PORT=5010` and
> `REGISTRY_HOST=localhost:5010` in `.env`.

## Configuration

Everything is environment-driven; see `.env.example` for the full list.

| Concern | Variables |
| --- | --- |
| Storage backend | `STORAGE_DRIVER=filesystem\|s3\|bunny` plus that plugin's `<NAME>_*` variables — see [Storage plugins](#storage-plugins) |
| Public addresses | `APP_URL`, `REGISTRY_HOST`, `REGISTRY_PORT` |
| OAuth sign-in | `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/NAME/SCOPES/GROUPS_CLAIM` |
| LDAP sign-in | `LDAP_URL`, `LDAP_BIND_DN/PASSWORD`, `LDAP_USER_BASE/FILTER`, … — see [LDAP](#ldap--active-directory) |
| Group-based roles | `AUTH_GROUP_BINDINGS` — see [Group-based roles](#group-based-roles) |
| Email | `SMTP_HOST/PORT/USER/PASS/FROM` (defaults to bundled Mailpit) |
| Passkeys | `PASSKEY_RP_ID` (the domain users see), `PASSKEY_RP_NAME` |
| Jobs API | `JOBS_API_TOKEN` (optional static token for automation) |
| GC safety window | `GC_GRACE_PERIOD` (default `1h`) |

For production: serve both the web app and the registry behind TLS (any
reverse proxy), point `APP_URL`/`REGISTRY_HOST` at the real hostnames, use a
managed Postgres, and keep `secrets/registry-token.key` private — it signs
every registry access token.

### Behind a reverse proxy

`APP_URL` and `REGISTRY_HOST` are the *public* addresses, not the container
ports. With a proxy terminating TLS for `registry.example.com` (UI) and
`cr.example.com` (docker API):

```sh
APP_URL=https://registry.example.com      # scheme + host users open in a browser
REGISTRY_HOST=cr.example.com              # host[:port] users pass to `docker login`
PASSKEY_RP_ID=registry.example.com        # must equal APP_URL's hostname
```

`APP_URL` doubles as the token realm that `registryd` advertises in its
`WWW-Authenticate` challenge (`${APP_URL}/api/registry/token`), so docker
clients must be able to reach it, and better-auth uses it for OAuth callbacks,
magic-link URLs and cookie security — it must carry the real scheme.
`REGISTRY_HOST` has no scheme; docker requires HTTPS for anything that is not
`localhost`. Both can share one hostname if the proxy routes `/v2/` to the
registry and everything else to the web app.

Proxy-side requirements:

- forward `Host`, set `X-Forwarded-Proto: https`, and pass the `Authorization`
  header through unchanged (both the token endpoint and the registry need it);
- no request body limit and no request buffering for the registry route
  (`client_max_body_size 0; proxy_request_buffering off;` in nginx) — image
  layers stream through as multi-GB uploads;
- generous read/send timeouts on the registry route (minutes, not seconds).

The registry emits relative `Location` headers for blob uploads and the web
app never reads forwarded headers, so nothing else is host-specific. Once
proxied, bind the published ports to loopback in `docker-compose.yml`
(`127.0.0.1:3000:3000`, `127.0.0.1:5000:5000`) so only the proxy reaches them.

### Deploying with Coolify

`docker-compose.coolify.yml` is a variant of the stack for Coolify's Docker
Compose build pack: no host ports, no bind mounts from the repository, and
every secret generated by Coolify. The web container creates the ES256 token
key pair and the Clair database on its first start (both land in named
volumes), so nothing has to be prepared on the server.

1. **New resource → Docker Compose**, point it at this repository and set
   *Docker Compose Location* to `/docker-compose.coolify.yml`, then load it.
2. **Domains.** Give `web` its UI domain (Coolify routes it to port 3000, e.g.
   `https://registry.example.com`) and `registryd` the docker domain
   (`https://cr.example.com`, routed to port 5000). Both must be HTTPS; docker
   refuses plain-HTTP registries that are not `localhost`. `APP_URL`,
   `REGISTRY_HOST`, `TOKEN_REALM` and `PASSKEY_RP_ID` are derived from these
   automatically (`SERVICE_URL_WEB`, `SERVICE_FQDN_REGISTRYD`).
3. **Environment.** Fill in `SMTP_*` (otherwise mail is only logged), and any
   of the optional blocks: S3 storage, OAuth providers, LDAP,
   `AUTH_GROUP_BINDINGS`. Everything else is prefilled.
4. **Proxy timeouts.** Image layers stream through the proxy as large, slow
   uploads. In Coolify's proxy settings raise Traefik's entrypoint
   `respondingTimeouts.readTimeout` (and `idleTimeout`) for the registry
   domain to several minutes; Traefik does not buffer bodies, so no size limit
   is needed.
5. Deploy, open the UI domain, create the first account (it becomes the
   administrator), then `docker login cr.example.com` with an access token.

Data lives in the `pg-data`, `registry-data` and `token-keys` volumes; back
up all three. Rotating the token key pair means deleting `token-keys` and
redeploying (running sessions and access tokens survive; in-flight docker
tokens expire within minutes anyway).

### LDAP / Active Directory

Set `LDAP_URL` (`ldap://` or `ldaps://`) and the sign-in page gains a
directory username + password mode; the same credentials work for
`docker login`. Accounts are created on first login (email verified, taken
from `LDAP_ATTR_EMAIL` or `<username>@LDAP_EMAIL_DOMAIN`). Users with app-level
two-factor auth still complete the 2FA step in the browser and must use an
access token for docker.

```sh
LDAP_URL=ldaps://ldap.example.com
LDAP_BIND_DN=cn=registry,ou=services,dc=example,dc=com   # read-only lookup account
LDAP_BIND_PASSWORD=…
LDAP_USER_BASE=ou=people,dc=example,dc=com
LDAP_USER_FILTER=(&(objectClass=person)(uid={{username}}))
# Active Directory: (&(objectClass=user)(sAMAccountName={{username}}))
```

Groups come from the user entry's `LDAP_ATTR_GROUPS` (default `memberOf`);
directories without it can set `LDAP_GROUP_BASE`/`LDAP_GROUP_FILTER` to search
groups by member (`{{dn}}` and `{{username}}` are substituted, values are
escaped). Map the groups to roles with `AUTH_GROUP_BINDINGS` (next section).

### Group-based roles

`AUTH_GROUP_BINDINGS` turns directory or identity-provider groups into the
instance role and organization memberships, and is re-applied on every sign-in
through that provider:

```sh
AUTH_GROUP_BINDINGS="cn=registry-admins,ou=groups,dc=example,dc=com => admin; \
developers => acme:member; \
github:acme/platform => acme:owner; github:acme => acme:viewer; \
google:example.com => acme:viewer; google:sre@example.com => acme:admin; \
oidc:registry-admins => admin"
```

| Provider | Group identifier | Where it comes from |
| --- | --- | --- |
| LDAP | full DN, or just the CN (optionally `ldap:`-prefixed) | `memberOf` / group search |
| GitHub | `github:<org>`, `github:<org>/<team-slug>` | GitHub API; `read:org` is requested automatically when a `github:` binding exists (users who authorized earlier must sign in again to grant it) |
| Google | `google:<workspace domain>`, `google:<group email>` | `hd` claim of the ID token; group addresses use the Cloud Identity API (enable it in the OAuth client's project — the scope is requested automatically) |
| OIDC | `oidc:<value>` | the `OIDC_GROUPS_CLAIM` (default `groups`) claim of the ID token; add the scope your IdP needs to `OIDC_SCOPES` |

- Entries are `;`-separated; matching is case-insensitive.
- Targets are `admin` (instance administrator) or `<org-slug>:<owner|admin|member|viewer>`;
  when several bindings hit the same organization the highest role wins. The
  organizations must already exist.
- Bindings are authoritative per provider: after a GitHub sign-in only the
  `github:` bindings are consulted — a user who matches none of them for an
  organization that `github:` bindings mention is removed from it, and if a
  `github:` binding targets `admin` the instance role follows it. Organizations
  no binding of that provider mentions are never touched, and the last owner
  of an organization is never removed.
- If the group lookup fails, or the token lacks the needed scope or claim, the
  user's roles are left as they are and the reason is logged.

## Storage plugins

`registryd` loads its blob backend through a plugin registry. Pick one with
`STORAGE_DRIVER` and configure it with `<NAME>_<OPTION>` variables
(`STORAGE_<NAME>_<OPTION>` also works). `registryd plugins` prints every
backend with its options:

| Plugin | Options |
| --- | --- |
| `filesystem` | `FILESYSTEM_ROOT` (default `/var/lib/registry`) |
| `s3` | `S3_BUCKET`*, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`, `S3_REDIRECT_GET`, `S3_PRESIGN_EXPIRY` |
| `bunny` | `BUNNY_STORAGE_ZONE`*, `BUNNY_ACCESS_KEY`*, `BUNNY_REGION` (`ny`, `la`, `sg`, `se`, `br`, `jh`, `syd`, `uk`; empty = Falkenstein), `BUNNY_ENDPOINT`, `BUNNY_CDN_URL` + `BUNNY_CDN_TOKEN_KEY` (signed pull-zone redirects), `BUNNY_PRESIGN_EXPIRY` |

Adding a backend is one Go package: implement `storage.Driver`, call
`storage.Register` in `init()`, and blank-import it from
`registryd/cmd/registryd/main.go`.

## How access works

- **Roles**: org `owner`/`admin` → pull, push, delete + manage the org;
  `member` → pull, push, create repositories; `viewer` → pull only (read
  access to private repositories without any way to change them). Public
  repositories are pullable by anyone, including anonymously. Instance
  admins can do everything. Switching a repository from private to public
  asks for confirmation.
- **`docker login` credentials**: personal access tokens (`chc_pat_…`, per
  user, read-only or read-write) and service accounts (`chc_sa_…`, per org,
  pull / push / admin, optional expiry) — both usable as the password with
  any username. Email+password also works, but only for accounts *without*
  two-factor auth; 2FA users must use a token.
- The web app's token endpoint (`/api/registry/token`) authorizes each
  requested scope against the database and signs a short-lived ES256 JWT;
  `registryd` verifies it with the public key and enforces the granted
  actions. The registry itself holds no credentials.

## Webhooks

Each repository can have up to five outbound webhooks (*Repository →
Settings → Webhooks*). Every image push calls them with a JSON body carrying
the repository, tag, digest, media type, layer list and sizes, platform,
entrypoint/cmd/labels from the image config, and who pushed. Configure the
HTTP method (POST/PUT/PATCH), extra headers, authentication (bearer token,
basic auth, or a custom header — secrets are encrypted at rest) and an
optional signing secret that adds `X-Chicoree-Signature: sha256=<hmac>` so
receivers can verify the body. Deliveries retry on network errors and 5xx,
and the last 50 attempts are visible per hook; *Send test* fires a sample.

## Mirroring / importing

*Organization → Import* (or a repository's *Settings → Mirror*) copies tags
from any other registry (Docker Hub, GHCR, Quay, another Chicorée …) into a
local repository:

- **Tag selection**: all tags, glob patterns (`1.27.* stable-*`), a regular
  expression, or an explicit list — plus an exclude pattern. *Preview
  matching tags* shows what would be pulled before you commit.
- **Relabelling**: a destination tag template with `{tag}`, `{source}`,
  `{major}`, `{minor}`, `{patch}`, and an optional regex rewrite
  (`^v` → ``) applied first. Multi-arch indexes are imported whole.
- **Re-sync**: *Sync now* on the repository, the `mirror-sync` job on the
  admin Jobs page, or `POST /api/jobs/mirror-sync` from cron. Unchanged tags
  are skipped; mutable tags are re-imported when *overwrite* is on.

Imports go through the registry like any push, so quotas, dedup and
scanning apply, and the event log shows the mirror as the actor.

## Layer deduplication

Blob content is stored once per digest and shared by every manifest and
repository that references it. Deleting a tag or manifest never removes
layers; garbage collection removes only content that no remaining manifest
references, and the registry refuses to delete a blob through the API while
a manifest in that repository still uses it.

## Limits

Administrators can cap what users and organizations consume — per
organization, and per user across every organization they own. Each limit
is independent and unlimited by default:

- organizations a user may create
- public repositories, private repositories
- storage (deduplicated bytes)

Limits are enforced in the web app (creating repositories, switching
visibility, creating organizations) and inside `registryd` at push time —
before anything is written, so a denied push leaves nothing behind:

```
error from registry: organization storage quota exceeded: 33.9 MiB of 1.0 MiB used
error from registry: organization quota exceeded: 8 of 8 private repositories used
``` Set them under *Administration →
Users / Organizations*, where usage is shown against each limit.

## Administration

- **Users** (`/admin/users`): role, ban/unban, limits, memberships, and
  **impersonation** — act as the user in a separate session; a banner shows
  who you are impersonating with a one-click stop.
- **Organizations** (`/admin/organizations`): usage vs limits, members and
  their roles, repositories, and deletion — without having to be a member.
- **Jobs** (`/admin/jobs`): run maintenance jobs and see their history.

## Operations

- **Jobs API**: every maintenance job is also an HTTP endpoint for cron, CI
  or scripts. Authenticate with `JOBS_API_TOKEN` or an administrator's read
  & write access token.

  ```sh
  curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs/gc?grace=30m"
  curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs/scan-stale?olderThan=7d&wait=false"
  curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs/prune-untagged?olderThan=14d"
  curl -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs"        # list jobs + recent runs
  ```

  Jobs: `gc` (reclaim unreferenced blobs, sweep stale uploads),
  `scan-stale` (re-scan images whose last scan is older than `olderThan`),
  `prune-untagged` (delete untagged manifests older than `olderThan`; run
  `gc` afterwards). Add `?wait=false` to queue and return immediately.
- **Garbage collection** is also exposed on the registry itself as
  `POST /internal/v1/gc` (bearer = webhook secret), which the `gc` job calls.
- **Health**: `GET /internal/v1/healthz` on the registry.
- **Scan refresh**: every push triggers a Clair scan; the *Re-scan* button on
  a tag re-submits it (vulnerability databases keep updating, so re-scan
  periodically). Clair needs a few minutes after first boot to download its
  vulnerability databases; earlier scans may come back empty.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.
