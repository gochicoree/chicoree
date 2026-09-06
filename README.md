# Chicorée

A self-hosted OCI container registry with a proper management plane.

> Chicorée is written `Chicoree` in paths, identifiers and configuration.

- **`registryd/`** — the registry itself, written in Go from the OCI Distribution
  Spec up: chunked & monolithic blob uploads, cross-repo mounts, image + index
  manifests, tag listing, the referrers API, HTTP range requests,
  content-addressable deduplicated storage (filesystem, S3 or bunny.net),
  pull-through proxy caches, immutable/protected tags, pull rate limits,
  shared upload staging for several replicas, redirects for renamed
  repositories, Prometheus metrics and Docker token authentication.
- **`web/`** — the management app (Next.js + TypeScript): organizations,
  public/private repositories, members & invitations, service accounts for CI,
  personal access tokens with expiry and scoping, search and repository
  READMEs, layer-level image inspection and tag comparison, pull and traffic
  statistics, vulnerability scanning with Clair or Trivy (CVE search, accepted
  risks), cosign signature verification with SBOM and provenance views and a
  signature pull policy, repository and organization webhooks, email
  notifications, mirrors, retention policies, scheduled maintenance jobs,
  repository rename, transfer and bulk moves, moving a single image to
  another repository, an audit log, sign-up controls, signing-key rotation,
  branding, a health page, and a [REST API](#rest-api) with an in-app
  browser and an OpenAPI document. Sign-in supports email+password, magic links,
  email one-time codes, passkeys, GitHub/Google/any-OIDC OAuth, LDAP/Active
  Directory with group-based roles, and TOTP or email-based two-factor auth.
- **Clair v4** (combo mode) or **Trivy** — both optional — scan every pushed
  image; reports live next to the tag.

## Quick start

### One command on a Linux server

```sh
curl -fsSL https://raw.githubusercontent.com/gochicoree/chicoree/main/install.sh | sudo sh
```

`install.sh` asks a few questions — public HTTPS with Let's Encrypt or plain
HTTP on a LAN, the domain, the vulnerability scanner (Trivy, Clair or none),
where image layers go, SMTP, the administrator account and who may sign up
afterwards — installs git and Docker when they are missing, clones this
repository, writes `.env` with fresh secrets, builds and starts the stack and
creates the first administrator. Re-running it updates an existing
installation and keeps `.env` and the data. For unattended installs export the
answers as `CHICOREE_*` variables (listed at the top of the script) and run it
with `CHICOREE_YES=1`. While the repository is private, fetch the script with
a token (`curl -H "Authorization: token …"`) and set `CHICOREE_REPO` to a URL
the server can clone.

### By hand

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
top-level names. The organization is virtual to everyone else: no list,
search result, notification, audit entry or pull command shows a `library/`
prefix, the image is simply `nginx`, and `/nginx` in the browser opens its
repository page. Only the storage path and the API's `/orgs/library/…`
routes keep the name.

> **macOS note:** AirPlay occupies port 5000. Set `REGISTRY_PORT=5010` and
> `REGISTRY_HOST=localhost:5010` in `.env`.

## Configuration

Everything is environment-driven; see `.env.example` for the full list.

| Concern | Variables |
| --- | --- |
| Storage backend | `STORAGE_DRIVER=filesystem\|s3\|bunny` plus that plugin's `<NAME>_*` variables — see [Storage plugins](#storage-plugins) |
| Public addresses | `APP_URL`, `REGISTRY_HOST`, `REGISTRY_PORT` |
| OAuth sign-in | *Administration → Auth providers → Sign-in providers*; `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/NAME/SCOPES/GROUPS_CLAIM` as defaults |
| LDAP sign-in | *Administration → Auth providers → LDAP*; `LDAP_*` as defaults — see [LDAP](#ldap--active-directory) |
| Group-based roles | *Administration → Auth providers → Group bindings*; `AUTH_GROUP_BINDINGS` as default — see [Group-based roles](#group-based-roles) |
| Email | *Administration → Email*; `SMTP_HOST/PORT/USER/PASS/FROM` as defaults (compose points at the bundled Mailpit) |
| Passkeys | `PASSKEY_RP_ID` (the domain users see), `PASSKEY_RP_NAME` |
| Jobs | `JOBS_API_TOKEN` (optional static token for automation); `JOB_SCHEDULER=false` leaves scheduling to external cron — see [Job schedules](#job-schedules) |
| GC safety window | `GC_GRACE_PERIOD` (default `1h`) |
| Prometheus metrics | *Administration → Metrics*; `METRICS_ENABLED`, `METRICS_TOKEN` as defaults for the web app, the same `METRICS_TOKEN` on `registryd` for its own `/metrics` — see [Monitoring](#monitoring) |
| Vulnerability scanning | *Administration → Scanning*; `SCANNER=off\|clair\|trivy`, `CLAIR_URL`, `TRIVY_SERVER_URL`, `TRIVY_TIMEOUT_SECONDS`, `SCAN_WORKERS` as defaults, `TRIVY_BIN` / `TRIVY_CACHE_DIR` / `SCAN_WORKER_TOKEN` (environment only), `COMPOSE_PROFILES=clair\|trivy` for the bundled services — see [Scanner backends](#scanner-backends) and [Scan workers](#scan-workers) |
| Sign-up controls | *Administration → Auth providers → Access*; `SIGNUP_MODE`, `SIGNUP_ALLOWED_DOMAINS`, `ORG_CREATION` as defaults — see [Sign-up controls](#sign-up-controls) |
| Access token policy | *Administration → Auth providers → Access*; `TOKEN_MAX_LIFETIME_DAYS`, `TOKEN_REQUIRE_EXPIRY` as defaults — see [Access token policy](#access-token-policy) |
| REST API | *Administration → Auth providers → Access*; `API_ENABLED=false` as default switches `/api/v1` off — see [REST API](#rest-api) |
| Default limits | *Administration → Limits*; `DEFAULT_USER_MAX_*`, `DEFAULT_ORG_MAX_*` as defaults for new accounts and organizations — see [Limits](#limits) |
| Account portal | *Administration → Limits*; `PORTAL_URL`, `PORTAL_LABEL` as defaults — see [Account portal](#account-portal) |
| Token signing keys | *Administration → Signing keys*; `TOKEN_KEY_RELOAD_INTERVAL` (default `60s`) and `TOKEN_KEY_DROP_WINDOW` (default `10m`) on `registryd` — see [Signing-key rotation](#signing-key-rotation) |
| Upload staging | `STORAGE_STAGING=local\|shared` and `UPLOAD_SESSION_TTL` (default `24h`) on `registryd` — see [Running several registryd replicas](#running-several-registryd-replicas) |
| Branding | *Administration → Branding*; `INSTANCE_NAME`, `INSTANCE_TAGLINE`, `INSTANCE_EDITION` as defaults — see [Branding](#branding) |
| Pull rate limits | *Administration → Rate limits*; `RATE_LIMIT_ANONYMOUS`, `RATE_LIMIT_AUTHENTICATED`, `RATE_LIMIT_TRUSTED_PROXIES` as defaults, read by the web app and `registryd` — see [Rate limits](#rate-limits) |
| REST API rate limits | *Administration → Rate limits*; `RATE_LIMIT_API_ANONYMOUS` (default `120/1m`), `RATE_LIMIT_API_AUTHENTICATED` (default `1200/1m`) as defaults — see [REST API](#rest-api) |
| Audit log | `AUDIT_RETENTION_DAYS` (default `365`) — see [Audit log](#audit-log) |
| Keyless signatures | `SIGSTORE_TRUSTED_ROOT` (path to a `trusted_root.json`; default: the bundled public Sigstore root) — see [Keyless signatures](#keyless-signatures-sigstore) |
| Registry internals | `INTERNAL_API_URL` (where `registryd` reads proxy-cache configuration; defaults to `WEBHOOK_URL` minus its last path segment), `REGISTRY_LOG_FORMAT=text\|json`; `docker build --build-arg VERSION=…` stamps the version shown on the [Health](#health) page |

For production: serve both the web app and the registry behind TLS (any
reverse proxy), point `APP_URL`/`REGISTRY_HOST` at the real hostnames, use a
managed Postgres, and keep `secrets/registry-token.key` private — it signs
every registry access token until you rotate to a database-held key under
*Administration → Signing keys*.

### Settings in the admin panel

Email (SMTP) is edited under *Administration → Email*; the GitHub, Google and
OpenID Connect providers, LDAP, the group bindings, the sign-up controls and
the access token policy under *Administration → Auth providers*; the scanner
backend under *Administration → Scanning*; branding, pull rate limits and
signing keys on their own pages. Changes take effect immediately: the auth
stack, the mailer, the directory client and the scanner are rebuilt from the
stored values, and `registryd` picks up new rate limits and the metrics
switch within 30 seconds. Secrets are stored encrypted with `AUTH_SECRET`.
The matching environment variables still work as defaults for sections that
have never been saved (each card says whether its values come from the admin
settings, the environment, or nowhere), and "Use environment values" drops a
stored section again. The Email, LDAP and Scanning pages offer checks: a test
email, an LDAP bind plus user lookup, and a scanner probe, run with the
values in the form.

### Scanner backends

Vulnerability scanning is optional and has two backends. Pick one under
*Administration → Scanning* or with `SCANNER` in the environment (empty
means Clair when `CLAIR_URL` is set, else off):

| Backend | What runs | When to use it |
| --- | --- | --- |
| **Clair** | the separate `clair` compose service (v4, combo mode); it fetches layers from the registry itself and matches them against its own advisory database in Postgres | the established choice; several GB of advisory data, updated continuously |
| **Trivy** | the `trivy` binary inside the web container, pulling the image through the registry with a scoped token | no extra service: Trivy downloads its vulnerability database into the `trivy-cache` volume on the first scan and keeps it current; the optional `trivy` server holds one database for every web replica |
| **Off** | nothing | the vulnerability column and tab, the Security pages' totals and the `scan-stale` job disappear |

Compose profiles select the bundled services (`.env`):

```sh
COMPOSE_PROFILES=clair   CLAIR_URL=http://clair:6060                        # Clair; SCANNER may stay empty
COMPOSE_PROFILES=        SCANNER=trivy CLAIR_URL=                            # Trivy standalone, no extra service
COMPOSE_PROFILES=trivy   SCANNER=trivy TRIVY_SERVER_URL=http://trivy:4954   # Trivy with a shared server
COMPOSE_PROFILES=        SCANNER=off   CLAIR_URL=                            # no scanning
```

Clair needs Postgres and downloads several gigabytes of advisory data, so
smaller installs may prefer Trivy or nothing. On Coolify the compose file has
no profiles: the `clair` and `trivy` services are always present — delete the
ones you do not use and empty `CLAIR_URL` / `TRIVY_SERVER_URL` to match.
`TRIVY_TIMEOUT_SECONDS` (default `600`) caps one scan; `TRIVY_BIN` and
`TRIVY_CACHE_DIR` (`/var/lib/chicoree/trivy` in the image) are environment
only.

#### Scan workers

By default Trivy runs inside the web container: it pulls every layer of a
pushed image and unpacks it there. **Scan workers** move that work to other
machines without giving them database access. A worker is the same web
image started as `node worker.mjs` (`docker-compose.worker.yml`); it needs
only the instance URL (`CHICOREE_URL`) and the shared `SCAN_WORKER_TOKEN`
(generated by `scripts/deploy.sh`, or set it yourself in `.env`). Turn the
hand-over on under *Administration → Scanning → Offload scans to workers*
(`SCAN_WORKERS=true` as the default). From then on a push's scan becomes a
row in `scan_tasks`; workers long-poll `POST /api/internal/worker/claim`,
receive the manifest, the layer list, the registry address
(`REGISTRY_URL`, else `https://` + `REGISTRY_HOST`; a worker can override it
with its own `REGISTRY_URL`) and a two-hour pull token for that repository,
run trivy and post the findings to `/tasks/<id>/result` (or `/fail`). A task
whose worker does not report back within twenty minutes is handed out again;
after three attempts it is marked failed like any other scan. While no
worker has reported in for two minutes — none started, network down,
option switched on before the first worker — the scheduler tick runs queued
scans in the web container, so the option never stalls scanning. The
Scanning page lists the workers (name, Trivy version, running / completed /
failed, last seen) and the queue. Scale with `--scale scan-worker=3` or
`WORKER_CONCURRENCY`; each worker keeps its own Trivy database, or point
`TRIVY_SERVER_URL` at a shared Trivy server. Clair does not use workers: it
already fetches layers itself, from wherever it runs. Changing the backend applies to new scans; stored results keep the
label of the scanner that produced them. Turning scanning on later scans
images as they are pushed; *Re-scan everything* on the Scanning page (or the
`scan-stale` job with `olderThan=0s`) catches up on existing ones. What the
scans give you is described under
[Vulnerability scanning](#vulnerability-scanning).

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

The web app sets its own security headers on every response — a
Content-Security-Policy with a per-request nonce, `X-Content-Type-Options`,
`X-Frame-Options`, a referrer and a permissions policy, and
`Strict-Transport-Security` whenever the request arrived over TLS
(`X-Forwarded-Proto: https`). The registry sets none, so add HSTS on the
proxy for the `/v2/` route; the Traefik stack below does.

The registry emits relative `Location` headers for blob uploads and the web
app never reads forwarded headers, so nothing else is host-specific. Once
proxied, bind the published ports to loopback in `docker-compose.yml`
(`127.0.0.1:3000:3000`, `127.0.0.1:5000:5000`) so only the proxy reaches them.

### Single host with Traefik

`docker-compose.prod.yml` is the self-contained production stack for one
server: Traefik terminates TLS with Let's Encrypt and serves the UI and the
docker API on a single hostname (`/v2` goes to the registry, everything else
to the web app), so `docker login oci.example.com` and the browser share one
domain. Nothing is bind-mounted from the repository; the web container
generates the token key pair on first start.

```sh
scripts/deploy.sh root@server oci.example.com you@example.com
```

The script rsyncs this checkout to `~/chicoree` on the host, installs Docker
if it is missing, writes `.env` from `.env.prod.example` with fresh secrets
(first run only), and runs `docker compose -f docker-compose.prod.yml up -d
--build`. Re-run it to deploy changes. Requirements: DNS for the domain
pointing at the server, ports 80 and 443 open, and a user that can talk to
the Docker daemon.

Edit `.env` on the server for SMTP, S3 storage, sign-in providers, group
bindings, sign-up controls, branding, rate limits, or to pick a scanner
(`SCANNER`, `COMPOSE_PROFILES` — see [Scanner backends](#scanner-backends)). While
experimenting, set `ACME_CA_SERVER` to Let's Encrypt's staging endpoint so
failed attempts do not count against the production rate limit. Traefik's
read timeout is disabled on the HTTPS entrypoint so multi-gigabyte layer
uploads are never cut short. Image layers can live on a bigger disk or a mounted share instead of the
root filesystem: set `REGISTRY_DATA_DIR=/path/on/that/disk` in `.env` (make
the directory writable by uid 10001, the registry's user, and if it is a
network or virtiofs mount, order Docker after it with a
`RequiresMountsFor=` drop-in so a reboot does not start the registry on an
empty directory). Postgres stays on local disk on purpose.

Container logs are capped at 5 × 20 MB per service, Clair's download scratch
space is a 3 GB tmpfs, and each deploy prunes old build layers; without these
a full root disk takes Postgres down and the registry with it.

Back up the `pg-data`, `registry-data`, `token-keys` and `traefik-acme`
volumes (`trivy-cache` is only a cache; signing keys generated in the admin
panel live in Postgres).

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
   `AUTH_GROUP_BINDINGS`, sign-up controls, token policy, branding, rate
   limits. The file has no profiles, so both the `clair` and the `trivy`
   service are loaded: set `SCANNER` and delete the one you do not use
   (`TRIVY_SERVER_URL` defaults to the bundled server) — see
   [Scanner backends](#scanner-backends). Everything else is prefilled.
4. **Proxy timeouts.** Image layers stream through the proxy as large, slow
   uploads. In Coolify's proxy settings raise Traefik's entrypoint
   `respondingTimeouts.readTimeout` (and `idleTimeout`) for the registry
   domain to several minutes; Traefik does not buffer bodies, so no size limit
   is needed.
5. Deploy, open the UI domain, create the first account (it becomes the
   administrator), then `docker login cr.example.com` with an access token.

Data lives in the `pg-data`, `registry-data` and `token-keys` volumes; back
up all three. Rotate the token signing key without downtime under
*Administration → Signing keys* — see
[Signing-key rotation](#signing-key-rotation); the file key pair in
`token-keys` stays trusted as the fallback.

### Running several registryd replicas

A single `registryd` is enough for most installations, but the registry is
built so that several replicas can sit behind one load balancer. What has to
be shared, and what stays per replica:

| Concern | Shared how |
| --- | --- |
| Blob content | The storage backend (S3, bunny, or a filesystem every replica mounts). |
| Metadata | Postgres — already shared. |
| **In-flight uploads** | `STORAGE_STAGING=shared` (below). Without it upload sessions are node-local and the load balancer needs sticky routing on `/v2/*/blobs/uploads/*`. |
| Pull rate-limit counters | Postgres (`rate_limit_counters`): every replica draws from the same budget, one row upsert per limited request. |
| Traffic statistics and registry metrics | Per replica; traffic is flushed to Postgres every 10 s (a crash loses at most 10 s), `/metrics` counters are process-local — scrape every replica. |
| Proxy-cache downloads | The per-digest singleflight is per replica: two replicas asked for the same missing layer at the same moment both fetch it (the second finds the blob already stored and links it). |
| Signing keys | Read from Postgres by every replica (re-read every `TOKEN_KEY_RELOAD_INTERVAL`, and immediately on an unknown key id). |
| Job schedules | The web app takes an advisory lock, so only one web replica runs jobs. |

**Upload staging.** A blob upload is a session: `POST` opens it, one or more
`PATCH` requests append bytes, `PUT ?digest=` verifies and commits. Where
those bytes wait is `STORAGE_STAGING`:

- `local` (default) — files under `STORAGE_STAGING_DIR` on the replica that
  received them. Fast and simple; every request of a session must reach the
  same replica.
- `shared` — the session (offset, chunk list) lives in Postgres and the
  chunk bytes go to the storage backend under the reserved `_uploads/`
  prefix. Any replica can continue, inspect, cancel or commit any session;
  no sticky routing needed. Two replicas that append to the same session at
  the same moment are serialised: one wins, the other answers
  `416 RANGE_INVALID` with the offset to resume from (which is also what a
  client that retried a chunk sees). The commit streams the chunks through
  the digest check straight into the backend, and the blob only becomes
  visible once the digest matched; the chunks and the session row are
  deleted afterwards. Expired sessions (`UPLOAD_SESSION_TTL`, 24 h idle) and
  chunk objects that belong to no session are removed by the hourly sweep
  and by garbage collection (the `gc` job on *Administration → Jobs*).

`shared` works with every bundled driver — `s3`, `bunny` and `filesystem`
(on a shared mount). Run every replica in the same mode; a mixed fleet
behaves like `local`. *Administration → Health* shows the mode
("Upload staging: shared … · n in flight") and skips the staging-disk check
in shared mode. The proxy-cache path stages upstream downloads the same way,
so in shared mode a cache miss costs one extra write and read against the
backend.

**Example: two replicas behind Traefik.** Not enabled by default — adapt
`docker-compose.prod.yml` on a host with the capacity for it. Uploads in
flight are held in S3 here, so `registry-data` is not needed:

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
      # No sticky sessions needed with STORAGE_STAGING=shared. For
      # STORAGE_STAGING=local you would need instead:
      # - traefik.http.services.registry.loadbalancer.sticky.cookie=true
      # - traefik.http.services.registry.loadbalancer.sticky.cookie.name=registryd
```

Traefik's docker provider load-balances across the replicas of a service
automatically; `deploy.replicas` needs `docker compose up` (v2) and no
`container_name` on the replicated service. With `STORAGE_DRIVER=filesystem`
mount the same NFS/shared volume into every replica (`FILESYSTEM_ROOT`),
otherwise each replica has a different blob tree.

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

### Sign-up controls

*Administration → Auth providers → Access* (or the environment defaults)
decides who can register:

| Setting | Values | Environment default |
| --- | --- | --- |
| Sign-up | `open` (anyone), `invite` (only through an organization invitation), `closed` (no new accounts) | `SIGNUP_MODE=open` |
| Allowed email domains | list, subdomains included; empty = any | `SIGNUP_ALLOWED_DOMAINS=` (comma-separated) |
| Organization creation | `everyone` or `admins` | `ORG_CREATION=everyone` |

The rules apply wherever an account comes into existence: the sign-up form,
magic-link and email-code sign-ups, the first GitHub / Google / OIDC login,
and LDAP provisioning (browser and `docker login`). Existing accounts are
never affected, and the very first account on an empty instance is always
allowed — someone has to become the administrator. In invitation-only mode
the *Create an account* button in the invitation email still works for the
invited address; otherwise the sign-up page explains the situation and the
sign-in page hides its *Create an account* link. When organization creation
is restricted, non-admins see no *New organization* button and the API
refuses.

**Local sign-in.** *Local sign-in* on the same tab decides where password,
magic-link and email-code sign-in are offered (`LOCAL_SIGNIN=everyone|hidden|off`
as the default): *Everyone* is the normal sign-in page; *Hidden URL only*
removes those methods from `/sign-in` and keeps them working on
`/sign-in/<path>` (`LOCAL_SIGNIN_PATH`, default `local`) for a break-glass
administrator while everybody else uses SSO, LDAP or passkeys; *Off* refuses
them everywhere. The server enforces it: the auth endpoints reject local
attempts that did not come through the hidden page, and `docker login` with
an email and password is refused (access tokens keep working). Passkeys and
LDAP are never affected.

### Access token policy

The same *Access* tab (or the environment defaults) sets the rules every new
personal access token and service account must follow:

| Setting | Meaning | Environment default |
| --- | --- | --- |
| Longest lifetime (days) | Caps the presets and custom dates offered; 0 = unlimited | `TOKEN_MAX_LIFETIME_DAYS=0` |
| Every token must expire | Removes *Never*; a request without an expiry is refused | `TOKEN_REQUIRE_EXPIRY=false` |

The server enforces both regardless of what a form posts. Existing
credentials are never shortened. Seven days before a token or service
account expires its owner — the user, or the organization's owners and
admins — receives one email (*Settings → Notifications → Credential
expiring*); the reminder is sent by the `token-expiry` job, so schedule it
daily on *Administration → Jobs*. The *Administration* overview counts the
credentials expiring within seven days, never expiring and already expired,
and *Administration → Users → user* lists every token of an account with a
revoke button.

### Signing-key rotation

Registry tokens are five-minute JWTs signed with an ES256 key. Out of the
box that is the file key pair from `scripts/gen-keys.sh`
(`JWT_PRIVATE_KEY_FILE` for the web app, `JWT_PUBLIC_KEY_FILE` for the
registry) and nothing else is needed. *Administration → Signing keys* rotates
without downtime:

1. **Generate new key.** It signs every token from now on (its id travels in
   the JWT header). The registry learns about it within
   `TOKEN_KEY_RELOAD_INTERVAL` (default 60 s) — or at once, when the first
   token naming it arrives — and keeps trusting the previous key.
2. **Wait longer than five minutes**, the token lifetime, so every token
   signed with the old key has expired. *Administration → Health* shows
   whether the registry trusts the active key.
3. **Retire the old key.** Retiring is refused for the key that signs right
   now. `TOKEN_KEY_DROP_WINDOW` (default 10 min) after retirement the
   registry drops it and rejects anything still signed with it.

The page lists each key with its fingerprint, when it was created, activated
and retired, which one signs now, and whether the registry trusts it; the
file key is listed too and is always trusted. Private keys are stored
AES-GCM encrypted under a key derived from `AUTH_SECRET`; if that secret
changes the stored keys become unusable and the app falls back to the file
key. Every generate and retire is in the audit log.

### Branding

*Administration → Branding* sets the instance name and tagline (page titles,
sidebar, sign-in screens, emails), a PNG or SVG logo (at most 64 KB; replaces
the chicory mark), the accent colour, up to six footer links, and an
announcement banner shown at the top of every page. `info` and `warning`
banners can be dismissed (remembered per browser until the text changes),
`danger` banners cannot. `INSTANCE_NAME` and `INSTANCE_TAGLINE` are the
environment defaults; the page previews changes live.

**Edition** (`INSTANCE_EDITION`, `self-hosted` by default) says who the
landing page speaks to. *Self-hosted* addresses whoever runs the registry:
install it, create the first account, push your images. *Hosted service*
addresses customers of a registry run for them: the call to action is
"Create your account", the page names what a new account gets for free
(from the default limits under *Administration → Limits*) and, when an
[account portal](#account-portal) is configured, links to its plans. The
default tagline follows the edition until one is entered. Nothing about how
the registry works changes.

The same page holds two display switches: **Gravatar** (see [Pictures](#pictures)) and **Show
index members and artifacts in lists** (`SHOW_ARTIFACTS`, off by default).
With it off, the untagged list leaves out every manifest that belongs to a
multi-arch index that still exists (platform variants as well as BuildKit
attestation entries) and every attached artifact, tag lists leave out
cosign's `sha256-….sig` / `.att` / `.sbom` tags, and variants tables leave
out attestation entries — each with a one-line note saying how many are
hidden. None of them can be deleted on its own, and all remain on the index
page, on the Attestations tab and reachable by URL, so what is left in the
untagged list is what is really loose. That is only the default: every
user overrides it under *Settings → Display* (follow the instance, show,
or hide); anonymous visitors see the instance default. The logo is checked
exactly like the pictures of organizations, repositories and people — see
[Pictures](#pictures).

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

**Switching backends.** Blob rows in the database say *that* a blob exists,
the storage driver says *where*. Changing `STORAGE_DRIVER` on an instance that
already holds images therefore needs the `blobs/` tree copied to the new
backend first (every driver uses the same `blobs/sha256/<xx>/<digest>` layout,
so a plain file copy or an S3/Edge-Storage upload of that tree is enough);
otherwise pushes of known layers are deduplicated against the database and
pulls answer 404 for blobs the new backend never received. Keep the old copy
until a pull of every repository has been checked.

Adding a backend is one Go package: implement `storage.Driver`, call
`storage.Register` in `init()`, and blank-import it from
`registryd/cmd/registryd/main.go`.

**Range requests.** `GET /v2/<name>/blobs/<digest>` honours a single
`Range: bytes=…` header and answers `206 Partial Content` with
`Content-Range`, so resumable and parallel layer downloads (`containerd`,
`oras`, download managers) fetch only the bytes they need; an unsatisfiable
range gets `416`, a multi-range request the whole blob as `200`. Every blob
response carries `Accept-Ranges: bytes`. The filesystem backend seeks, S3 and
bunny.net pass the range on to the bucket or zone, and with presigned
redirects enabled the client repeats its `Range` header against the presigned
URL, which both services honour.

## How access works

- **Roles**: org `owner`/`admin` → pull, push, delete + manage the org;
  `member` → pull, push, create repositories; `viewer` → pull only (read
  access to private repositories without any way to change them). Public
  repositories are pullable by anyone, including anonymously. Instance
  admins can do everything. Switching a repository from private to public
  asks for confirmation.
- **`docker login` credentials**: personal access tokens (`chc_pat_…`, per
  user, read-only or read-write) and service accounts (`chc_sa_…`, per org,
  pull / push / admin) — both usable as the password with any username.
  Email+password also works, but only for accounts *without* two-factor
  auth; 2FA users must use a token.
- **Failed logins are throttled.** Five wrong passwords for one account, or
  thirty failures from one address, within fifteen minutes lock that account
  or address out of `docker login` for fifteen minutes (the response says so
  and carries `Retry-After`); a successful login clears the account's count.
  Counters live in Postgres, so every replica enforces the same budget, and
  every failure is an audit entry (`registry.login.failed` with the method
  and reason). Browser sign-ins are rate-limited by better-auth separately.
- **Email verification.** With a mail server configured, a password sign-in
  needs a verified address: an unverified account is refused and gets a fresh
  verification link with every attempt. The first account (the installer's
  administrator) is verified automatically, LDAP and SSO accounts by their
  provider, and administrators can mark any address verified under
  *Administration → Users*. Without a mail server the check is off.
- **Deleting an account.** *Settings → Security → Delete account* removes
  the account with its access tokens, signing keys, sessions and memberships
  — confirmed from the inbox when mail is configured, else with the password
  (or a fresh sign-in for accounts without one). The only owner of an
  organization has to transfer or delete it first, and the last instance
  administrator cannot leave.
- **Expiry and scoping.** *Settings → Access tokens* gives a token, besides
  its name and scope, an **expiry** (7, 30, 90 or 365 days, a custom date,
  or *Never* — within what the [token policy](#access-token-policy)
  allows), optionally an **organization** it is limited to and, within that,
  the **repositories** it may touch, and a description. A scope outside the
  restriction is simply not granted; a restricted token cannot use the jobs
  API or list the catalog even for an administrator, and a
  repository-limited token cannot create repositories on push. The list
  shows the expiry state (red inside the last week; expired tokens are greyed
  out), the last use with time and client address, and where the token may
  be used. **Rotate** creates a replacement with the same settings and
  lifetime, shows the new secret once and revokes the old token immediately.
  Service accounts (*Organization → Service accounts*) get the same expiry
  choices, last-use address and a *Rotate* that swaps the secret in place
  (same id, so pipelines only need the new secret).
- The web app's token endpoint (`/api/registry/token`) authorizes each
  requested scope against the database and signs a short-lived ES256 JWT;
  `registryd` verifies it with the trusted public keys and enforces the
  granted actions. The registry itself holds no credentials.
- Scopes of the form `repository:<name>:*` (what `skopeo delete` requests)
  expand to every action the caller may perform. Callers who may push also
  get `push` on a pull-only request — cosign reads with a pull scope before
  it attaches a signature, and the
  [signature policy](#require-signatures-pull-policy) lets pushers read an
  image blocked only for lack of a signature. Proxy-cache organizations
  grant `pull` only, whoever asks — see [Proxy caches](#proxy-caches); a
  [renamed or moved repository](#renaming-and-transferring) grants `pull`
  only under its former name.
- **Sessions.** *Settings → Security* lists every signed-in browser and
  device with its address, user agent, start, last activity and expiry.
  *Sign out everywhere else* revokes all sessions but the current one;
  administrators can revoke all sessions of an account from its user page.
  Both are audited.

## Search and READMEs

**Navigation.** The sidebar lists eight of the organizations you belong to:
the ones whose repositories you opened most recently first, then the ones you
joined most recently, then by name. When you are in more than eight, an
**All organizations** entry carrying the total follows them and opens
`/orgs`, which lists every organization you are a member of with your role,
its repository count and its storage, and gains a filter box once there are
more than eight. The navigation drawer on phones shows the same list.

**Finding images.** Every page has a search box (top of the sidebar; on
phones in the navigation drawer, plus a magnifier in the header). Press `/`
anywhere to focus it and `Esc` to close the suggestions or leave the box.
From two characters on the box suggests the best eight matches —
repositories, tags, image digests and organizations — and `Enter` opens the
full results page (`/search?q=…`). Search understands:

- **names and descriptions** of repositories (`alp` → `acme/alpine`), also
  as `org/name`;
- **tags** as `org/repo:tag` or just part of a tag name;
- **digests**: a full `sha256:…` digest or at least 12 hex characters of it
  finds every manifest that starts with it, with the tags pointing at it;
- **organizations** by name or slug.

Results only ever include what you may see: public repositories for
everyone, private ones where you are a member, everything for
administrators. `GET /api/search?q=` is the same typeahead as JSON (anonymous
callers get public data; anonymous calls count against the anonymous API
[rate limit](#rate-limits) per address). The **Explore** page (`/explore`)
opens with an overview: *Trending* (the most pulled repositories of the last
7 days), *Organizations* (everyone who publishes something you may see,
busiest first; a card drills down into that organization's images) and
*Recently updated*. *All images* (`/explore?view=all`) is the full list with
the same filter box plus organization, visibility (public / private / both)
and sort (most pulled, recently updated, name) controls; the filters live in
the URL, so a filtered view can be shared. Visitors share one cached copy of
the overview per minute.

**Without an account.** Explore, search, organization pages and public
repositories (tags, layers, scan results, compare) open without signing
in: visitors see exactly what an anonymous `docker pull` may fetch, in a
reduced shell with *Sign in* and, while sign-up is open, *Create an
account*. Everything else — the dashboard, settings, organization
management, administration — asks for a sign-in first. Public images pull
anonymously as well, within the anonymous [rate limit](#rate-limits).

**READMEs.** Owners and admins of an organization can write a README for
each repository under *Repository → Settings → General*: Markdown (GitHub
flavoured: tables, task lists, fenced code) with a live *Preview* tab that
renders it exactly as the repository page will. READMEs are limited to
64 KB and every save is in the audit log (`repo.readme`). Rendered READMEs
are sanitised: headings, paragraphs, lists, code, tables and links are kept;
scripts, styles, event handlers and other HTML are dropped; links get
`rel="nofollow noopener"`; images are only shown when they are served over
`https://` (relative and `http://` images are removed). When a repository
has no README, the page shows an **About** block built from the image
itself — the `org.opencontainers.image.*` labels and annotations of the
`latest` tag (else the newest tag): description, title, version, vendor,
licenses, authors, and links to source, website and documentation. Images
from Docker Hub, GHCR and most CI pipelines carry these already.

**Dashboard.** `/dashboard` is about you and your organizations, never
the instance. It shows one card per organization you belong to — your role,
repositories, pulls in the last 30 days, last push, members and size, with
shortcuts to *Members*, *New repository* and *Settings* as your role allows;
the six most recently pushed-to organizations are shown, the rest are one
click away under *Organizations* — followed by the push and delete feed
across those organizations, what you pushed yourself in the last 90 days
(with your account or one of its access tokens), a summary of your access
tokens (how many, how many expire within a week, last use) and any open
invitations addressed to your email address. The quick-start commands stay
until your first push. Instance-wide numbers live under *Administration →
Overview*.

**Stars and recently viewed.** Every repository page has a **Star** button
with the total count; star counts also show next to repository names on
organization pages, Explore and search results. The dashboard lists your
**Starred** repositories and the ones you **Recently viewed** (eight each,
*Show all* expands the list in place). Views are recorded per user at most
once a minute per repository; repositories you lose access to disappear
from both lists.

**Getting started.** New users see a *Getting started* card on the dashboard
with three steps — create or join an organization, create an access token,
push a first image (with the exact `docker login` / `docker tag` /
`docker push` commands for this registry and their organization). Steps tick
themselves off as soon as the database shows them done; the card disappears
when everything is done or when it is dismissed. Administrators get a
*Setup checklist* on *Administration → Overview* — outgoing email, sign-in
methods, vulnerability scanning, Prometheus metrics, garbage-collection and
retention schedules, branding, pull rate limits, a backup reminder and the
live health probe — each with its current state and a link to the page that
configures it; it can be dismissed per administrator.

## Pictures

Organizations, repositories and accounts can each carry a picture. It takes the
place of the generic icon or the initial-letter monogram wherever that entity
shows up: the sidebar and the navigation drawer on phones, the organization
list, Explore, search results and the search typeahead, every repository table,
the dashboard's shortlists and activity feed, the organization and repository
page headers, the member list, the *pushed by* line on a tag page, and the
administration screens.

| Picture | Where it is set |
| --- | --- |
| Organization | *Organization → Settings → General → Organization picture* (owners and admins) |
| Repository | *Repository → Settings → General → Repository picture* (owners and admins) |
| Your avatar | *Settings → Profile → Your avatar* |

Pick a file, check the preview, then **Save picture** (**Save avatar** on an
account); *Remove picture* followed by a save brings the icon back. Instance
administrators can set or clear somebody else's from *Administration →
Organizations → organization* and *Administration → Users → user*, and they
count as owners everywhere, so a repository's picture is theirs to change
through the repository's own settings.
Every change, by an owner or by an administrator, is in the audit log
(`org.logo`, `repo.logo`, `user.avatar`, `admin.org.logo`, `admin.user.avatar`)
with the media type and byte count, or as a removal.

Pictures are **PNG, SVG, JPEG or WebP** files of at most **64 KB** — the same
cap and the same checks as the instance logo under [Branding](#branding), so an
SVG that carries a `<script>`, an event handler (`onload=…`) or a reference to
an external file is refused. Nothing is resized or re-encoded: what you upload
is what is served.

A picture is always optional and nothing is inherited. A repository without one
shows the repository icon — never its organization's picture — and an account
without an avatar keeps its monogram, so no entity's picture ever stands in for
another's.

Organization and account pictures are shown to signed-in users; a repository's
picture follows the repository, so a public one is visible to anonymous
visitors and a private one only to members and instance administrators. The
bytes never travel inside a page: they are served from their own address
(`/api/logo/<kind>/<id>`), cached by the browser for a year and fetched again
only when the picture actually changes, so a fifty-row listing still carries no
image data.

**Gravatar.** *Administration → Branding* can let accounts without an uploaded
picture fall back to [Gravatar](https://gravatar.com). It is off by default,
because the viewer's browser then asks gravatar.com for the picture using a
hash of that person's email address. An address with no Gravatar keeps its
initials: the registry asks for `d=404` and the page falls back on its own.
An uploaded avatar always wins. `GRAVATAR=true` is the default for instances
configured through the environment.

## Paging through long lists

Long lists are paged, never silently cut off. A server-rendered list carries
its page in the URL, so a page is a link you can share and it survives a
reload; every other parameter (filters, search terms, the page of a second
list on the same screen) is kept when you turn the page, and changing a filter
starts over at page 1. Each control shows the slice and the total,
`151–200 of 334 entries`, with previous / next and, on wider screens, page
numbers. A page past the end, from a stale link or a filter that shrank the
list, lands on the last page instead of an empty table.

| Where | Rows per page | URL parameter |
| --- | --- | --- |
| Audit entries (`/admin/audit`, `/<org>/audit`) | 50 | `page` |
| CVE / package search (`/admin/security`) | 50 | `page` |
| Blocked images and accepted risks (Security pages) | 25 | `blocked`, `exc` |
| Job runs (`/admin/jobs`, `/admin/jobs/<job>`) | 25 | `page` |
| Users and organizations (`/admin/users`, `/admin/organizations`) | 50 | `page` |
| Repositories of an organization (`/<org>`) | 25 | `page` |
| Tags and untagged manifests (`/<org>/<repo>`) | 50 | `tags`, `untagged` |
| Mirror runs (*Repository → Settings → Mirror*) | 5 | `runs` |
| Recent activity (`/dashboard`) | 12 | `activity` |
| Explore (`/explore`) | 30 | `page` |
| Search results, per group (`/search`) | 20 | `repos`, `tags`, `digests`, `orgs` |

Screens holding more than one list give each list its own parameter, so paging
the tags of a repository leaves its untagged manifests where they were:
`/acme/alpine?tags=3&untagged=2`.

Three lists filter in the browser and therefore page in place, with no URL
parameter: an image's **Vulnerabilities** findings (25, 50 or 100 rows, chosen
next to the pager, 50 by default, and back to page 1 whenever a filter or the
search text changes), the **delivery log** of one webhook (10 per page; the
log is pruned to the newest 50 deliveries per hook, so five pages are all of
it) and the per-tag lines inside one **mirror run** (50).

A few tables are a deliberate top-N and say so in their heading rather than
pretending to be complete: *Top 8 by egress*, *Top 8 by pulls* and *Top 8 by
size* on *Administration → Metrics*, *Top 10 most affected* on the Security
pages, and the dashboard's *Starred* and *Recently viewed* cards with their
*Show all* toggle.

## Webhooks

Webhooks exist at two levels. **Repository webhooks** (*Repository →
Settings → Webhooks*, up to five) fire for events in that repository;
**organization webhooks** (*Organization → Settings → Webhooks*, up to ten)
fire for events in every repository of the organization, plus the
organization-level `quota.warning`, `quota.exceeded` and `quota.pruned`. Both share the same form — HTTP method
(POST/PUT/PATCH), extra headers, authentication (bearer token, basic auth or a
custom header; secrets are encrypted at rest) and an optional signing secret
that adds `X-Chicoree-Signature: sha256=<hmac>` so receivers can verify the
body — the same delivery log (the last 50 attempts per hook), retries on
network errors and 5xx, and *Send test*. A hook's **format** decides what
the body is: the JSON payload below, or one message for a chat service's
incoming webhook — **Slack** (Block Kit), **Discord** (an embed),
**Microsoft Teams** (an Adaptive Card for a Workflows webhook) or **plain
text** (`{"text": …}`, what Mattermost, Google Chat and Rocket.Chat accept).
Chat messages carry the event as a title, a few lines of detail (digest,
size, platform, findings, mirror counts, quota numbers, who did it) and a
link back to the image or repository; they are always POSTed. Each hook
picks the events it wants:

| Event | Fires when | Payload adds |
| --- | --- | --- |
| `push` | an image or tag is pushed | `tag`, `image` (digest, media type, layer list and sizes, platform, entrypoint/cmd/labels from the image config), `actor` |
| `delete` | a tag or manifest is deleted (UI, `skopeo delete`, `DELETE /v2/…`) | `tag` (null for deletes by digest), `tags` (every tag that pointed at the manifest), `digest`, `image`, `actor` |
| `scan.completed` | a vulnerability scan finished | `tag`, `tags`, `image`, `scan { status, summary, blocked, reason }` |
| `scan.blocked` | a scan put the image over the pull policy threshold | `tag`, `tags`, `image`, `reason` |
| `signature.blocked` | the signature policy blocked an image without a trusted signature (policy or key change, not the moment between an image push and its signature) | `tag`, `tags`, `image`, `reason` |
| `mirror.completed`, `mirror.failed` | a mirror sync finished or failed | `mirror { id, source }`, `run { id, status, matched, imported, skipped, failed, error }` |
| `retention.completed` | a retention run deleted (or, as a dry run, would delete) tags | `dryRun`, `deletedTags`, `deletedDigests`, `keptTags`, `policy`, `actor` |
| `repository.renamed`, `repository.transferred` | the repository got a new name or moved to another organization — see [Renaming and transferring](#renaming-and-transferring) | the repository block for the new name, `previous { organization, name, path }`, `actor` |
| `quota.warning` | usage reached 80 % / 95 % of a limit (organization hooks only) | `organization { slug, name }`, `quota { kind, used, limit, percent, threshold }`; `repository` is `null` |
| `quota.exceeded` | storage is above the limit; the first notice and the reminder before pruning (organization hooks only) | `organization { slug, name }`, `quota { kind: "storage", used, limit, pruneAt, reminder }`; `repository` is `null` |
| `quota.pruned` | the `quota-enforce` job removed images to meet the storage limit (organization hooks only) | `organization { slug, name }`, `quota { kind: "storage", used, limit, freed, tags, manifests, unmet }`; `repository` is `null` |

Every delivery carries the same envelope plus the headers `X-Chicoree-Event`
and `X-Chicoree-Delivery`; the `push` body is what earlier versions sent.

```json
{
  "event": "delete",
  "deliveryId": "2e4cf502-…",
  "timestamp": "2026-09-03T19:45:14.813Z",
  "registry": "cr.example.com",
  "repository": {
    "id": "…", "name": "alpine", "path": "acme/alpine",
    "organization": { "slug": "acme", "name": "Acme" },
    "visibility": "private", "url": "https://registry.example.com/acme/alpine"
  },
  "tag": "v1", "tags": ["v1"], "digest": "sha256:45e0…",
  "actor": { "type": "user", "id": "…", "name": "Admin" }
}
```

## Notifications

The people responsible get an email when something needs attention:

| Event | Who | Sent when |
| --- | --- | --- |
| `scan.blocked` | organization owners and admins | a scan pushes an image over the pull policy threshold (`docker pull` now answers 403) |
| `signature.blocked` | organization owners and admins | a policy or key change blocks images that carry no signature from a trusted key — see [Require signatures](#require-signatures-pull-policy) |
| `scan.completed` | organization owners and admins | every finished scan, with its severity summary — **off by default** |
| `mirror.failed` | organization owners and admins | a mirror sync fails |
| `webhook.failed` | organization owners and admins | a webhook delivery fails after its final retry |
| `quota.warning` | organization owners and admins | storage or repository usage reaches 80 % / 95 % of a limit — once per threshold, organization and 24 hours |
| `quota.exceeded` | organization owners and admins, or the account holder for an account limit | storage is above the limit: once when first seen, once more two days before pruning starts |
| `quota.pruned` | organization owners and admins, or the account holder | the `quota-enforce` job removed images to meet the limit, with what went |
| `job.failed` | instance administrators | a job run fails (manual, API or scheduled) |
| `token.expiring` | the token's owner, or the organization's owners and admins for a service account | a credential expires within seven days — once per credential, sent by the `token-expiry` job |

Every user chooses under *Settings → Notifications* which of these arrive by
email; everything is on except `scan.completed`. Emails use the SMTP settings
from *Administration → Email* and link to the image, mirror, delivery log,
organization, tokens or jobs page concerned. Organization webhooks can
subscribe to the same organization events, except `webhook.failed`;
`job.failed` and `token.expiring` never fan out to webhooks. For a Slack,
Discord, Teams or Mattermost channel, add an organization webhook with that
[format](#webhooks) and subscribe it to the events the channel should see.

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
- **`latest`**: registries only carry a `latest` tag if one was pushed. When
  the source has none, the mirror points `latest` at the newest imported image
  (highest version tag, otherwise the most recently built); untick the option
  in the mirror form to keep the repository exactly as the source has it.
- **Re-sync**: *Sync now* on the repository, the `mirror-sync` job on the
  admin Jobs page, or `POST /api/jobs/mirror-sync` from cron. Unchanged tags
  are skipped; mutable tags are re-imported when *overwrite* is on.

Imports go through the registry like any push, so quotas, dedup and
scanning apply, and the event log shows the mirror as the actor. An
immutable tag (see [Tag rules](#tag-rules)) stops a mirror from re-pointing
it; the run log records the refusal per tag.

## Proxy caches

An organization can be a **pull-through cache** of an upstream registry —
Docker Hub, GHCR, Quay, or anything else that speaks the OCI distribution
API, another Chicorée included. Pulling
`<registry>/<proxy-org>/<upstream path>:<tag>` serves the image from the
local cache when it is present and fresh; otherwise the registry fetches the
manifest and layers from the upstream on demand, stores them exactly like a
push (deduplication, quotas, the event log, webhooks, vulnerability scanning
and the pull policy all apply) and serves them. Later pulls, from any host in
your network, never leave the registry.

```sh
docker pull cr.example.com/dockerhub/alpine:3.20          # docker.io/library/alpine
docker pull cr.example.com/dockerhub/library/alpine:3.20  # same repository
docker pull cr.example.com/dockerhub/bitnami/redis:7.4    # docker.io/bitnami/redis
docker pull cr.example.com/ghcr/oras-project/oras:v1.2.0  # ghcr.io/oras-project/oras
```

**Setting it up.** Tick *Make this a proxy cache* on *New organization* and
pick the upstream (Docker Hub, GitHub Container Registry, Quay.io or a custom
URL), or open *Organization → Settings → Proxy* on an existing one. The tab
holds:

- the upstream — a preset fills in the API URL (`https://registry-1.docker.io`
  for Docker Hub);
- optional **credentials** (username + password or access token; stored
  encrypted and never shown again — the tab only says *configured*). A bare
  token without a username is sent as the Basic password;
- **Allowed images**: space-separated globs on the upstream path
  (`library/* bitnami/redis`; `*` also matches slashes). Empty allows
  everything; anything else answers `403 DENIED` with the pattern that failed;
- **Tag freshness** (default 300 s): how long a cached tag → digest mapping is
  trusted. After that the next pull revalidates the tag against the upstream
  with a `HEAD` request (free on Docker Hub) and only downloads when the
  digest changed. Pulls by digest never re-check;
- **Fetch from the upstream** (pause switch): unticked, cached images stay
  pullable but nothing new is fetched;
- **Test upstream**, which contacts the upstream with the values in the form
  (a `HEAD` of `library/alpine:latest` on Docker Hub, which also reports the
  remaining pull quota; `/v2/` elsewhere), and the outcome of the latest
  upstream contact (*last error*).

**Names.** The repository name is the upstream path, so it may have several
components (`bitnami/redis`, `org/team/app`) — only proxy organizations accept
names deeper than `<org>/<repo>`. Docker Hub's *library* images are stored
under their short name: `dockerhub/nginx` and `dockerhub/library/nginx` are
the same repository, shown as `dockerhub/nginx`.

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

**When the upstream is down**, cached tags keep working — a failed
revalidation serves the cached image and records the error on the proxy.
Images that were never cached fail with `502` and the upstream's reason.

**Eviction.** The `proxy-evict` job (*Administration → Jobs*, or
`POST /api/jobs/proxy-evict?unusedFor=30d`) removes tags in proxy
organizations that nobody pulled within the window (`dryRun=true` only
counts). They are fetched again on the next pull; run `prune-untagged` and
`gc` afterwards to reclaim the space.

## Layer deduplication

Blob content is stored once per digest and shared by every manifest and
repository that references it. Deleting a tag or manifest never removes
layers; garbage collection removes only content that no remaining manifest
references, and the registry refuses to delete a blob through the API while
a manifest in that repository still uses it.

## Comparing tags and shared layers

**Comparing two tags.** Every repository has a compare page: pick two
references in the **Compare** picker above the tag list (or press
**Compare** on a tag page and choose the other side there). The URL is
shareable:
`/<org>/<repo>/compare?from=<tag|digest>&to=<tag|digest>[&platform=linux/arm64]`.
The page shows a **summary** (digests, platform, size and layer count of
both images, when they were pushed and built, and the size / layer / config
/ findings deltas) and four sections:

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
- **Vulnerabilities** (when scanning is configured) — findings **new** in
  the target image, findings **fixed** since the source image, and the
  unchanged ones folded away. A finding is the pair *vulnerability id +
  package*, so a CVE that moved from one package to another shows up as
  fixed and new. Both images need a finished scan.
- **Annotations** — OCI annotations of the two manifests (index annotations
  included), same layout as the config section.

For multi-arch images the comparison runs on one platform: the first
platform both indexes offer is chosen and a **Platform** dropdown switches
to another. When the two images share no platform the page says so and
compares the first variant of each.

**Shared layers and storage.** On a tag page, the **Layers** tab has a
**Shared** column: *unique* when no other image references the layer,
otherwise *shared ×N*. Clicking it lists the other images (`org/repo:tag`,
or the digest for untagged manifests) — only those you may see; layers also
used by private repositories you cannot access are counted as *+N private*
and never named. The repository header carries a **Storage** line: the
*logical* size (every tag counted on its own), the *stored* size (distinct
layers, deduplicated) and how much of that is shared with other repositories
of the registry.

## Tag rules and retention

*Organization → Settings → Policies* and *Repository → Settings → Policies*
hold, next to the default visibility and the pull policy, the **Tag rules**
and **Retention** cards. Organization rules apply to every repository;
repository rules add to them and are shown as read-only *inherited* rows. An
organization retention policy is the default for all its repositories; a
repository can inherit it or replace it. Organization owners and admins (and
instance administrators) manage both.

### Tag rules

A rule is a glob over tag names (`*` matches anything, `?` one character,
everything else is literal; `v*`, `release-*`, `latest`) with two switches:

- **Immutable** — once the tag exists it cannot be re-pointed at a different
  image. Pushing the *same* image again is fine; anything else is refused by
  the registry with `403 DENIED`:

  ```
  denied: tag v1 is immutable (rule "v*"): it already points at sha256:45e09956dc66 and cannot be re-pointed
  ```

- **Protected** — the tag cannot be deleted, and neither can the image it
  names (deleting by digest would take the tag with it). `docker`/`skopeo`
  deletes and the trash button in the UI are both refused:

  ```
  denied: tag latest is protected (rule "latest") and cannot be deleted
  denied: manifest sha256:45e09956dc66 is tagged latest, which is protected (rule "latest"); the tag must be unprotected first
  ```

Tags covered by a rule carry an *immutable* / *protected* badge in the tag
list and on the tag page. Mirror imports go through the registry like any
push, so an immutable tag stops a mirror from re-pointing it. At most 50
rules per scope.

### Retention policies

A retention policy removes old tags and leftover images automatically. A
repository either *inherits* the organization policy or sets a *custom* one
that replaces it entirely. Fields:

| Field | Meaning |
| --- | --- |
| Keep the newest tags | The N most recently pushed tags always stay. |
| Always keep tags matching | Space-separated globs of tags that always stay, e.g. `latest v*`. |
| Delete tags older than (days) | Tags whose last push is older than N days are candidates. |
| Delete untagged manifests after (days) | Images no tag points at, pushed more than N days ago, are deleted. |

A tag is deleted when it is older than the *delete tags older than*
threshold (or, when only a keep count is set, whenever it is outside the
newest N) **and** nothing keeps it — a protected tag rule, a *keep matching*
pattern, or being among the newest N. `latest` gets no special treatment:
list it under *keep matching* if it must survive. Deleting a tag never
deletes the image itself; the manifest becomes untagged and the untagged rule
(or `prune-untagged`) picks it up later. Platform variants of a multi-arch
index that still exists, artifacts attached to another image (referrers) and
images with referrers are never removed by the untagged rule. Layer data is
reclaimed by the next garbage collection.

- **Preview** plans the values currently in the form (unsaved is fine)
  against the repository — or every repository of the organization; those
  with their own policy keep it — and lists what would go and why, plus what
  stays and why. Nothing is deleted.
- **Run now** applies the *saved* policy for that scope after a
  confirmation; the outcome is shown on the page and recorded as a
  `retention` job run.
- The **`retention`** job (*Administration → Jobs*, or
  `POST /api/jobs/retention`) walks every repository with an enabled policy.
  It is a dry run unless `dryRun=false`; `organization=<slug>` and
  `repository=<org/name>` narrow it down. The run result lists per-repository
  counts and up to 300 lines of what was (or would be) deleted with the
  reason; the Jobs page shows a summary with a *details* view. Schedule it on
  the Jobs page or from cron:

  ```sh
  curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs/retention?dryRun=false"
  ```

### Untagged manifests and deleting by digest

The repository page lists every **untagged manifest** — short digest
(copyable), media type and platform, size, when it was pushed, and badges for
*variant of `<tag>`* (a platform variant of a multi-arch index in the
repository), *attestation of `<tag>`* (see below), *referrer* (attached to
another image) and *N attached*. Owners and admins can delete an untagged
image by digest from there; members of an index that still exists are
refused — deleting one would break the index — and the page names the
index and its tags: delete the tag or the index and the next
*prune-untagged* run (or a retention policy) removes the member.

**`unknown/unknown` entries.** `docker buildx` stores the provenance and
SBOM attestations it generates as an extra entry of the image index, with
the placeholder platform `unknown/unknown` and the annotation
`vnd.docker.reference.type: attestation-manifest`. It is not an image:
`docker pull` never fetches it, `docker buildx imagetools inspect` and
`docker sbom` read it. The entry appears whenever a build records
provenance — on by default since Docker 24 / buildx 0.11 — or an SBOM
(`--sbom=true`); images built with plain `docker build` or with
`--provenance=false --sbom=false` have none. Its page says what it holds
(SLSA provenance, SPDX or CycloneDX SBOM, downloadable) and which variant
it describes; the variant's page links back under *Build attestations*.
Attestation entries are never scanned (the Re-scan button says so) and go
with their index. The untagged list hides them together with the other
index members and attached artifacts unless the viewer turned them on under
*Settings → Display* or the instance default (*Administration → Branding →
Show index members and artifacts*) is on.

The tag page's **Delete image** button removes the manifest by digest
together with *every* tag pointing at it — the confirmation lists those
tags. It is disabled while a protected tag names the image or the image
belongs to an existing index. `docker pull …@sha256:…` answers
`manifest unknown` afterwards; layers stay until garbage collection.

## Renaming and transferring

*Repository → Settings → Danger zone* offers, for owners and admins:

- **Rename** — the repository gets a new name inside its organization.
- **Move to another organization** — pick any organization you are an
  owner or admin of (instance administrators see them all). The target's
  repository and storage quotas are checked first; layers the target
  organization already holds are not counted again. Repository-scoped tag
  rules, retention policy, webhooks, mirrors and scan results move with the
  repository; organization-wide rules, retention defaults, webhooks and the
  pull policy of the old organization stop applying and those of the new one
  take over (the pull policy is re-evaluated right after the move). Members
  of the old organization lose access unless the repository is public;
  service accounts and access tokens restricted to the repository lose it.

Both show a confirmation that lists the consequences and the new
`docker pull` reference. Afterwards the **old name keeps working for pulls**:
`docker pull`, tag lists, referrers and blob downloads of the former
`<org>/<name>` are served from the new location, and the old web address
answers a permanent redirect. Pulls through the old name are authorized
against the new location, so a repository moved into a private organization
is not reachable through its old public name. Pushes and deletes against the
old name are refused so nothing lands in a stale place:

```
denied: repository moved to acme/alpine2; push to the new name (create a repository with the old name in the web UI to reuse it)
```

Repositories in proxy-cache organizations cannot be renamed or moved (their
names are the upstream paths).

**Moving many repositories at once.** *Administration → Organizations → Move
repositories…* (`/admin/organizations/move`) moves a whole batch into one
organization. Instance administrators only, and membership of neither side is
needed. Pick the target, then select from every repository on the instance:
filter by organization, by name or both, *Select all shown* ticks what the
filter leaves visible, and repositories already in the target are greyed out.
**Preview** writes nothing. Per repository it says *will move*, or why it will
be skipped (*name taken*, *proxy source*, *proxy target*, *repository quota*,
*storage quota*, *invalid name*, *already there*), and it shows the bytes that
are new to the target, layers it already stores costing nothing, together with
the resulting storage and repository counts against its limits. The preview
folds each accepted repository into the next check, so it also catches a name
collision between two selected repositories and counts a layer shared by two
of them once. The confirmation spells out the same consequences as a single
transfer; the run then moves the repositories one at a time, continues past
failures and lists what moved and what did not, with a link to each new
location. One run moves at most 50 repositories, which keeps the target's
quotas measured against what has actually landed. Every repository is audited
as `repo.transfer` in both organizations exactly as a single transfer is, and
the run adds one `repo.bulk_transfer` summary entry on the target.

**Moving one image.** A tag page has a **Move or copy** button that writes a
single image into another repository, in this or any other organization you
may push to. *Copy* leaves the source tag where it is; *Move* deletes it once
the destination has the image. The modal also asks for the destination
organization, the repository (an existing one, or a new name) and the
destination tag, and shows the `docker pull` reference you end up with.

Nothing is re-uploaded. Layers are content-addressed and already stored, so
they are linked into the destination with the OCI cross-repository blob mount
and the manifests are replayed byte for byte. The destination therefore serves
the identical digest, and the copy costs a few HTTP round trips however large
the image is. A multi-architecture index brings every platform variant with
it, and so do the cosign signatures, in-toto attestations and SBOMs attached
to the image, whether they hang off it through the referrers API or under
cosign's `sha256-<hex>.sig` / `.att` / `.sbom` tags; the destination
re-verifies them against its own trusted keys.

What stays behind belongs to the repository rather than to the image: pull
counts and traffic statistics, repository-scoped tag rules and retention
policies, webhooks and mirrors. Vulnerability reports are stored per image
digest, so the destination shows the same findings and is scanned again on
arrival like any other push.

The rules are a push's rules: write access on both sides, neither of them a
proxy cache, and the destination organization's quotas. A destination
repository that does not exist yet is created with the organization's default
visibility after its repository quota is checked, and only bytes new to the
destination organization count against its storage quota. An immutable
destination tag pointing at a different image is refused, a protected source
tag can be copied but not moved away, and an image opened by digest (an index
child) can only be copied. After a move the source tag is removed through the
normal deletion path, so `latest` follows the newest remaining image if it
pointed at what you moved; a source manifest left without any tag stays
untagged until retention or `prune-untagged` removes it, and its layers live
on as long as the copy references them. The push into the destination and the
delete in the source are ordinary registry operations, so they appear in the
event log, fire the repository's `push` / `delete` webhooks and start a scan
of the copy; both outcomes are audited as `image.copy` / `image.move` in both
organizations.

**Renaming an organization.** *Organization → Settings → Danger zone →
Change the organization slug* (owners only; `library` cannot be renamed).
The slug is the image namespace, so `<registry>/<old-slug>/<repo>` keeps
working for pulls and every web address under `/<old-slug>` redirects to the
new one; pushes to the old namespace are refused with the new name. Members,
repositories, service accounts, webhooks, rules and policies are unchanged.
Update CI pipelines that push.

**Reusing old names.** An old name stays reserved for the redirect until
somebody creates a repository (or organization) with it through the web UI;
that ends the redirect and the new repository is served under the name from
then on. Registry pushes never re-create a redirected name. The Danger zone
lists the former names still redirecting to a repository or organization.
Renames and transfers fire the `repository.renamed` /
`repository.transferred` [webhooks](#webhooks) and are audited as
`repo.rename`, `repo.transfer` (recorded in both organizations) and
`org.rename`.

## Vulnerability scanning

Every pushed image is scanned in the background by the configured backend
(Clair or Trivy — see [Scanner backends](#scanner-backends)) and the result
lives next to the tag (*Vulnerabilities* tab), in the tag list (severity
chips), on the organization's *Security* tab and on *Administration →
Security*. Mirrored and proxied images are scanned like pushes. Re-scan
periodically — vulnerability databases keep updating: the `scan-stale` job
re-scans tagged images whose last scan is older than `olderThan` (default
`7d`), never ran or failed, and *Administration → Scanning* has
**Re-scan everything** (`olderThan=0s`, 500 images per run) plus the
*Re-scan* button on each tag page for administrators. Clair needs a few
minutes after first boot to download its databases; earlier scans may come
back empty.

**The Vulnerabilities tab** shows findings the same way whichever scanner
produced them: severity, advisory id (linked to the advisory), package and
installed version, the fixed version, and the package type (OS package or
library), with the scanner that produced the report. The toolbar filters by
severity, *fix available* and a free-text search over id, package and title.
Multi-arch tags list their platform variants with each variant's own report.

**Blocking vulnerable pulls.** *Organization → Settings → Policies* sets a
severity threshold (critical, high, medium or low and above, optionally
counting unrated findings); every repository can inherit it, switch it off
or set its own under *Settings → Policies*. Images whose last scan reports
findings at or above the threshold get a *pull blocked* badge, the registry
answers pulls with `403 DENIED` and the reason, and multi-arch images are
blocked when any variant is. Unscanned and unscannable images are never
blocked; pushes are never affected.

**Accepted risks (exceptions).** Organization owners and admins can
**accept** a finding from the tab: a dialog asks for the scope (this
repository or the whole organization), whether the acceptance is limited to
the package the finding was reported in, a justification and an expiry
(never, 30 / 90 / 180 / 365 days). Accepted findings stay in the report,
struck through with the justification, and no longer count against the pull
policy: an image blocked only by accepted findings becomes pullable within
seconds, and revoking the exception blocks it again. Exceptions are listed
with a *Revoke* button on the organization's *Security* tab and on
*Administration → Security*; every creation and revocation is in the audit
log (`security.exception.create` / `security.exception.revoke`). Expired
exceptions stop applying as soon as blocks are recomputed — any scan of the
repository, a policy change, or the `exceptions-expire` job (schedule it
hourly under *Administration → Jobs*; it also deletes exceptions expired for
more than 30 days).

**Security pages.**

- **Organization → Security** (`/<org>/security`, every member): severity
  totals over the organization's tagged images (each multi-arch variant
  counted, identical images once, accepted risks excluded), how many images
  are scanned / waiting / failed, the most affected repositories, the images
  the pull policy currently blocks, and the exceptions.
- **Administration → Security** (`/admin/security`): the same for the whole
  instance plus **Find images by vulnerability**: type a CVE or GHSA id (or
  a package name) and get every tagged image containing it — organization,
  repository, tag, the affected variant, severity, fixed version, whether
  the risk was accepted and whether pulls are blocked.
- **Administration → Scanning** (`/admin/scanning`): the backend picker
  (Clair URL, Trivy server URL and timeout), a **Test** button that probes
  the entered values without saving (Clair: liveness and updater freshness;
  Trivy: binary version, database age or server health), the last ten scans
  with their state and scanner, pending / failed counts, and *Re-scan
  everything*.

After upgrading from a Clair-only version, run the `scan-normalize` job
once: it converts stored scans into the normalised findings behind the CVE
search and the security pages (rows are also converted lazily the first
time their tag page is opened, so the job is optional).

## Signatures and SBOMs

Every tag page has an **Attestations** tab that lists what is attached to
the image: cosign signatures, SBOMs (SPDX / CycloneDX), SLSA provenance and
any other OCI referrer. Chicorée reads both ways of attaching artifacts:

- the **OCI referrers API** (`subject` in the manifest — what cosign v3,
  `oras attach` and `cosign … --registry-referrers-mode=oci-1-1` push);
- cosign's **tag convention**: `sha256-<digest>.sig`, `.att` and `.sbom`
  tags in the same repository (cosign v2, `cosign attach signature|sbom`).

For a multi-arch image the tab shows what is attached to the index and to
each platform variant (`cosign sign --recursive` signs all of them). An
empty tab offers the sign-and-attach commands only to people who may push
to the repository; visitors and read-only members see a plain note.

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
who generated the document; **Download SBOM** hands out the document itself
(for attested SBOMs the predicate of the in-toto statement; *raw envelope*
gives the DSSE/bundle bytes) from
`GET /api/artifacts/<repository id>/<artifact digest>[?raw=1]`. The
provenance card summarises the SLSA predicate (v1 and v0.2): builder, build
type, source repository and commit, entry point, invocation, build times,
dependencies and parameters. Attestations are verified with the same trusted
keys and carry their own status. Images with a verified signature get a
**signed** shield in the repository's tag list and on the tag page.
**Re-verify** (members and up) re-checks everything attached to the image.

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

### Personal signing keys

Whoever may push to a repository may also sign what they push. Under
*Settings → Signing keys* every user registers the public keys that belong
to them (name + PEM of a `cosign.pub`, at most 10; a public key belongs to
exactly one account). A signature or attestation made with a personal key
counts as **verified** in every repository its owner may push to: members
with the *owner*, *admin* or *member* role of the organization, and
instance administrators everywhere. Viewers' keys never count, banned
accounts' keys neither. The Attestations tab then reads *verified by
Alice's key laptop*, with the owner named, so a personal signature is
always attributable.

Organizations decide whether they accept this: the **Members' signing
keys** card under *Organization → Settings → Policies* (on by default)
switches personal keys off for organizations that want only their own
trusted keys to count — a release pipeline with a single signing key, say.
Signatures are re-verified when a personal key is added or removed (in the
background, across every organization the owner may push to), when the
switch changes, and when a member is removed or changes role. Losing push
access does not retroactively unverify: a signature stays *verified* until
its next check, then shows as *unverified* again. The `reverify-signatures`
job re-checks everything (optionally one `organization=`) for changes made
outside the UI.

### Keyless signatures (Sigstore)

`cosign sign` without a key — from GitHub Actions, GitLab CI or a browser
login — puts a short-lived Fulcio certificate and a Rekor transparency-log
entry next to the signature instead of a public key. Chicorée verifies the
whole chain: the certificate must chain to the Sigstore root and carry a
valid certificate-transparency SCT, the Rekor entry must be signed by the
log and cover this signature, the certificate must have been valid when
the log recorded it, and the signature must check out under the
certificate's key. That holds for cosign v3 bundles (referrers) and for
the v2 tag convention (`.sig` / `.att` with the `dev.sigstore.cosign/*`
annotations); a legacy signature made without Rekor cannot be verified and
says so. The Attestations tab shows the identity (email or workflow URI),
the OIDC issuer and when the log saw the signature.

A verified chain only proves *who* signed. Whether that counts is the
**Trusted keyless identities** card under *Organization → Settings →
Policies* (and per repository): an issuer plus a subject pattern, e.g.
`https://token.actions.githubusercontent.com` with
`https://github.com/acme/app/.github/workflows/release.yml@refs/tags/*`, or
`https://accounts.google.com` with `*@example.com`. A keyless signature
whose verified identity matches one of them is **verified** (the card
says *verified by identity release workflow*) and satisfies the signature
policy like a trusted key; one that verifies but matches nothing stays
*keyless* with a hint to trust it. Adding or removing an identity
re-verifies every signature in scope. The trusted root comes from the
public Sigstore instance (vendored from `sigstore/root-signing`); set
`SIGSTORE_TRUSTED_ROOT=/path/trusted_root.json` for a private instance or
a newer snapshot.

### Require signatures (pull policy)

The **Require signatures** card on the same pages refuses pulls of images
that carry no cosign signature verified by a trusted key, a trusted
keyless identity, or (unless the organization switched them off) the
personal key of a member who may push. The organization switch applies
everywhere; a repository can inherit it, require signatures, or opt out.
`docker pull` then answers:

```
denied: pull blocked by policy: no signature from a trusted key or identity (signature policy)
```

Rules: attached artifacts (signatures, attestations, SBOMs, anything with a
`subject` or under a cosign tag) are never blocked; a signed multi-arch
index covers its platform variants; a vulnerability block and a signature
block can apply to the same image — the reason lists both. The policy
targets **consumers**: credentials that can only pull (viewers, pull
service accounts, read-only access tokens, anonymous pulls of public
repositories) get the 403. Whoever may push to the repository (owners,
admins, members, push service accounts, read & write tokens) can still read
an image blocked only by the signature policy — they are the ones who sign
it, and `cosign sign` has to fetch the manifest before it can attach the
signature. The vulnerability policy has no such exemption. While the policy
is on, blocks are recomputed on every push (pushing an image first and its
signature a few seconds later is fine: the image is blocked only in
between), and always when trusted keys change, when the policy changes and
on *Re-verify*. With no trusted key in scope the policy blocks every image,
which the card points out. The tag page shows the block notice with the
policy that caused it, and the `signature.blocked`
[notification](#notifications) is sent when a policy or key change blocks
images.

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
```

Set them under *Administration → Users / Organizations*, where usage is shown
against each limit. Owners and admins are emailed when an organization reaches
80 % or 95 % of a limit — see [Notifications](#notifications).

**Over the limit.** A lowered limit never deletes anything by itself: pulls
keep working and only pushes that need new layers are refused. The
`quota-enforce` job (*Administration → Jobs → Over the limit*) is how an
instance gets its space back when owners do not act. Each run records who is
above a storage limit — an organization against its own limit, an account
against its pool — mails the owners once with the date pruning starts, mails
again two days before it, and after `graceDays` (default 14) removes the
oldest images until the limit is met: untagged leftovers first, then tags by
last push, taking an image with its last tag and its variants and
attestations with it. Protected tags and the images they name are never
removed; if they alone keep a target over the limit, the job says so and
pushes stay refused. Garbage collection runs afterwards. The job is a dry
run until scheduled with `dryRun=false`; targets that fit again are
forgotten. Both notices are also webhook events (`quota.exceeded`,
`quota.pruned`) and can be switched off per user under *Settings →
Notifications*.

**Which limit applies.** An organization's own limit governs it alone: when
an organization has, say, a storage limit of its own, the owners' account
storage limits are not consulted for pushes into it, and its storage does not
count against their accounts. Account limits cover the owner's organizations
that have no limit of that kind — their shared pool. So an administrator can
give one organization a large allowance of its own while the owner's other
organizations keep sharing the account's.

**Members.** An organization can also be capped at a number of members (any
role). An open invitation holds a seat until it is accepted or cancelled, so
inviting is refused when members plus open invitations would reach the limit;
accepting and group-binding logins are refused when the members alone have.
The members page shows *n of m members* and disables inviting when full.

**Defaults for new accounts and organizations.** *Administration → Limits*
gives every account that signs up and every organization that is created a
limits row with the values set there (administrators are exempt; existing rows
are untouched). `DEFAULT_USER_MAX_ORGANIZATIONS`, `DEFAULT_USER_MAX_PUBLIC_REPOS`,
`DEFAULT_USER_MAX_PRIVATE_REPOS`, `DEFAULT_USER_MAX_STORAGE_GIB`,
`DEFAULT_ORG_MAX_PUBLIC_REPOS`, `DEFAULT_ORG_MAX_PRIVATE_REPOS`,
`DEFAULT_ORG_MAX_STORAGE_GIB` and `DEFAULT_ORG_MAX_MEMBERS` are the environment
defaults for that section. Without defaults, accounts and organizations stay
unlimited until an administrator sets limits by hand — as before.

**Label.** Each limits row carries a label ("Team", say) and a note only
administrators see. While an [account portal](#account-portal) is configured,
owners see the label with their usage on *Settings* and *Organization →
Settings*; without one, nothing about limits is shown to users — a
self-hosted registry keeps its limits an administration matter. The [REST API](#rest-api) reads and writes limits rows
(`GET/PATCH/DELETE /api/v1/orgs/{org}/limits`, `/api/v1/users/{userId}/limits`),
looks accounts up (`GET /api/v1/users?email=…`) and reports usage with the
month's traffic (`GET /api/v1/orgs/{org}/usage`, `GET /api/v1/me/usage`), so
an external system can drive limits.

### Account portal

*Administration → Limits → Account portal* (`PORTAL_URL`, `PORTAL_LABEL` as
defaults) links an external service where people manage their account — a
billing portal, a company directory. With a URL set, *Settings* and
*Organization → Settings* show a **Manage** button next to the usage. It asks
the registry for a one-time sign-in token (valid three minutes) and opens the
portal as `<url>?token=…` — plus `&organization=<slug>` from an organization's
settings. The portal exchanges the token server-side:

```
POST https://registry.example.com/api/auth/one-time-token/verify
Content-Type: application/json

{ "token": "…" }
```

The answer carries the session and the user (id, email, name), so the portal
knows who arrived without a second login. The token endpoint is only
registered while a portal URL is configured.

## Rate limits

*Administration → Rate limits* caps how many image pulls a client may make in
a window, Docker Hub style: every manifest request (`GET` or `HEAD`) counts
as a pull, blob downloads never do.

| Setting | Applies to | Example |
| --- | --- | --- |
| Anonymous clients | per client IP address | `100/6h` |
| Authenticated clients | per user or service account | `200/6h` |
| Trusted proxies | CIDRs whose `X-Forwarded-For` is believed | `10.0.0.0/8` |

Limits are written as `<count>/<window>` with a window in `s`, `m`, `h` or
`d`; an empty field means unlimited. Changes apply within 30 seconds. The
counters live in Postgres and the window is aligned to the wall clock (an
hourly limit resets on the hour), so several `registryd` replicas enforce one
budget rather than one each. If the database is unreachable the registry
serves the pull instead of refusing it.
`RATE_LIMIT_ANONYMOUS`, `RATE_LIMIT_AUTHENTICATED` and
`RATE_LIMIT_TRUSTED_PROXIES` are the defaults while the section has never
been saved (both the web app and `registryd` read them).

Every limited response carries `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset` (seconds until the window restarts) and
`RateLimit-Policy: <count>;w=<window seconds>`. Over the limit the registry
answers `429 Too Many Requests` with the OCI error code `TOOMANYREQUESTS` and
a `Retry-After` header:

```
HTTP/1.1 429 Too Many Requests
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 4711
Retry-After: 4711
{"errors":[{"code":"TOOMANYREQUESTS","message":"pull rate limit exceeded: 100 pulls per 6h for anonymous clients; sign in for a separate budget; retry in 4711s"}]}
```

Instance administrators, the web app's own reads, mirrors and proxy caches
are never limited. Counters are per registry replica (three replicas behind
a load balancer give a client three budgets). The client address is the
connecting peer unless that peer is listed under trusted proxies, in which
case the *last* `X-Forwarded-For` hop is used — never the first, which
clients can forge.

## Administration

- **Overview** (`/admin`): instance statistics, the last job runs, the
  credentials expiring soon, and the dismissible *Setup checklist* — see
  [Search and READMEs](#search-and-readmes).
- **Users** (`/admin/users`): role, ban/unban, limits, memberships, the
  user's avatar, their access tokens with a revoke button, *Revoke all
  sessions*, and **impersonation** — act as the user in a separate session; a
  banner shows who you are impersonating with a one-click stop.
- **Organizations** (`/admin/organizations`): usage vs limits, members and
  their roles, repositories, the organization's picture, proxy-cache
  configuration, and deletion — without having to be a member. *Move
  repositories…* moves a whole batch into one organization; see
  [Renaming and transferring](#renaming-and-transferring).
- **Jobs** (`/admin/jobs`): run maintenance jobs, schedule them and see
  their history — see [Job schedules](#job-schedules).
- **Scanning** (`/admin/scanning`) and **Security** (`/admin/security`):
  the scanner backend, recent scans and *Re-scan everything*; instance-wide
  severity totals, blocked images, accepted risks and the CVE search — see
  [Vulnerability scanning](#vulnerability-scanning).
- **Metrics** (`/admin/metrics`) and **Health** (`/admin/health`) — see
  [Monitoring](#monitoring) and [Health](#health).
- **Audit** (`/admin/audit`): every change made through the app — see
  [Audit log](#audit-log).
- **Email**, **Auth providers**, **Branding** and **Rate limits**: instance
  settings, with the environment as fallback — see
  [Settings in the admin panel](#settings-in-the-admin-panel).
- **Signing keys** (`/admin/settings/keys`): generate and retire the keys
  that sign registry tokens — see
  [Signing-key rotation](#signing-key-rotation).

## Audit log

Every change made through the app is recorded: sign-ins and sign-ups (and
failed attempts), password / two-factor / passkey changes, organization,
member and invitation changes, repository visibility, README, rename,
transfer (single and in bulk) and deletion, the pictures of organizations,
repositories and accounts, image copies and moves, organization renames, tag
deletion, access tokens and service accounts (creation, rotation, revocation),
webhooks, mirrors, pull and signature policies, trusted signing keys and
re-verification, accepted risks, token signing keys, admin actions (roles,
bans, limits, impersonation, session revocation), instance settings and job
runs. Each entry carries who (with the impersonating admin when applicable),
what, the target, the organization, a small redacted details object, the
client IP and user agent.

- **Instance-wide**: *Administration → Audit* — search over actor / target /
  action, filter by action group, organization and date range, 50 entries per
  page, expand a row for the details. *Export CSV* downloads the current
  filter (up to 10 000 rows) from
  `GET /api/admin/audit.csv?q=&action=&org=&from=&to=`.
- **Per organization**: owners and admins get an *Audit* tab on the
  organization (`/<org>/audit`) with that organization's entries and the same
  CSV export scoped to it.
- **Retention**: `AUDIT_RETENTION_DAYS` (default `365`). Older rows are
  pruned opportunistically — at most once an hour, when an entry is written.

## Monitoring

*Administration → Metrics* shows traffic per day, the busiest and largest
repositories, storage per organization, scan results, account activity and
the outcome of mirrors, webhooks and jobs.

**Traffic.** The registry counts the bytes that actually move, per
repository and day: **egress** (bytes served for blob and manifest downloads;
a partial download counts what was sent), **redirected** (blob sizes handed
to the storage backend through a presigned redirect — `S3_REDIRECT_GET`,
`BUNNY_CDN_URL` — shown separately because those bytes leave S3 or the CDN,
not the registry) and **ingress** (bytes received for successful layer
uploads and manifest pushes). The Metrics page shows egress and ingress per
day for the last 30 days, the repositories with the most egress and totals
per organization; every organization and repository page shows its own
egress next to the pull counts with an *Egress per day* chart. Counters are
aggregated in memory and written every 10 seconds (and on shutdown), so a
hard crash loses at most the last few seconds.

The same numbers (plus pulls, tags, storage and traffic per repository) are
available to Prometheus at `/api/metrics` once the endpoint is enabled on that
page. Every scrape must carry the bearer token shown there; the page prints a
ready-made `prometheus.yml` block. All values are computed from the database
at scrape time, so they are correct across restarts and replicas. Metric
names start with `chicoree_`, for example `chicoree_registry_up`,
`chicoree_storage_bytes{kind="physical"}`,
`chicoree_repository_pulls_total{organization,repository}`,
`chicoree_repository_egress_bytes_total{organization,repository}`,
`chicoree_traffic_bytes_total{direction="egress"|"ingress"|"redirect"}`,
`chicoree_vulnerability_findings{severity}` and
`chicoree_scanner_up{backend="clair"|"trivy"|"off"}`. Operational series
cover the last outcome of every job
(`chicoree_job_last_run_status{job,status}`,
`chicoree_job_last_success_timestamp_seconds{job}`), the oldest pending
scan, failing webhooks and recent deliveries, mirror and proxy-cache
status, organization storage against its limit
(`chicoree_organization_storage_{bytes,limit_bytes,ratio}{organization}`),
today's events and traffic, and the effective rate-limit configuration.

**Two scrape targets, one token.** `registryd` serves its own process
metrics at `GET /metrics` (also `/internal/v1/metrics`): request counts and
latency per route, bytes moved, rate-limit rejections, proxy-cache hits and
upstream requests, staging disk space and the Go runtime. Both endpoints
accept the same bearer token — the one *Administration → Metrics* shows.
Enabling the endpoint there enables both; the registry picks the change up
within 30 seconds, no restart needed. Until then it answers 404; a wrong or
missing token gets 401. The Metrics page prints a ready-made
`prometheus.yml` block with both jobs; the equivalent by hand, with the
token in a file:

```yaml
scrape_configs:
  - job_name: chicoree
    metrics_path: /api/metrics
    authorization:
      credentials_file: /etc/prometheus/metrics-token
    static_configs: [{ targets: ["web:3000"] }]
  - job_name: chicoree-registryd
    metrics_path: /metrics
    authorization:
      credentials_file: /etc/prometheus/metrics-token
    static_configs: [{ targets: ["registryd:5000"] }]
```

`deploy/prometheus/prometheus.example.yml` is that file, plus a 60 s scrape
interval and `deploy/prometheus/alerts.yml`. Keep the job names — the
dashboard and the alert rules refer to `chicoree` and `chicoree-registryd`.
For instances configured without the admin panel, `METRICS_ENABLED=true` and
`METRICS_TOKEN` on the web app and the same `METRICS_TOKEN` on `registryd`
do the same job.

**registryd metrics.** All names start with `chicoree_registryd_`:

| Metric | Labels | Meaning |
| --- | --- | --- |
| `http_requests_total` | `method`, `route`, `status` | requests by route template (`manifest`, `blob`, `upload`, `tags`, `referrers`, `catalog`, `base`, `internal`, `metrics`, `other`) — never repository names |
| `http_request_duration_seconds` | `route` | latency histogram |
| `http_in_flight` | | requests being served right now |
| `upload_bytes_total` | | bytes received for committed uploads and manifest pushes |
| `blob_bytes_served_total` | `mode` = `stream` / `redirect` | blob bytes streamed by the registry, or handed to S3 / the CDN through a redirect |
| `rate_limited_total` | `subject` = `anonymous` / `authenticated` | pulls refused with 429 |
| `proxy_upstream_requests_total` | `kind` = `manifest` / `blob`, `result` = `ok`, `not_found`, `unauthorized`, `denied`, `rate_limited`, `error` | requests the pull-through proxy made upstream |
| `proxy_cache_hits_total`, `proxy_cache_misses_total` | `kind` | proxied requests served locally vs. fetched |
| `staging_free_bytes` | | free space on the filesystem holding `STORAGE_STAGING_DIR` (−1 when unknown) |
| `storage_driver_info` | `driver` | always 1 |
| `build_info` | `version`, `go` | always 1 |

plus the standard `go_*` and `process_*` series. Counters live in the
process: with several `registryd` replicas scrape each one (Prometheus sums
them), and a restart resets them — the web app's `chicoree_*` totals are the
durable numbers.

**Alert rules and dashboard.** `deploy/prometheus/alerts.yml` ships 18
rules (`severity: critical` or `warning`): web scrape failing, registry
down, scanner unreachable with scans waiting, scans failing, scan backlog
growing or stale, webhook deliveries failing, a job's last run failed,
mirror sync failed, proxy upstream failing, no successful GC in 7 days,
> 5 % 429s, > 5 % 5xx, slow manifests (p95 > 2 s), egress spike (3× the
6-hour average and > 10 MiB/s), proxy upstream error ratio > 20 %, staging
disk below 5 GiB and an organization above 90 % of its storage limit.
Thresholds are starting points; edit them in place.
`deploy/grafana/chicoree.json` is a Grafana 11+ dashboard (import it under
*Dashboards → New → Import*, pick your Prometheus when asked) with rows for
Overview (up, version, storage physical vs logical, dedup savings, counts,
pulls today), Traffic (egress / ingress rate, top repositories by egress,
requests by route and status class, p50 / p95 latency, 429s), Content (pulls
and pushes per day, largest repositories), Security (findings by severity,
scan status, blocked images), Operations (last job outcome, webhook, mirror
and proxy failures, staging space, GC age, proxy cache) and Runtime (memory,
goroutines, in-flight, CPU, file descriptors).

**Running the stack next to Chicorée.** `docker-compose.observability.yml`
adds Prometheus and Grafana (dashboard and datasource provisioned) under the
`observability` profile, published on loopback only:

```sh
echo '<token from Administration → Metrics>' > secrets/metrics-token
docker compose -f docker-compose.yml -f docker-compose.observability.yml \
  --profile observability up -d
```

Prometheus answers at `http://localhost:9090`, Grafana at
`http://localhost:3001` (`admin` / `admin`; set `GRAFANA_ADMIN_PASSWORD` and
optionally `GRAFANA_ADMIN_USER`, `PROMETHEUS_RETENTION` (default `30d`) and
`METRICS_TOKEN_FILE` in `.env`). The dashboard lives in the *Chicorée*
folder; it is read from the file, so *Save as* a copy before customising.
Alerts fire inside Prometheus — point it at an Alertmanager (`alerting:`
block in `prometheus.example.yml`) to get notified.

For plain uptime monitors there is `GET /api/health` — see [Health](#health).

## Health

*Administration → Health* runs live checks with a 3-second timeout each:
`registryd` (health, version, storage driver, uptime, blob count and bytes,
upload staging mode and in-flight sessions, staging disk space in local
mode), Postgres (size, connections, applied migrations), the vulnerability
scanner (Clair: liveness and updater freshness; Trivy: binary, database age
or server health; or *not configured*), the token signing keys (the active
signer — file or database key — against the keys `registryd` trusts, telling
"not picked up yet" from a real mismatch), pending / failed scans, failing
webhooks, the last run per job, failed mirrors, the last garbage
collection and the registry event outbox. *Refresh* re-runs everything.

**Registry events.** Every push and delete `registryd` reports to the web
app (the trigger for scans, signature checks, webhooks and quota warnings)
is first written to `registry_event_outbox`, then delivered over HTTP. The
web app claims the row before acting, so a delivery registryd retries after
a slow response is never handled twice; rows nobody claimed — the web app
was down, or registryd gave up — are picked up by the scheduler on its next
tick (every 30 s, with backoff for events that keep failing) even with
`JOB_SCHEDULER=false`. The health page shows how many are waiting, how old
the oldest is, how many were recovered this way in the last day and whether
any gave up after 25 attempts (those stay in the table for inspection).

For uptime monitors, `GET /api/health` needs no credentials: it pings the
database and the registry and answers `200 {"status":"ok"}` or
`503 {"status":"degraded"}` with per-check latencies, the number of
registry events waiting or stuck, and nothing else.
`GET /internal/v1/healthz` on the registry itself is the container health
check: it pings the database and the storage backend (3 s budget) and
answers 503 with the failing check when either does not respond, so
compose, Kubernetes and Traefik stop routing to a registry that cannot
serve.

Registry builds can stamp a version into the health page:
`docker build --build-arg VERSION=1.4.0 registryd/` (or
`go build -ldflags "-X registryd/internal/version.Version=1.4.0"`); unstamped
builds report `dev`.

## Job schedules

Every job on *Administration → Jobs* has a **Schedule** block next to its
*Run now* form: switch the schedule on, pick *Every hour*, *Daily at 03:00*,
*Weekly, Sunday 04:00* or type any 5-field cron expression
(`minute hour day-of-month month day-of-week`), choose the time zone the
expression is read in (IANA name, default `UTC`) and set the parameters
scheduled runs should use. The form shows what the expression means in plain
English and the next three run times; invalid expressions are rejected. The
*Recent runs* table shows how each run was started (manual, API or schedule),
and each job card shows the outcome of its last scheduled run.

Schedules are checked every 30 seconds. With several web replicas exactly one
of them runs the jobs that are due (a Postgres advisory lock decides), a job
never runs twice at the same time (a due schedule waits until the running
instance has finished), and a run still marked *running* after six hours is
closed as failed so the job can run again. Failed runs email the
administrators — see [Notifications](#notifications).

Installs that trigger jobs from external cron through the jobs API can set
`JOB_SCHEDULER=false`; schedules are then stored but never executed by the
app, and the Jobs page says so.

## REST API

Everything the web app does with organizations, repositories, tags and
images is also an HTTP API under `/api/v1` — the same personal access
tokens that authenticate `docker login` authenticate it, with the same
roles and restrictions:

```sh
export TOKEN=chc_pat_…
curl -H "Authorization: Bearer $TOKEN" "$APP_URL/api/v1/me"
curl -H "Authorization: Bearer $TOKEN" "$APP_URL/api/v1/orgs/acme/repos?sort=pulls"
curl -H "Authorization: Bearer $TOKEN" "$APP_URL/api/v1/repos/acme/api/tags"
curl -H "Authorization: Bearer $TOKEN" "$APP_URL/api/v1/repos/acme/api/manifests/sha256:…/vulnerabilities?severity=Critical,High"
curl -X DELETE -H "Authorization: Bearer $TOKEN" "$APP_URL/api/v1/repos/acme/api/tags/1.3.9"
```

- **Reference**: [API.md](API.md) — authentication, conventions, errors and
  every endpoint with parameters and example responses. The same text is
  the *Guide* tab of the in-app page.
- **API browser**: `/docs/api` in the app (sidebar → *API*) lists every
  endpoint, sends real requests with your session or a pasted token, and
  shows the curl line for the same call.
- **OpenAPI**: `GET /api/v1/openapi.json` is an OpenAPI 3.1 document for
  Swagger UI, Postman, Insomnia or client generators.
- **Index**: `GET /api/v1` needs no credentials and returns the version,
  the current revision, the changelog and the endpoint list.
- **Keyless CI**: a workflow exchanges the OIDC token its CI system issues
  for a short-lived credential (`POST /api/v1/auth/exchange`) once the
  organization trusts its identity (*Organization → Service accounts → CI
  identities*); `.github/actions/login` does it for GitHub Actions and
  `.github/actions/scan-gate` fails a job on the scan verdict — see
  [API.md](API.md#keyless-ci-authentication).
- **Rate limits**: requests are counted per credential (per address without
  one) in windows set under *Administration → Rate limits*; over the limit
  the API answers `429 rate_limited` with `Retry-After`, and every answer
  carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
  `X-RateLimit-Reset`. Instance administrators are exempt.
  `chicoree_api_requests_total` on the metrics endpoint counts requests by
  endpoint, method, status and credential kind.
- **Exports**: `…/vulnerabilities?format=sarif` (SARIF 2.1.0 for GitHub
  code scanning and security dashboards, accepted risks as suppressions)
  and `?format=vex` (CycloneDX 1.5 VEX with the accepted risks as
  `not_affected`). GETs carry a weak `ETag` and answer `304` to
  `If-None-Match`.
- **Contract tests**: `npm run api:smoke` in `web/` seeds an organization,
  tokens and a tagged manifest straight into the database, runs the request
  matrix against a running app (`API_BASE`, default `http://localhost:3000`)
  and cleans up; the GitHub Actions workflow runs it on every push together
  with `npm run lint` (typecheck, catalog ⇄ routes, OpenAPI validation,
  `API.md` freshness) and the Go tests.
- **Deprecations**: an endpoint that is going away carries `Deprecation`,
  `Sunset` and `Link` headers and stays for at least one revision after the
  changelog announces it.
- **Switching it off**: *Administration → Auth providers → Access → REST
  API* (default from `API_ENABLED`). While off, every endpoint, the index
  and the OpenAPI document answer `403` with code `api_disabled`, the API
  page and its sidebar entry disappear for everyone, and `docker login` and
  the jobs API keep working.
- **Who can do what**: read-only tokens read; read & write tokens also
  change things; a token limited to an organization or a repository list
  sees nothing outside it (and cannot search or create repositories).
  Service accounts read their organization's repositories and, with the
  `admin` permission, delete tags and images. Anonymous callers get public
  repositories. Every change is audited with `"via": "api"`.

> **The API follows the features.** Whenever a feature is added, changed or
> removed, the endpoints that expose it and the documentation change with
> it in the same release: the revision in `GET /api/v1` moves, and the
> changelog (in [API.md](API.md#changelog), `/docs/api` and the OpenAPI
> description) says what changed. Read it before upgrading a client. The
> endpoint catalog, the route handlers and `API.md` are checked against
> each other by `npm run lint` in `web/`.

## Operations

- **Jobs API**: every maintenance job is also an HTTP endpoint for cron, CI
  or scripts (separate from the [REST API](#rest-api), which covers
  organizations, repositories, tags and images). Authenticate with
  `JOBS_API_TOKEN` or an administrator's read & write access token.

  ```sh
  curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs/gc?grace=30m"
  curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs/scan-stale?olderThan=7d&wait=false"
  curl -X POST -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs/prune-untagged?olderThan=14d"
  curl -H "Authorization: Bearer $TOKEN" "$APP_URL/api/jobs"        # list jobs + recent runs
  ```

  Jobs: `gc` (reclaim unreferenced blobs, sweep stale upload sessions and
  orphaned staging chunks), `scan-stale` (re-scan tagged images whose last
  scan is older than `olderThan`, never ran or failed; hidden while scanning
  is off), `scan-normalize` (one-off after upgrading: convert stored Clair
  reports into normalised findings, `limit` rows per run),
  `exceptions-expire` (recompute pull blocks for expired accepted risks and
  prune long-expired ones), `token-expiry` (email owners of credentials
  expiring within `withinDays`, default 7), `prune-untagged` (delete
  untagged manifests older than `olderThan`; run `gc` afterwards),
  `mirror-sync` (re-sync every enabled mirror), `proxy-evict` (drop
  proxy-cache tags nobody pulled for `unusedFor`; `dryRun=true` only counts),
  `retention` (apply retention policies; a dry run unless
  `dryRun=false`, narrowed by `organization=` / `repository=`),
  `quota-enforce` (notify and, after `graceDays`, prune organizations and
  accounts above their storage limit down to it; a dry run unless
  `dryRun=false` — see [Limits](#limits)) and
  `reverify-signatures` (re-check every cosign signature and attestation
  against the trusted and personal keys, optionally one `organization=`). Add
  `?wait=false` to queue and return immediately. All of them can also run on
  a schedule — see [Job schedules](#job-schedules). Access tokens limited to
  an organization cannot call the jobs API.
- **Garbage collection** is also exposed on the registry itself as
  `POST /internal/v1/gc` (bearer = webhook secret), which the `gc` job calls.
- **Health**: `GET /internal/v1/healthz` on the registry, `GET /api/health`
  on the web app — see [Health](#health).
- **Pull policies**: vulnerability thresholds and accepted risks under
  [Vulnerability scanning](#vulnerability-scanning), required signatures
  under [Signatures and SBOMs](#signatures-and-sboms).
- **Deleting tags**: organization owners and admins (and instance
  administrators) can remove a tag from the repository page. The registry
  records the deletion and the image data stays until *prune-untagged* and
  *gc* reclaim it. If `latest` pointed at the deleted image it moves to the
  newest remaining tag (highest version, else most recently built), or is
  removed with the last image — unless `latest` is itself immutable or
  protected, in which case it stays where it is. Protected tags cannot be
  deleted at all — see [Tag rules](#tag-rules).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.
