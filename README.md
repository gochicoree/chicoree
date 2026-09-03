# Chicorée

A self-hosted OCI container registry with a proper management plane.

> Chicorée is written `Chicoree` in paths, identifiers and configuration.

- **`registryd/`** — the registry itself, written in Go from the OCI Distribution
  Spec up: chunked & monolithic blob uploads, cross-repo mounts, image + index
  manifests, tag listing, the referrers API, HTTP range requests,
  content-addressable deduplicated storage (filesystem, S3 or bunny.net),
  pull-through proxy caches, immutable/protected tags, pull rate limits, and
  Docker token authentication.
- **`web/`** — the management app (Next.js + TypeScript): organizations,
  public/private repositories, members & invitations, service accounts for CI,
  personal access tokens, layer-level image inspection, pull and traffic
  statistics, Clair vulnerability scanning, repository and organization
  webhooks, email notifications, mirrors, retention policies, scheduled
  maintenance jobs, an audit log, sign-up controls, branding and a health
  page. Sign-in supports email+password, magic links,
  email one-time codes, passkeys, GitHub/Google/any-OIDC OAuth, LDAP/Active
  Directory with group-based roles, and TOTP or
  email-based two-factor auth.
- **Clair v4** (combo mode, optional) scans every pushed image; reports live next to the tag.

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
| OAuth sign-in | *Administration → Auth providers → Sign-in providers*; `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/NAME/SCOPES/GROUPS_CLAIM` as defaults |
| LDAP sign-in | *Administration → Auth providers → LDAP*; `LDAP_*` as defaults — see [LDAP](#ldap--active-directory) |
| Group-based roles | *Administration → Auth providers → Group bindings*; `AUTH_GROUP_BINDINGS` as default — see [Group-based roles](#group-based-roles) |
| Email | *Administration → Email*; `SMTP_HOST/PORT/USER/PASS/FROM` as defaults (compose points at the bundled Mailpit) |
| Passkeys | `PASSKEY_RP_ID` (the domain users see), `PASSKEY_RP_NAME` |
| Jobs | `JOBS_API_TOKEN` (optional static token for automation); `JOB_SCHEDULER=false` leaves scheduling to external cron — see [Job schedules](#job-schedules) |
| GC safety window | `GC_GRACE_PERIOD` (default `1h`) |
| Prometheus metrics | *Administration → Metrics*; `METRICS_ENABLED`, `METRICS_TOKEN` as defaults — see [Monitoring](#monitoring) |
| Vulnerability scanning | `CLAIR_URL` (empty disables it) and `COMPOSE_PROFILES=clair` to run the bundled Clair — see [Running without Clair](#running-without-clair) |
| Sign-up controls | *Administration → Auth providers → Access*; `SIGNUP_MODE`, `SIGNUP_ALLOWED_DOMAINS`, `ORG_CREATION` as defaults — see [Sign-up controls](#sign-up-controls) |
| Branding | *Administration → Branding*; `INSTANCE_NAME`, `INSTANCE_TAGLINE` as defaults — see [Branding](#branding) |
| Pull rate limits | *Administration → Rate limits*; `RATE_LIMIT_ANONYMOUS`, `RATE_LIMIT_AUTHENTICATED`, `RATE_LIMIT_TRUSTED_PROXIES` as defaults, read by the web app and `registryd` — see [Rate limits](#rate-limits) |
| Audit log | `AUDIT_RETENTION_DAYS` (default `365`) — see [Audit log](#audit-log) |
| Registry internals | `INTERNAL_API_URL` (where `registryd` reads proxy-cache configuration; defaults to `WEBHOOK_URL` minus its last path segment), `REGISTRY_LOG_FORMAT=text\|json`; `docker build --build-arg VERSION=…` stamps the version shown on the [Health](#health) page |

For production: serve both the web app and the registry behind TLS (any
reverse proxy), point `APP_URL`/`REGISTRY_HOST` at the real hostnames, use a
managed Postgres, and keep `secrets/registry-token.key` private — it signs
every registry access token.

### Settings in the admin panel

Email (SMTP) is edited under *Administration → Email*; the GitHub, Google and
OpenID Connect providers, LDAP, the group bindings and the sign-up controls
under *Administration → Auth providers*; branding and pull rate limits on
their own pages. Changes take effect immediately: the auth stack, the mailer
and the directory client are rebuilt from the stored values, and `registryd`
picks up new rate limits within 30 seconds. Secrets are stored encrypted with
`AUTH_SECRET`. The matching environment variables still work as defaults for
sections that have never been saved (each card says whether its values come
from the admin settings, the environment, or nowhere), and "Use environment
values" drops a stored section again. The Email and LDAP pages offer checks:
a test email and an LDAP bind plus user lookup, run with the values in the
form.

### Running without Clair

Clair is optional. It needs Postgres and downloads several gigabytes of
advisory data, so smaller installs may prefer to skip it:

- **Compose:** set `COMPOSE_PROFILES=` and `CLAIR_URL=` (both empty) in
  `.env`; the `clair` service is behind the `clair` profile and is not started.
- **the PaaS:** set `CLAIR_URL` to empty and delete the `clair` service from
  the loaded compose file.

With `CLAIR_URL` empty the app never queues scans, and everything
vulnerability-related disappears: the column in the tag list, the tab and
re-scan button on the tag page, the platform-variant column, and the
`scan-stale` job (its API route answers with an error). Turning Clair back on
later scans images as they are pushed; run `scan-stale` once to catch up on
existing ones.

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
bindings, sign-up controls, branding, rate limits, or to disable Clair
(`COMPOSE_PROFILES=` and `CLAIR_URL=`). While
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

Back up the `pg-data`, `registry-data`,
`token-keys` and `traefik-acme` volumes.

### Deploying with the PaaS

`docker-compose.paas.yml` is a variant of the stack for the PaaS's Docker
Compose build pack: no host ports, no bind mounts from the repository, and
every secret generated by the PaaS. The web container creates the ES256 token
key pair and the Clair database on its first start (both land in named
volumes), so nothing has to be prepared on the server.

1. **New resource → Docker Compose**, point it at this repository and set
   *Docker Compose Location* to `/docker-compose.paas.yml`, then load it.
2. **Domains.** Give `web` its UI domain (the PaaS routes it to port 3000, e.g.
   `https://registry.example.com`) and `registryd` the docker domain
   (`https://cr.example.com`, routed to port 5000). Both must be HTTPS; docker
   refuses plain-HTTP registries that are not `localhost`. `APP_URL`,
   `REGISTRY_HOST`, `TOKEN_REALM` and `PASSKEY_RP_ID` are derived from these
   automatically (`SERVICE_URL_WEB`, `SERVICE_FQDN_REGISTRYD`).
3. **Environment.** Fill in `SMTP_*` (otherwise mail is only logged), and any
   of the optional blocks: S3 storage, OAuth providers, LDAP,
   `AUTH_GROUP_BINDINGS`, sign-up controls, branding, rate limits. Everything
   else is prefilled.
4. **Proxy timeouts.** Image layers stream through the proxy as large, slow
   uploads. In the PaaS's proxy settings raise Traefik's entrypoint
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

### Branding

*Administration → Branding* sets the instance name and tagline (page titles,
sidebar, sign-in screens, emails), a PNG or SVG logo (at most 64 KB; replaces
the chicory mark), the accent colour, up to six footer links, and an
announcement banner shown at the top of every page. `info` and `warning`
banners can be dismissed (remembered per browser until the text changes),
`danger` banners cannot. `INSTANCE_NAME` and `INSTANCE_TAGLINE` are the
environment defaults; the page previews changes live.

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
  pull / push / admin, optional expiry) — both usable as the password with
  any username. Email+password also works, but only for accounts *without*
  two-factor auth; 2FA users must use a token.
- The web app's token endpoint (`/api/registry/token`) authorizes each
  requested scope against the database and signs a short-lived ES256 JWT;
  `registryd` verifies it with the public key and enforces the granted
  actions. The registry itself holds no credentials.
- Scopes of the form `repository:<name>:*` (what `skopeo delete` requests)
  expand to every action the caller may perform. Proxy-cache organizations
  grant `pull` only, whoever asks — see [Proxy caches](#proxy-caches).

## Webhooks

Webhooks exist at two levels. **Repository webhooks** (*Repository →
Settings → Webhooks*, up to five) fire for events in that repository;
**organization webhooks** (*Organization → Settings → Webhooks*, up to ten)
fire for events in every repository of the organization, plus the
organization-level `quota.warning`. Both share the same form — HTTP method
(POST/PUT/PATCH), extra headers, authentication (bearer token, basic auth or a
custom header; secrets are encrypted at rest) and an optional signing secret
that adds `X-Chicoree-Signature: sha256=<hmac>` so receivers can verify the
body — the same delivery log (the last 50 attempts per hook), retries on
network errors and 5xx, and *Send test*. Each hook picks the events it wants:

| Event | Fires when | Payload adds |
| --- | --- | --- |
| `push` | an image or tag is pushed | `tag`, `image` (digest, media type, layer list and sizes, platform, entrypoint/cmd/labels from the image config), `actor` |
| `delete` | a tag or manifest is deleted (UI, `skopeo delete`, `DELETE /v2/…`) | `tag` (null for deletes by digest), `tags` (every tag that pointed at the manifest), `digest`, `image`, `actor` |
| `scan.completed` | a vulnerability scan finished | `tag`, `tags`, `image`, `scan { status, summary, blocked, reason }` |
| `scan.blocked` | a scan put the image over the pull policy threshold | `tag`, `tags`, `image`, `reason` |
| `mirror.completed`, `mirror.failed` | a mirror sync finished or failed | `mirror { id, source }`, `run { id, status, matched, imported, skipped, failed, error }` |
| `retention.completed` | a retention run deleted (or, as a dry run, would delete) tags | `dryRun`, `deletedTags`, `deletedDigests`, `keptTags`, `policy`, `actor` |
| `quota.warning` | usage reached 80 % / 95 % of a limit (organization hooks only) | `organization { slug, name }`, `quota { kind, used, limit, percent, threshold }`; `repository` is `null` |

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
| `scan.completed` | organization owners and admins | every finished scan, with its severity summary — **off by default** |
| `mirror.failed` | organization owners and admins | a mirror sync fails |
| `webhook.failed` | organization owners and admins | a webhook delivery fails after its final retry |
| `quota.warning` | organization owners and admins | storage or repository usage reaches 80 % / 95 % of a limit — once per threshold, organization and 24 hours |
| `job.failed` | instance administrators | a job run fails (manual, API or scheduled) |

Every user chooses under *Settings → Notifications* which of these arrive by
email; everything is on except `scan.completed`. Emails use the SMTP settings
from *Administration → Email* and link to the image, mirror, delivery log,
organization or jobs page concerned. Organization webhooks can subscribe to
the same events, except `webhook.failed` and `job.failed`.

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
*index child* (a platform variant of a multi-arch index in the repository),
*referrer* (attached to another image) and *N attached*. Owners and admins
can delete an untagged image by digest from there; platform variants of an
index that still exists are refused (delete the index instead).

The tag page's **Delete image** button removes the manifest by digest
together with *every* tag pointing at it — the confirmation lists those
tags. It is disabled while a protected tag names the image or the image
belongs to an existing index. `docker pull …@sha256:…` answers
`manifest unknown` afterwards; layers stay until garbage collection.

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
`d`; an empty field means unlimited. Changes apply within 30 seconds.
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

- **Users** (`/admin/users`): role, ban/unban, limits, memberships, and
  **impersonation** — act as the user in a separate session; a banner shows
  who you are impersonating with a one-click stop.
- **Organizations** (`/admin/organizations`): usage vs limits, members and
  their roles, repositories, proxy-cache configuration, and deletion —
  without having to be a member.
- **Jobs** (`/admin/jobs`): run maintenance jobs, schedule them and see
  their history — see [Job schedules](#job-schedules).
- **Metrics** (`/admin/metrics`) and **Health** (`/admin/health`) — see
  [Monitoring](#monitoring) and [Health](#health).
- **Audit** (`/admin/audit`): every change made through the app — see
  [Audit log](#audit-log).
- **Email**, **Auth providers**, **Branding** and **Rate limits**: instance
  settings, with the environment as fallback — see
  [Settings in the admin panel](#settings-in-the-admin-panel).

## Audit log

Every change made through the app is recorded: sign-ins and sign-ups (and
failed attempts), password / two-factor / passkey changes, organization,
member and invitation changes, repository visibility and deletion, tag
deletion, access tokens and service accounts, webhooks, mirrors, pull
policies, admin actions (roles, bans, limits, impersonation), instance
settings and job runs. Each entry carries who (with the impersonating admin
when applicable), what, the target, the organization, a small redacted
details object, the client IP and user agent.

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
`chicoree_traffic_bytes_total{direction="egress"|"ingress"|"redirect"}` and
`chicoree_vulnerability_findings{severity}`.

`METRICS_ENABLED=true` and `METRICS_TOKEN` in the environment serve as the
defaults for instances configured without the admin panel. For plain uptime
monitors there is `GET /api/health` — see [Health](#health).

## Health

*Administration → Health* runs live checks with a 3-second timeout each:
`registryd` (health, version, storage driver, uptime, blob count and bytes,
staging disk space), Postgres (size, connections, applied migrations), Clair
(liveness and updater freshness, or *not configured*), the token signing keys
(the app's private key against the public key `registryd` trusts), pending /
failed scans, failing webhooks, the last run per job, failed mirrors and the
last garbage collection. *Refresh* re-runs everything.

For uptime monitors, `GET /api/health` needs no credentials: it pings the
database and the registry and answers `200 {"status":"ok"}` or
`503 {"status":"degraded"}` with per-check latencies and nothing else.
`GET /internal/v1/healthz` on the registry itself remains the container
health check.

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
  `gc` afterwards), `mirror-sync` (re-sync every enabled mirror),
  `proxy-evict` (drop proxy-cache tags nobody pulled for `unusedFor`;
  `dryRun=true` only counts) and `retention` (apply retention policies; a dry
  run unless `dryRun=false`, narrowed by `organization=` / `repository=`).
  Add `?wait=false` to queue and return immediately. All of them can also run
  on a schedule — see [Job schedules](#job-schedules).
- **Garbage collection** is also exposed on the registry itself as
  `POST /internal/v1/gc` (bearer = webhook secret), which the `gc` job calls.
- **Health**: `GET /internal/v1/healthz` on the registry, `GET /api/health`
  on the web app — see [Health](#health).
- **Blocking vulnerable pulls**: *Organization → Settings → Policies* sets
  a severity threshold (critical, high, medium or low and above, optionally
  counting unrated findings); every repository can inherit it, switch it off
  or set its own under *Settings → Policies*. Images whose last scan
  reports findings at or above the threshold get a *pull blocked* badge, the
  registry answers pulls with `403 DENIED` and the reason, and multi-arch
  images are blocked when any variant is. Unscanned and unscannable images are
  never blocked; pushes are never affected.
- **Deleting tags**: organization owners and admins (and instance
  administrators) can remove a tag from the repository page. The registry
  records the deletion and the image data stays until *prune-untagged* and
  *gc* reclaim it. If `latest` pointed at the deleted image it moves to the
  newest remaining tag (highest version, else most recently built), or is
  removed with the last image — unless `latest` is itself immutable or
  protected, in which case it stays where it is. Protected tags cannot be
  deleted at all — see [Tag rules](#tag-rules).
- **Scan refresh**: every push triggers a Clair scan; the *Re-scan* button on
  a tag (administrators only) re-submits it (vulnerability databases keep updating, so re-scan
  periodically). Clair needs a few minutes after first boot to download its
  vulnerability databases; earlier scans may come back empty.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.
