# Chicorée REST API

> **This API follows the registry's features: whenever a feature is added, changed or removed, the endpoints that expose it and this documentation change with it in the same release. The revision moves every time — compare it with the changelog before relying on a new field, and read the changelog before upgrading.**
>
> Current revision: `2026-09-06.6` · [Changelog](#changelog) · index: `GET https://registry.example.com/api/v1` · in the app: `/docs/api`

Everything the web app can do with organizations, repositories, tags and images is available as JSON under `/api/v1`. The same personal access tokens that authenticate `docker login` authenticate the API, with the same roles and restrictions, so a token that can push an image can read its scan result, and one limited to a repository sees nothing else.

## Authentication

Send the credential in the `Authorization` header:

~~~sh
export TOKEN=chc_pat_…
curl -H "Authorization: Bearer $TOKEN" https://registry.example.com/api/v1/me
# Basic auth works too — the token is the password, the user name is ignored:
curl -u "me:$TOKEN" https://registry.example.com/api/v1/me
~~~

| Credential | Where it comes from | What it can do |
| --- | --- | --- |
| Personal access token `chc_pat_…` | *Settings → Access tokens* | Acts as its user. A **read-only** token can only read; a **read & write** token can also change things. A token **limited to an organization** or to a **repository list** sees and changes nothing outside it, and cannot search or create repositories. |
| Service account `chc_sa_…` | *Organization → Service accounts* | Reads its organization's repositories (or its repository list) plus public ones. With the `admin` permission it can delete tags and images there. It cannot manage repositories, star, or read members and the audit log. |
| CI credential `chc_ci_…` | `POST /api/v1/auth/exchange` with the workflow's OIDC token | The same rights as a service account with the trusted identity's permission and repository list, for the lifetime of the job (at most an hour). |
| Browser session | Being signed in | The same rights as in the web app — handy for trying calls in the browser. |
| None | — | Public repositories, tags, images and scan results. |

Expired tokens, banned accounts and unknown secrets answer `401`; a valid credential without the right answers `403` with the reason. Every use of a token updates its *last used* time and address (*Settings → Access tokens*).

### Keyless CI authentication

A CI job does not need a stored secret. An organization trusts the workflow's identity once (*Organization → Service accounts → CI identities*, or the `/orgs/{org}/ci-identities` endpoints): the issuer of its OIDC tokens and the subject they carry, exact or with `*` wildcards, plus a permission and an optional repository list. The job then exchanges the token it gets from its CI system for a registry credential:

~~~sh
# GitHub Actions (permissions: id-token: write); the audience is this registry's URL
OIDC=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://registry.example.com" | jq -r .value)
curl -sS -H "Content-Type: application/json" -d "{"token": "$OIDC"}" https://registry.example.com/api/v1/auth/exchange
# → { "token": "chc_ci_…", "expiresAt": "…", "dockerLogin": { "registry": "registry.example.com", "username": "ci", "password": "chc_ci_…" } }
~~~

The exchange verifies the token against the issuer's published keys (only issuers some organization trusts are contacted), checks that the audience is `https://registry.example.com` or `registry.example.com`, and matches the subject; GitHub subjects look like `repo:owner/repo:ref:refs/heads/main`, GitLab's like `project_path:group/project:ref_type:branch:ref:main`. The credential is a signed token with no stored state: deleting the identity revokes it at once. The `.github/actions/login` action in the repository does all of this and runs `docker login`.

Administrators can switch the whole API off (*Administration → Auth providers → Access*, default from `API_ENABLED`): every endpoint, the index and the OpenAPI document then answer `403` with code `api_disabled`. docker login and the jobs API are not affected.

## Conventions

- Responses are JSON (`application/json`, UTF-8). Timestamps are ISO 8601 in UTC (`2026-09-05T08:41:12.000Z`), sizes are bytes, digests are `sha256:<64 hex>`. Absent values are `null`, not omitted.
- Requests with a body send JSON with `Content-Type: application/json`.
- **Paging.** Lists take `page` (from 1) and `per_page` (1–100, default 50) and answer `{ "items": [...], "page": 1, "perPage": 50, "total": 123, "pages": 3 }`. A page past the end returns the last page.
- **Booleans** in the query string are `true`/`1`/`yes` (anything else is false).
- **Repository names** of proxy caches can be nested (`bitnami/redis`); in a path they are one segment with the slash percent-encoded: `/repos/dockerhub/bitnami%2Fredis`. Top-level images (`registry.example.com/nginx`) live in the `library` organization.
- Renamed or transferred repositories are **not** redirected by the API; use the new name (`docker pull` and the web pages do redirect).
- Every response carries `X-Api-Version: 1` and `X-Api-Revision: 2026-09-06.6`, and `Cache-Control: private, no-store`.
- Changes made through the API are audited like changes made in the app, with `"via": "api"` in the entry's details.
- Unknown paths under `/api/v1` answer a JSON `404`; an unsupported method answers `405`.
- **Conditional requests.** Every successful GET carries a weak `ETag`; send it back as `If-None-Match` and an unchanged answer comes back as `304` without a body (the rate-limit and deprecation headers still apply).
- **Exports.** `GET …/manifests/{digest}/vulnerabilities?format=sarif` is the image's scan as SARIF 2.1.0 for GitHub code scanning and security dashboards (accepted risks become suppressions); `?format=vex` is a CycloneDX 1.5 VEX document in which accepted risks are `not_affected` with their justification and everything else is `in_triage`.
- **Rate limits.** Requests are counted per credential (per address without one) in fixed windows set by the administrators (*Administration → Rate limits*, defaults `RATE_LIMIT_API_AUTHENTICATED=1200/1m` and `RATE_LIMIT_API_ANONYMOUS=120/1m`; instance administrators are exempt). Every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds); over the limit the API answers `429 rate_limited` with `Retry-After`.
- **Deprecations.** An endpoint that is going away is announced first: its responses carry a `Deprecation` header (and `Sunset` once a date is set) with a `Link` to this documentation, the reference marks it, and it stays for at least one more revision. Watch the changelog for `Removed:` lines.

## Errors

~~~json
{ "error": "This access token is read-only; delete tags here needs a read & write token.", "code": "forbidden" }
~~~

| Code | Status | When |
| --- | --- | --- |
| `bad_request` | 400 | A parameter is malformed (a bad digest, an unknown severity, invalid JSON). |
| `unauthorized` | 401 | No usable credential: missing, unknown, expired or a banned account. |
| `forbidden` | 403 | The credential is valid but may not do this (role, read-only token, restriction, service account). |
| `not_found` | 404 | The organization, repository, tag or image does not exist — or is not visible to the caller. |
| `conflict` | 409 | The registry's state refuses the change: a name is taken, a tag is protected, an index member cannot go alone, a scan is already running. |
| `unprocessable` | 422 | The body is well-formed but a value is not acceptable (name rules, quotas, missing fields). |
| `rate_limited` | 429 | Too many requests in the current window; `Retry-After` says when to try again. |
| `api_disabled` | 403 | An administrator switched the API off (*Administration → Auth providers → Access*, or `API_ENABLED=false`); every endpoint answers this until it is on again. |
| `internal` | 500 | Something failed on the server; the details are in the web app's log. |

Some errors add a `details` object (the offending `field`, or `queued: false` when a scan was not started).

## Tools

- **API browser.** `/docs/api` in the app lists every endpoint with its parameters, sends real requests with your browser session or a token you paste, and shows the curl line for the same call.
- **OpenAPI.** `GET https://registry.example.com/api/v1/openapi.json` is an OpenAPI 3.1 document for Swagger UI, Postman, Insomnia or client generators (response schemas are inferred from the examples below).
- **This file** (`API.md`) is generated from the catalog by `npm run api:docs` in `web/`; `npm run lint` fails when it is stale.

## Endpoints

**General**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1`](#get-index) | API index | anyone |
| [`GET /api/v1/openapi.json`](#get-openapi-json) | OpenAPI document | anyone |
| [`POST /api/v1/auth/exchange`](#post-auth-exchange) | Exchange a CI OIDC token for a registry credential | anyone |
| [`GET /api/v1/me`](#get-me) | Who am I | any credential |

**Organizations**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1/orgs`](#get-orgs) | List organizations | anyone |
| [`GET /api/v1/orgs/{org}`](#get-orgs-org) | Organization details | anyone |
| [`GET /api/v1/orgs/{org}/repos`](#get-orgs-org-repos) | List repositories of an organization | anyone |
| [`POST /api/v1/orgs/{org}/repos`](#post-orgs-org-repos) | Create a repository | organization owners, admins and members |
| [`GET /api/v1/orgs/{org}/members`](#get-orgs-org-members) | List members | organization members |
| [`GET /api/v1/orgs/{org}/audit`](#get-orgs-org-audit) | Organization audit log | organization owners and admins |
| [`POST /api/v1/orgs`](#post-orgs) | Create an organization | a signed-in user or personal access token |
| [`PATCH /api/v1/orgs/{org}`](#patch-orgs-org) | Rename an organization | organization owners and admins |
| [`DELETE /api/v1/orgs/{org}`](#delete-orgs-org) | Delete an organization | organization owners and admins |
| [`GET /api/v1/orgs/{org}/usage`](#get-orgs-org-usage) | Usage against limits | organization owners and admins |
| [`GET /api/v1/orgs/{org}/policies`](#get-orgs-org-policies) | Organization policies | organization members |
| [`PATCH /api/v1/orgs/{org}/policies`](#patch-orgs-org-policies) | Change organization policies | organization owners and admins |
| [`GET /api/v1/orgs/{org}/service-accounts`](#get-orgs-org-service-accounts) | List service accounts | organization owners and admins |
| [`POST /api/v1/orgs/{org}/service-accounts`](#post-orgs-org-service-accounts) | Create a service account | organization owners and admins |
| [`GET /api/v1/orgs/{org}/service-accounts/{id}`](#get-orgs-org-service-accounts-id) | Service account details | organization owners and admins |
| [`DELETE /api/v1/orgs/{org}/service-accounts/{id}`](#delete-orgs-org-service-accounts-id) | Delete a service account | organization owners and admins |
| [`POST /api/v1/orgs/{org}/service-accounts/{id}/rotate`](#post-orgs-org-service-accounts-id-rotate) | Rotate a service account's secret | organization owners and admins |
| [`PATCH /api/v1/orgs/{org}/members/{userId}`](#patch-orgs-org-members-userId) | Change a member's role | organization owners and admins |
| [`DELETE /api/v1/orgs/{org}/members/{userId}`](#delete-orgs-org-members-userId) | Remove a member | organization owners and admins |
| [`GET /api/v1/orgs/{org}/invitations`](#get-orgs-org-invitations) | List pending invitations | organization owners and admins |
| [`POST /api/v1/orgs/{org}/invitations`](#post-orgs-org-invitations) | Invite someone by email | organization owners and admins |
| [`DELETE /api/v1/orgs/{org}/invitations/{id}`](#delete-orgs-org-invitations-id) | Cancel an invitation | organization owners and admins |
| [`GET /api/v1/orgs/{org}/ci-identities`](#get-orgs-org-ci-identities) | List trusted CI identities | organization owners and admins |
| [`POST /api/v1/orgs/{org}/ci-identities`](#post-orgs-org-ci-identities) | Trust a CI identity | organization owners and admins |
| [`DELETE /api/v1/orgs/{org}/ci-identities/{id}`](#delete-orgs-org-ci-identities-id) | Stop trusting a CI identity | organization owners and admins |
| [`GET /api/v1/orgs/{org}/webhooks`](#get-orgs-org-webhooks) | List organization webhooks | organization owners and admins |
| [`POST /api/v1/orgs/{org}/webhooks`](#post-orgs-org-webhooks) | Create a organization webhook | organization owners and admins |
| [`GET /api/v1/orgs/{org}/webhooks/{id}`](#get-orgs-org-webhooks-id) | Organization webhook details | organization owners and admins |
| [`PATCH /api/v1/orgs/{org}/webhooks/{id}`](#patch-orgs-org-webhooks-id) | Update a organization webhook | organization owners and admins |
| [`DELETE /api/v1/orgs/{org}/webhooks/{id}`](#delete-orgs-org-webhooks-id) | Delete a organization webhook | organization owners and admins |
| [`POST /api/v1/orgs/{org}/webhooks/{id}/test`](#post-orgs-org-webhooks-id-test) | Send a test delivery | organization owners and admins |

**Repositories**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1/repos/{org}/{repo}`](#get-repos-org-repo) | Repository details | anyone |
| [`PATCH /api/v1/repos/{org}/{repo}`](#patch-repos-org-repo) | Update a repository | organization owners and admins |
| [`DELETE /api/v1/repos/{org}/{repo}`](#delete-repos-org-repo) | Delete a repository | organization owners and admins |
| [`GET /api/v1/repos/{org}/{repo}/policies`](#get-repos-org-repo-policies) | Repository policies | anyone |
| [`PATCH /api/v1/repos/{org}/{repo}/policies`](#patch-repos-org-repo-policies) | Change repository policies | organization owners and admins |
| [`GET /api/v1/repos/{org}/{repo}/webhooks`](#get-repos-org-repo-webhooks) | List repository webhooks | organization owners and admins |
| [`POST /api/v1/repos/{org}/{repo}/webhooks`](#post-repos-org-repo-webhooks) | Create a repository webhook | organization owners and admins |
| [`GET /api/v1/repos/{org}/{repo}/webhooks/{id}`](#get-repos-org-repo-webhooks-id) | Repository webhook details | organization owners and admins |
| [`PATCH /api/v1/repos/{org}/{repo}/webhooks/{id}`](#patch-repos-org-repo-webhooks-id) | Update a repository webhook | organization owners and admins |
| [`DELETE /api/v1/repos/{org}/{repo}/webhooks/{id}`](#delete-repos-org-repo-webhooks-id) | Delete a repository webhook | organization owners and admins |
| [`POST /api/v1/repos/{org}/{repo}/webhooks/{id}/test`](#post-repos-org-repo-webhooks-id-test) | Send a test delivery | organization owners and admins |
| [`PUT /api/v1/repos/{org}/{repo}/star`](#put-repos-org-repo-star) | Star a repository | a signed-in user or personal access token |
| [`DELETE /api/v1/repos/{org}/{repo}/star`](#delete-repos-org-repo-star) | Unstar a repository | a signed-in user or personal access token |

**Tags**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1/repos/{org}/{repo}/tags`](#get-repos-org-repo-tags) | List tags | anyone |
| [`GET /api/v1/repos/{org}/{repo}/tags/{tag}`](#get-repos-org-repo-tags-tag) | Tag details | anyone |
| [`PUT /api/v1/repos/{org}/{repo}/tags/{tag}`](#put-repos-org-repo-tags-tag) | Tag an image (retag) | organization owners, admins and members |
| [`POST /api/v1/repos/{org}/{repo}/tags/{tag}/copy`](#post-repos-org-repo-tags-tag-copy) | Copy (promote) a tagged image to another repository | organization owners, admins and members |
| [`DELETE /api/v1/repos/{org}/{repo}/tags/{tag}`](#delete-repos-org-repo-tags-tag) | Delete a tag | organization owners and admins |
| [`GET /api/v1/repos/{org}/{repo}/untagged`](#get-repos-org-repo-untagged) | List untagged manifests | anyone |

**Images**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1/repos/{org}/{repo}/manifests/{digest}`](#get-repos-org-repo-manifests-digest) | Image details | anyone |
| [`DELETE /api/v1/repos/{org}/{repo}/manifests/{digest}`](#delete-repos-org-repo-manifests-digest) | Delete an image by digest | organization owners and admins |
| [`POST /api/v1/repos/{org}/{repo}/manifests/{digest}/copy`](#post-repos-org-repo-manifests-digest-copy) | Copy an image by digest to another repository | organization owners, admins and members |
| [`GET /api/v1/repos/{org}/{repo}/manifests/{digest}/scan`](#get-repos-org-repo-manifests-digest-scan) | Scan gate | anyone |
| [`POST /api/v1/repos/{org}/{repo}/manifests/{digest}/scan`](#post-repos-org-repo-manifests-digest-scan) | Queue a vulnerability scan | instance administrators |

**Security**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1/repos/{org}/{repo}/manifests/{digest}/vulnerabilities`](#get-repos-org-repo-manifests-digest-vulnerabilities) | Vulnerabilities of an image | anyone |
| [`GET /api/v1/repos/{org}/{repo}/manifests/{digest}/artifacts`](#get-repos-org-repo-manifests-digest-artifacts) | Signatures, SBOMs and provenance of an image | anyone |

**Search**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1/search`](#get-search) | Search | anyone |

**Account**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1/me/starred`](#get-me-starred) | Repositories I starred | a signed-in user or personal access token |
| [`GET /api/v1/me/usage`](#get-me-usage) | My usage against my limits | a signed-in user or personal access token |

**Administration**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1/users`](#get-users) | List users | instance administrators |
| [`GET /api/v1/users/{userId}`](#get-users-userId) | User details | instance administrators |
| [`GET /api/v1/users/{userId}/organizations`](#get-users-userId-organizations) | A user's organizations | instance administrators |
| [`GET /api/v1/users/{userId}/usage`](#get-users-userId-usage) | A user's usage against their limits | instance administrators |
| [`GET /api/v1/users/{userId}/limits`](#get-users-userId-limits) | Account limits | instance administrators |
| [`PATCH /api/v1/users/{userId}/limits`](#patch-users-userId-limits) | Change account limits | instance administrators |
| [`DELETE /api/v1/users/{userId}/limits`](#delete-users-userId-limits) | Remove account limits | instance administrators |
| [`GET /api/v1/orgs/{org}/limits`](#get-orgs-org-limits) | Organization limits | instance administrators |
| [`PATCH /api/v1/orgs/{org}/limits`](#patch-orgs-org-limits) | Change organization limits | instance administrators |
| [`DELETE /api/v1/orgs/{org}/limits`](#delete-orgs-org-limits) | Remove organization limits | instance administrators |

## General



### <a id="get-index"></a>`GET /api/v1`

API index — Version, revision, changelog, the notice about how the API evolves, and the catalog of endpoints. Needs no credentials.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.1

Response `200`:

~~~json
{
  "name": "Chicorée REST API",
  "version": 1,
  "revision": "2026-09-05.1",
  "docs": "https://registry.example.com/docs/api",
  "notice": "This API follows the registry's features: …",
  "changelog": [
    {
      "revision": "2026-09-05.1",
      "changes": [
        "Initial release …"
      ]
    }
  ],
  "endpoints": [
    {
      "method": "GET",
      "path": "/api/v1/orgs",
      "summary": "List organizations",
      "access": "public"
    }
  ]
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1"
~~~

### <a id="get-openapi-json"></a>`GET /api/v1/openapi.json`

OpenAPI document — An OpenAPI 3.1 description of every endpoint for Swagger UI, Postman, Insomnia or client generators. Response schemas are inferred from the documented examples. Needs no credentials.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.1

Response `200`:

~~~json
{
  "openapi": "3.1.0",
  "info": {
    "title": "Chicorée REST API",
    "version": "2026-09-05.1"
  },
  "paths": {
    "/api/v1/orgs": {
      "get": {
        "summary": "List organizations"
      }
    }
  }
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/openapi.json"
~~~

### <a id="post-auth-exchange"></a>`POST /api/v1/auth/exchange`

Exchange a CI OIDC token for a registry credential — Keyless authentication: send the OIDC token your CI system issued (GitHub Actions, GitLab, any issuer an organization trusts) and get a short-lived credential back. The token is verified against the issuer's published keys, its audience must be this registry's URL or host, and its subject must match a trusted CI identity. The credential works as a bearer token here and as the docker login password. Needs no other credentials.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `token` | body | string | yes | The OIDC token (a JWT). |
| `organization` | body | string |  | Organization slug, required when several organizations trust the same identity. |
| `ttl` | body | integer |  | Lifetime in seconds, 60–3600 (default 1800). |

Response `200`:

~~~json
{
  "token": "chc_ci_eyJhbGciOi…",
  "expiresAt": "2026-09-05T11:00:00.000Z",
  "ttlSeconds": 1800,
  "identity": {
    "id": "ci_7a…",
    "name": "github-main",
    "organization": "acme",
    "permission": "push",
    "repositories": null
  },
  "subject": "repo:acme/api:ref:refs/heads/main",
  "dockerLogin": {
    "registry": "registry.example.com",
    "username": "ci",
    "password": "chc_ci_eyJhbGciOi…"
  }
}
~~~

~~~sh
curl -X POST \
  -H "Content-Type: application/json" -d '{"token":"…","organization":"…","ttl":1}' \
  "https://registry.example.com/api/v1/auth/exchange"
~~~

### <a id="get-me"></a>`GET /api/v1/me`

Who am I — The caller behind the credential: the user and, for tokens, the token's scope, expiry and restriction; for service accounts, the account and its permission.

**Who:** any credential · **Service accounts:** yes · **Write:** no · **Since:** 2026-09-05.1

Response `200`:

~~~json
{
  "kind": "user",
  "via": "token",
  "user": {
    "id": "u_7f…",
    "name": "Jo Doe",
    "email": "jo@example.com",
    "role": "user",
    "emailVerified": true
  },
  "token": {
    "id": "t_3a…",
    "name": "ci",
    "scope": "write",
    "expiresAt": "2026-12-04T00:00:00.000Z",
    "organization": "acme",
    "repositories": null
  },
  "serviceAccount": null,
  "api": {
    "version": 1,
    "revision": "2026-09-05.1"
  }
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/me"
~~~

## Organizations



### <a id="get-orgs"></a>`GET /api/v1/orgs`

List organizations — Organizations the caller belongs to or that have a repository the caller can see. `role` is the caller's role there (null when not a member; instance administrators are owners everywhere).

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Paginated** · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `q` | query | string |  | Filter by name or slug (substring). |
| `page` | query | integer |  | Page number, from 1. |
| `per_page` | query | integer |  | Rows per page, 1–100 (default 50). |

Response `200`:

~~~json
{
  "items": [
    {
      "id": "9a1c…",
      "slug": "acme",
      "name": "Acme",
      "role": "admin",
      "repositoryCount": 12,
      "proxy": false,
      "createdAt": "2026-09-01T10:12:00.000Z",
      "url": "https://registry.example.com/acme"
    }
  ],
  "page": 1,
  "perPage": 50,
  "total": 1,
  "pages": 1
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/orgs"
~~~

### <a id="get-orgs-org"></a>`GET /api/v1/orgs/{org}`

Organization details.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "id": "9a1c…",
  "slug": "acme",
  "name": "Acme",
  "role": "admin",
  "repositoryCount": 12,
  "proxy": false,
  "createdAt": "2026-09-01T10:12:00.000Z",
  "url": "https://registry.example.com/acme",
  "memberCount": 5,
  "storageBytes": 12884901888
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/orgs/acme"
~~~

### <a id="get-orgs-org-repos"></a>`GET /api/v1/orgs/{org}/repos`

List repositories of an organization — Private repositories appear for members only.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Paginated** · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `q` | query | string |  | Filter by name or description (substring). |
| `visibility` | query | public \| private |  | Only one visibility. |
| `sort` | query | updated \| pulls \| name |  | Order; default `updated` (newest push first). |
| `page` | query | integer |  | Page number, from 1. |
| `per_page` | query | integer |  | Rows per page, 1–100 (default 50). |

Response `200`:

~~~json
{
  "items": [
    {
      "id": "d2f4…",
      "organization": "acme",
      "name": "api",
      "path": "acme/api",
      "reference": "registry.example.com/acme/api",
      "description": "The public API server",
      "visibility": "private",
      "pullCount": 4213,
      "starCount": 3,
      "tagCount": 18,
      "sizeBytes": 734003200,
      "lastPushedAt": "2026-09-05T08:41:12.000Z",
      "updatedAt": "2026-09-05T08:41:12.000Z",
      "proxy": false,
      "lastCheckedAt": null,
      "url": "https://registry.example.com/acme/api"
    }
  ],
  "page": 1,
  "perPage": 50,
  "total": 12,
  "pages": 1
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/orgs/acme/repos"
~~~

### <a id="post-orgs-org-repos"></a>`POST /api/v1/orgs/{org}/repos`

Create a repository — Pushing to a new name creates a repository too; use this to set the description and visibility first. Quotas apply. Tokens limited to a repository list cannot create repositories.

**Who:** organization owners, admins and members · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `name` | body | string | yes | Lowercase letters, digits and single `._-` separators; up to 100 characters (nested with `/` in proxy caches). |
| `description` | body | string |  | Shown in listings. |
| `visibility` | body | public \| private |  | Default: the organization's default visibility. |

Response `201`:

~~~json
{
  "id": "d2f4…",
  "organization": "acme",
  "name": "api",
  "path": "acme/api",
  "reference": "registry.example.com/acme/api",
  "description": "The public API server",
  "visibility": "private",
  "pullCount": 4213,
  "starCount": 3,
  "tagCount": 18,
  "sizeBytes": 734003200,
  "lastPushedAt": "2026-09-05T08:41:12.000Z",
  "updatedAt": "2026-09-05T08:41:12.000Z",
  "proxy": false,
  "lastCheckedAt": null,
  "url": "https://registry.example.com/acme/api"
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"api","description":"The public API server","visibility":"private"}' \
  "https://registry.example.com/api/v1/orgs/acme/repos"
~~~

### <a id="get-orgs-org-members"></a>`GET /api/v1/orgs/{org}/members`

List members.

**Who:** organization members · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "items": [
    {
      "userId": "u_7f…",
      "name": "Jo Doe",
      "email": "jo@example.com",
      "role": "owner",
      "joinedAt": "2026-08-02T09:00:00.000Z"
    }
  ],
  "total": 1
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/members"
~~~

### <a id="get-orgs-org-audit"></a>`GET /api/v1/orgs/{org}/audit`

Organization audit log — Every change made through the app in this organization, newest first. Same filters as the audit page.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Paginated** · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `q` | query | string |  | Matches actor, target, action, or an exact id / address. |
| `action` | query | string |  | Action or prefix, e.g. `tag.delete` or `repo`. |
| `from` | query | date |  | YYYY-MM-DD, inclusive. |
| `to` | query | date |  | YYYY-MM-DD, inclusive. |
| `page` | query | integer |  | Page number, from 1. |
| `per_page` | query | integer |  | Rows per page, 1–100 (default 50). |

Response `200`:

~~~json
{
  "items": [
    {
      "id": 8123,
      "createdAt": "2026-09-05T08:50:00.000Z",
      "actor": {
        "type": "user",
        "id": "u_7f…",
        "label": "jo@example.com",
        "impersonatorId": null
      },
      "action": "tag.delete",
      "target": {
        "type": "tag",
        "id": "d2f4…:1.3.9",
        "label": "acme/api:1.3.9"
      },
      "details": {
        "outcome": {
          "deleted": "1.3.9",
          "latest": "unchanged"
        },
        "via": "api"
      },
      "ip": "10.0.0.7",
      "userAgent": "curl/8.7.1"
    }
  ],
  "page": 1,
  "perPage": 50,
  "total": 1,
  "pages": 1
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/audit"
~~~

### <a id="post-orgs"></a>`POST /api/v1/orgs`

Create an organization — The caller becomes its owner. Subject to the instance's organization-creation policy and the caller's limits; slugs become image namespaces.

**Who:** a signed-in user or personal access token · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `slug` | body | string | yes | Lowercase letters, digits and single ._- separators; the image namespace. |
| `name` | body | string |  | Display name; defaults to the slug. |

Response `201`:

~~~json
{
  "id": "9a1c…",
  "slug": "acme",
  "name": "Acme",
  "role": "owner",
  "repositoryCount": 0,
  "proxy": false,
  "createdAt": "2026-09-01T10:12:00.000Z",
  "url": "https://registry.example.com/acme",
  "memberCount": 1,
  "storageBytes": 0
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"slug":"…","name":"api"}' \
  "https://registry.example.com/api/v1/orgs"
~~~

### <a id="patch-orgs-org"></a>`PATCH /api/v1/orgs/{org}`

Rename an organization — Changes the display name (the slug is changed in the app, which sets up redirects).

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `name` | body | string | yes | New display name. |

Response `200`:

~~~json
{
  "id": "9a1c…",
  "slug": "acme",
  "name": "Acme Corp",
  "role": "admin",
  "repositoryCount": 12,
  "proxy": false,
  "createdAt": "2026-09-01T10:12:00.000Z",
  "url": "https://registry.example.com/acme",
  "memberCount": 5,
  "storageBytes": 12884901888
}
~~~

~~~sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"api"}' \
  "https://registry.example.com/api/v1/orgs/acme"
~~~

### <a id="delete-orgs-org"></a>`DELETE /api/v1/orgs/{org}`

Delete an organization — Owners only. Removes every repository, member, invitation and service account; blob data is reclaimed by garbage collection. The library organization cannot be deleted.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "deleted": "acme"
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme"
~~~

### <a id="get-orgs-org-usage"></a>`GET /api/v1/orgs/{org}/usage`

Usage against limits — Repositories, storage and members against the organization's limits (null = unlimited), the label administrators gave the limits (a plan name, say) and the month's traffic: `pullBytes` served by the registry itself, `redirectBytes` handed to the storage backend or CDN, `pushBytes` received.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `month` | query | string |  | Calendar month of the traffic figures, `YYYY-MM` in UTC (default: the current month). |

Response `200`:

~~~json
{
  "organization": "acme",
  "usage": {
    "publicRepositories": 2,
    "privateRepositories": 10,
    "storageBytes": 12884901888,
    "members": 4
  },
  "limits": {
    "maxPublicRepositories": null,
    "maxPrivateRepositories": 20,
    "maxStorageBytes": 53687091200,
    "maxMembers": 5
  },
  "percent": {
    "publicRepositories": null,
    "privateRepositories": 50,
    "storage": 24,
    "members": 80
  },
  "label": "Team",
  "traffic": {
    "month": "2026-09",
    "from": "2026-09-01",
    "to": "2026-10-01",
    "pullBytes": 734003200,
    "redirectBytes": 4194304000,
    "pushBytes": 268435456,
    "blobPulls": 812,
    "manifestPulls": 1290
  }
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/usage"
~~~

### <a id="get-orgs-org-policies"></a>`GET /api/v1/orgs/{org}/policies`

Organization policies — Default visibility for new repositories, the vulnerability pull policy, the signature policy and whether members' personal signing keys are trusted.

**Who:** organization members · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "defaultVisibility": "private",
  "pullPolicy": {
    "blockPullsAt": "high",
    "blockUnrated": false
  },
  "requireSignature": false,
  "trustMemberKeys": true
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/policies"
~~~

### <a id="patch-orgs-org-policies"></a>`PATCH /api/v1/orgs/{org}/policies`

Change organization policies — Send only the fields to change. Pull and signature changes recompute which images are blocked; changing trustMemberKeys re-verifies every signature.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `defaultVisibility` | body | public \| private \| null |  | null = each pusher's own default. |
| `blockPullsAt` | body | critical \| high \| medium \| low \| null |  | Block pulls of images with findings at this severity or above; null = never. |
| `blockUnrated` | body | boolean |  | Count findings without a rating. |
| `requireSignature` | body | boolean |  | Block pulls of unsigned images. |
| `trustMemberKeys` | body | boolean |  | Members' personal signing keys count as trusted. |

Response `200`:

~~~json
{
  "defaultVisibility": "private",
  "pullPolicy": {
    "blockPullsAt": "critical",
    "blockUnrated": true
  },
  "requireSignature": true,
  "trustMemberKeys": true
}
~~~

~~~sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"defaultVisibility":"…","blockPullsAt":"…","blockUnrated":true,"requireSignature":true,"trustMemberKeys":true}' \
  "https://registry.example.com/api/v1/orgs/acme/policies"
~~~

### <a id="get-orgs-org-service-accounts"></a>`GET /api/v1/orgs/{org}/service-accounts`

List service accounts.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "items": [
    {
      "id": "sa_4b…",
      "name": "ci-deploy",
      "description": "GitHub Actions",
      "permission": "push",
      "tokenPrefix": "chc_sa_ab12cd…",
      "repositories": null,
      "createdAt": "2026-09-01T10:00:00.000Z",
      "expiresAt": "2026-12-01T10:00:00.000Z",
      "lastUsedAt": "2026-09-05T08:41:00.000Z",
      "lastUsedIp": "10.0.0.9"
    }
  ],
  "total": 1
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/service-accounts"
~~~

### <a id="post-orgs-org-service-accounts"></a>`POST /api/v1/orgs/{org}/service-accounts`

Create a service account — The secret is in the answer once and never again. Expiry follows the instance's token policy.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `name` | body | string | yes | Lowercase letters, digits and single ._- separators; unique in the organization. |
| `description` | body | string |  | Shown in the list. |
| `permission` | body | pull \| push \| admin |  | Default pull; admin adds delete. |
| `expiresInDays` | body | integer |  | Lifetime in days; omit both expiry fields for never (when the policy allows). |
| `expiresAt` | body | date |  | Alternative to expiresInDays: an ISO date. |
| `repositories` | body | string[] |  | Limit to these repository names; omit for every repository. |

Response `201`:

~~~json
{
  "id": "sa_4b…",
  "name": "ci-deploy",
  "description": "GitHub Actions",
  "permission": "push",
  "tokenPrefix": "chc_sa_ab12cd…",
  "repositories": null,
  "createdAt": "2026-09-01T10:00:00.000Z",
  "expiresAt": "2026-12-01T10:00:00.000Z",
  "lastUsedAt": "2026-09-05T08:41:00.000Z",
  "lastUsedIp": "10.0.0.9",
  "secret": "chc_sa_ab12cd…full-secret"
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"api","description":"The public API server","permission":"…","expiresInDays":1,"expiresAt":"…","repositories":"…"}' \
  "https://registry.example.com/api/v1/orgs/acme/service-accounts"
~~~

### <a id="get-orgs-org-service-accounts-id"></a>`GET /api/v1/orgs/{org}/service-accounts/{id}`

Service account details.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `id` | path | string | yes | Service account id. |

Response `200`:

~~~json
{
  "id": "sa_4b…",
  "name": "ci-deploy",
  "description": "GitHub Actions",
  "permission": "push",
  "tokenPrefix": "chc_sa_ab12cd…",
  "repositories": null,
  "createdAt": "2026-09-01T10:00:00.000Z",
  "expiresAt": "2026-12-01T10:00:00.000Z",
  "lastUsedAt": "2026-09-05T08:41:00.000Z",
  "lastUsedIp": "10.0.0.9"
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/service-accounts/{id}"
~~~

### <a id="delete-orgs-org-service-accounts-id"></a>`DELETE /api/v1/orgs/{org}/service-accounts/{id}`

Delete a service account.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `id` | path | string | yes | Service account id. |

Response `200`:

~~~json
{
  "deleted": "sa_4b…",
  "name": "ci-deploy"
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/service-accounts/{id}"
~~~

### <a id="post-orgs-org-service-accounts-id-rotate"></a>`POST /api/v1/orgs/{org}/service-accounts/{id}/rotate`

Rotate a service account's secret — Same id, name, permission and repositories; the old secret stops working at once. The lifetime restarts from now under the policy.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `id` | path | string | yes | Service account id. |

Response `200`:

~~~json
{
  "id": "sa_4b…",
  "name": "ci-deploy",
  "description": "GitHub Actions",
  "permission": "push",
  "tokenPrefix": "chc_sa_ab12cd…",
  "repositories": null,
  "createdAt": "2026-09-01T10:00:00.000Z",
  "expiresAt": "2026-12-01T10:00:00.000Z",
  "lastUsedAt": "2026-09-05T08:41:00.000Z",
  "lastUsedIp": "10.0.0.9",
  "secret": "chc_sa_ef34gh…new-secret"
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/service-accounts/{id}/rotate"
~~~

### <a id="patch-orgs-org-members-userId"></a>`PATCH /api/v1/orgs/{org}/members/{userId}`

Change a member's role — Owners and admins; only owners (or instance administrators) may make or unmake owners, and the last owner cannot be demoted.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `userId` | path | string | yes | The member's user id. |
| `role` | body | owner \| admin \| member \| viewer | yes | New role. |

Response `200`:

~~~json
{
  "userId": "u_7f…",
  "name": "Jo Doe",
  "email": "jo@example.com",
  "role": "admin",
  "joinedAt": "2026-08-02T09:00:00.000Z"
}
~~~

~~~sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"role":"…"}' \
  "https://registry.example.com/api/v1/orgs/acme/members/{userId}"
~~~

### <a id="delete-orgs-org-members-userId"></a>`DELETE /api/v1/orgs/{org}/members/{userId}`

Remove a member — The last owner cannot be removed.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `userId` | path | string | yes | The member's user id. |

Response `200`:

~~~json
{
  "removed": "u_7f…",
  "email": "jo@example.com"
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/members/{userId}"
~~~

### <a id="get-orgs-org-invitations"></a>`GET /api/v1/orgs/{org}/invitations`

List pending invitations.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "items": [
    {
      "id": "inv_2e…",
      "email": "new@example.com",
      "role": "member",
      "status": "pending",
      "expiresAt": "2026-09-07T09:00:00.000Z",
      "createdAt": "2026-09-05T09:00:00.000Z",
      "inviterId": "u_7f…"
    }
  ],
  "total": 1
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/invitations"
~~~

### <a id="post-orgs-org-invitations"></a>`POST /api/v1/orgs/{org}/invitations`

Invite someone by email — Sends the invitation email when mail is configured (`emailSent` says whether it went out); `acceptUrl` can be handed over by other means. Invitations expire after 48 hours.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `email` | body | string | yes | Address to invite. |
| `role` | body | owner \| admin \| member \| viewer |  | Default member; owner needs an owner. |

Response `201`:

~~~json
{
  "id": "inv_2e…",
  "email": "new@example.com",
  "role": "member",
  "status": "pending",
  "expiresAt": "2026-09-07T09:00:00.000Z",
  "createdAt": "2026-09-05T09:00:00.000Z",
  "inviterId": "u_7f…",
  "emailSent": true,
  "acceptUrl": "https://registry.example.com/accept-invitation/inv_2e…"
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"email":"…","role":"…"}' \
  "https://registry.example.com/api/v1/orgs/acme/invitations"
~~~

### <a id="delete-orgs-org-invitations-id"></a>`DELETE /api/v1/orgs/{org}/invitations/{id}`

Cancel an invitation.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `id` | path | string | yes | Invitation id. |

Response `200`:

~~~json
{
  "canceled": "inv_2e…",
  "email": "new@example.com"
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/invitations/{id}"
~~~

### <a id="get-orgs-org-ci-identities"></a>`GET /api/v1/orgs/{org}/ci-identities`

List trusted CI identities — Workflows that may authenticate keylessly through POST /auth/exchange.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "items": [
    {
      "id": "ci_7a…",
      "name": "github-main",
      "issuer": "https://token.actions.githubusercontent.com",
      "subject": "repo:acme/api:ref:refs/heads/main",
      "permission": "push",
      "repositories": null,
      "createdAt": "2026-09-05T10:00:00.000Z",
      "lastUsedAt": "2026-09-05T10:30:00.000Z",
      "lastSubject": "repo:acme/api:ref:refs/heads/main"
    }
  ],
  "total": 1
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/ci-identities"
~~~

### <a id="post-orgs-org-ci-identities"></a>`POST /api/v1/orgs/{org}/ci-identities`

Trust a CI identity.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `name` | body | string | yes | Lowercase letters, digits and single ._- separators. |
| `issuer` | body | string | yes | The token's issuer URL, e.g. https://token.actions.githubusercontent.com or https://gitlab.com. |
| `subject` | body | string | yes | The token's sub claim, exact or with * wildcards, e.g. repo:acme/api:ref:refs/heads/main. |
| `permission` | body | pull \| push \| admin |  | Default push. |
| `repositories` | body | string[] |  | Limit to these repository names. |

Response `201`:

~~~json
{
  "id": "ci_7a…",
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:acme/api:ref:refs/heads/main",
  "permission": "push",
  "repositories": null,
  "createdAt": "2026-09-05T10:00:00.000Z",
  "lastUsedAt": "2026-09-05T10:30:00.000Z",
  "lastSubject": "repo:acme/api:ref:refs/heads/main"
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"api","issuer":"…","subject":"…","permission":"…","repositories":"…"}' \
  "https://registry.example.com/api/v1/orgs/acme/ci-identities"
~~~

### <a id="delete-orgs-org-ci-identities-id"></a>`DELETE /api/v1/orgs/{org}/ci-identities/{id}`

Stop trusting a CI identity — Credentials minted through it stop working at once.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `id` | path | string | yes | Identity id. |

Response `200`:

~~~json
{
  "deleted": "ci_7a…",
  "name": "github-main"
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/ci-identities/{id}"
~~~

### <a id="get-orgs-org-webhooks"></a>`GET /api/v1/orgs/{org}/webhooks`

List organization webhooks — Organization-wide hooks apply to every repository.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "items": [
    {
      "id": "wh_9c…",
      "name": "deploy",
      "url": "https://ci.example.com/hooks/registry",
      "method": "POST",
      "format": "json",
      "headers": {},
      "authType": "bearer",
      "authHeaderName": null,
      "hasAuthSecret": true,
      "hasSigningSecret": true,
      "events": [
        "push",
        "scan.completed"
      ],
      "enabled": true,
      "lastStatus": 200,
      "lastDeliveredAt": "2026-09-05T08:41:20.000Z",
      "lastError": null
    }
  ],
  "total": 1,
  "max": 10
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/webhooks"
~~~

### <a id="post-orgs-org-webhooks"></a>`POST /api/v1/orgs/{org}/webhooks`

Create a organization webhook.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `name` | body | string | yes | Up to 64 characters. |
| `url` | body | string | yes | http(s) URL the payload is sent to. |
| `events` | body | string[] | yes | Event names to subscribe to (see the webhooks documentation); at least one. |
| `format` | body | json \| slack \| discord \| teams \| text |  | Payload shape; default json. |
| `method` | body | POST \| PUT \| PATCH |  | JSON receivers only; chat formats always POST. |
| `headers` | body | object |  | Extra request headers, name → value. |
| `authType` | body | none \| bearer \| basic \| header |  | How `authSecret` is sent. |
| `authHeaderName` | body | string |  | Header name for authType header. |
| `authSecret` | body | string \| null |  | Stored encrypted, never returned. Omit to keep, null to clear. |
| `signingSecret` | body | string \| null |  | HMAC signing secret for the X-Chicoree-Signature header. Omit to keep, null to clear. |
| `enabled` | body | boolean |  | Default true. |

Response `201`:

~~~json
{
  "id": "wh_9c…",
  "name": "deploy",
  "url": "https://ci.example.com/hooks/registry",
  "method": "POST",
  "format": "json",
  "headers": {},
  "authType": "bearer",
  "authHeaderName": null,
  "hasAuthSecret": true,
  "hasSigningSecret": true,
  "events": [
    "push",
    "scan.completed"
  ],
  "enabled": true,
  "lastStatus": 200,
  "lastDeliveredAt": "2026-09-05T08:41:20.000Z",
  "lastError": null,
  "deliveries": []
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"api","url":"…","events":"…","format":"…","method":"…","headers":"…","authType":"…","authHeaderName":"…","authSecret":"…","signingSecret":"…","enabled":true}' \
  "https://registry.example.com/api/v1/orgs/acme/webhooks"
~~~

### <a id="get-orgs-org-webhooks-id"></a>`GET /api/v1/orgs/{org}/webhooks/{id}`

Organization webhook details — With the last deliveries.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `id` | path | string | yes | Webhook id. |

Response `200`:

~~~json
{
  "id": "wh_9c…",
  "name": "deploy",
  "url": "https://ci.example.com/hooks/registry",
  "method": "POST",
  "format": "json",
  "headers": {},
  "authType": "bearer",
  "authHeaderName": null,
  "hasAuthSecret": true,
  "hasSigningSecret": true,
  "events": [
    "push",
    "scan.completed"
  ],
  "enabled": true,
  "lastStatus": 200,
  "lastDeliveredAt": "2026-09-05T08:41:20.000Z",
  "lastError": null,
  "deliveries": [
    {
      "id": "d_1",
      "event": "push",
      "ok": true,
      "statusCode": 200,
      "attempts": 1,
      "durationMs": 120,
      "error": null,
      "createdAt": "2026-09-05T08:41:20.000Z"
    }
  ]
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/webhooks/{id}"
~~~

### <a id="patch-orgs-org-webhooks-id"></a>`PATCH /api/v1/orgs/{org}/webhooks/{id}`

Update a organization webhook — Omitted fields keep their value.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `id` | path | string | yes | Webhook id. |
| `name` | body | string |  | Up to 64 characters. |
| `url` | body | string |  | http(s) URL the payload is sent to. |
| `events` | body | string[] |  | Event names to subscribe to (see the webhooks documentation); at least one. |
| `format` | body | json \| slack \| discord \| teams \| text |  | Payload shape; default json. |
| `method` | body | POST \| PUT \| PATCH |  | JSON receivers only; chat formats always POST. |
| `headers` | body | object |  | Extra request headers, name → value. |
| `authType` | body | none \| bearer \| basic \| header |  | How `authSecret` is sent. |
| `authHeaderName` | body | string |  | Header name for authType header. |
| `authSecret` | body | string \| null |  | Stored encrypted, never returned. Omit to keep, null to clear. |
| `signingSecret` | body | string \| null |  | HMAC signing secret for the X-Chicoree-Signature header. Omit to keep, null to clear. |
| `enabled` | body | boolean |  | Default true. |

Response `200`:

~~~json
{
  "id": "wh_9c…",
  "name": "deploy",
  "url": "https://ci.example.com/hooks/registry",
  "method": "POST",
  "format": "json",
  "headers": {},
  "authType": "bearer",
  "authHeaderName": null,
  "hasAuthSecret": true,
  "hasSigningSecret": true,
  "events": [
    "push",
    "scan.completed"
  ],
  "enabled": true,
  "lastStatus": 200,
  "lastDeliveredAt": "2026-09-05T08:41:20.000Z",
  "lastError": null,
  "deliveries": []
}
~~~

~~~sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"api","url":"…","events":"…","format":"…","method":"…","headers":"…","authType":"…","authHeaderName":"…","authSecret":"…","signingSecret":"…","enabled":true}' \
  "https://registry.example.com/api/v1/orgs/acme/webhooks/{id}"
~~~

### <a id="delete-orgs-org-webhooks-id"></a>`DELETE /api/v1/orgs/{org}/webhooks/{id}`

Delete a organization webhook.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `id` | path | string | yes | Webhook id. |

Response `200`:

~~~json
{
  "deleted": "wh_9c…"
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/webhooks/{id}"
~~~

### <a id="post-orgs-org-webhooks-id-test"></a>`POST /api/v1/orgs/{org}/webhooks/{id}/test`

Send a test delivery — A push-shaped payload built from the most recent tag; the answer is what the receiver said.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `id` | path | string | yes | Webhook id. |

Response `200`:

~~~json
{
  "ok": true,
  "status": 200,
  "error": null
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/webhooks/{id}/test"
~~~

## Repositories



### <a id="get-repos-org-repo"></a>`GET /api/v1/repos/{org}/{repo}`

Repository details — The listing fields plus the README (Markdown), storage figures and whether the caller starred it.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |

Response `200`:

~~~json
{
  "id": "d2f4…",
  "organization": "acme",
  "name": "api",
  "path": "acme/api",
  "reference": "registry.example.com/acme/api",
  "description": "The public API server",
  "visibility": "private",
  "pullCount": 4213,
  "starCount": 3,
  "tagCount": 18,
  "sizeBytes": 734003200,
  "lastPushedAt": "2026-09-05T08:41:12.000Z",
  "updatedAt": "2026-09-05T08:41:12.000Z",
  "proxy": false,
  "lastCheckedAt": null,
  "url": "https://registry.example.com/acme/api",
  "createdAt": "2026-08-02T09:00:00.000Z",
  "readme": "# api\n\nHow to run it…",
  "storage": {
    "logicalBytes": 2147483648,
    "physicalBytes": 734003200,
    "sharedBytes": 402653184,
    "sharedWithRepositories": 3
  },
  "starred": false
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/repos/acme/api"
~~~

### <a id="patch-repos-org-repo"></a>`PATCH /api/v1/repos/{org}/{repo}`

Update a repository — Change the description and/or the visibility. Omitted fields stay as they are.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `description` | body | string |  | New description (empty string clears it). |
| `visibility` | body | public \| private |  | Quotas apply when switching. |

Response `200`:

~~~json
{
  "id": "d2f4…",
  "organization": "acme",
  "name": "api",
  "path": "acme/api",
  "reference": "registry.example.com/acme/api",
  "description": "The public API server",
  "visibility": "private",
  "pullCount": 4213,
  "starCount": 3,
  "tagCount": 18,
  "sizeBytes": 734003200,
  "lastPushedAt": "2026-09-05T08:41:12.000Z",
  "updatedAt": "2026-09-05T08:41:12.000Z",
  "proxy": false,
  "lastCheckedAt": null,
  "url": "https://registry.example.com/acme/api"
}
~~~

~~~sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"description":"The public API server","visibility":"private"}' \
  "https://registry.example.com/api/v1/repos/acme/api"
~~~

### <a id="delete-repos-org-repo"></a>`DELETE /api/v1/repos/{org}/{repo}`

Delete a repository — Removes the repository with all its tags and manifests. Blob data is reclaimed by the next garbage collection.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |

Response `200`:

~~~json
{
  "deleted": "acme/api"
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api"
~~~

### <a id="get-repos-org-repo-policies"></a>`GET /api/v1/repos/{org}/{repo}/policies`

Repository policies — The repository's overrides (`inherit` = the organization's setting) and what applies after folding them in.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |

Response `200`:

~~~json
{
  "blockPullsAt": "inherit",
  "blockUnrated": null,
  "requireSignature": "inherit",
  "effective": {
    "pullPolicy": {
      "level": "high",
      "unrated": false
    },
    "requireSignature": false
  }
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/repos/acme/api/policies"
~~~

### <a id="patch-repos-org-repo-policies"></a>`PATCH /api/v1/repos/{org}/{repo}/policies`

Change repository policies — Send only the fields to change; blocked images are recomputed and `blocked` says how many there are now.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `blockPullsAt` | body | inherit \| off \| critical \| high \| medium \| low |  | Override of the pull policy. |
| `blockUnrated` | body | boolean \| null |  | Override for unrated findings; null inherits. |
| `requireSignature` | body | inherit \| boolean |  | Override of the signature policy. |

Response `200`:

~~~json
{
  "blockPullsAt": "critical",
  "blockUnrated": true,
  "requireSignature": "inherit",
  "effective": {
    "pullPolicy": {
      "level": "critical",
      "unrated": true
    },
    "requireSignature": false
  },
  "blocked": 2
}
~~~

~~~sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"blockPullsAt":"…","blockUnrated":"…","requireSignature":"…"}' \
  "https://registry.example.com/api/v1/repos/acme/api/policies"
~~~

### <a id="get-repos-org-repo-webhooks"></a>`GET /api/v1/repos/{org}/{repo}/webhooks`

List repository webhooks — The repository's own hooks; organization-wide ones are listed on the organization.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |

Response `200`:

~~~json
{
  "items": [
    {
      "id": "wh_9c…",
      "name": "deploy",
      "url": "https://ci.example.com/hooks/registry",
      "method": "POST",
      "format": "json",
      "headers": {},
      "authType": "bearer",
      "authHeaderName": null,
      "hasAuthSecret": true,
      "hasSigningSecret": true,
      "events": [
        "push",
        "scan.completed"
      ],
      "enabled": true,
      "lastStatus": 200,
      "lastDeliveredAt": "2026-09-05T08:41:20.000Z",
      "lastError": null
    }
  ],
  "total": 1,
  "max": 5
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api/webhooks"
~~~

### <a id="post-repos-org-repo-webhooks"></a>`POST /api/v1/repos/{org}/{repo}/webhooks`

Create a repository webhook.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `name` | body | string | yes | Up to 64 characters. |
| `url` | body | string | yes | http(s) URL the payload is sent to. |
| `events` | body | string[] | yes | Event names to subscribe to (see the webhooks documentation); at least one. |
| `format` | body | json \| slack \| discord \| teams \| text |  | Payload shape; default json. |
| `method` | body | POST \| PUT \| PATCH |  | JSON receivers only; chat formats always POST. |
| `headers` | body | object |  | Extra request headers, name → value. |
| `authType` | body | none \| bearer \| basic \| header |  | How `authSecret` is sent. |
| `authHeaderName` | body | string |  | Header name for authType header. |
| `authSecret` | body | string \| null |  | Stored encrypted, never returned. Omit to keep, null to clear. |
| `signingSecret` | body | string \| null |  | HMAC signing secret for the X-Chicoree-Signature header. Omit to keep, null to clear. |
| `enabled` | body | boolean |  | Default true. |

Response `201`:

~~~json
{
  "id": "wh_9c…",
  "name": "deploy",
  "url": "https://ci.example.com/hooks/registry",
  "method": "POST",
  "format": "json",
  "headers": {},
  "authType": "bearer",
  "authHeaderName": null,
  "hasAuthSecret": true,
  "hasSigningSecret": true,
  "events": [
    "push",
    "scan.completed"
  ],
  "enabled": true,
  "lastStatus": 200,
  "lastDeliveredAt": "2026-09-05T08:41:20.000Z",
  "lastError": null,
  "deliveries": []
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"api","url":"…","events":"…","format":"…","method":"…","headers":"…","authType":"…","authHeaderName":"…","authSecret":"…","signingSecret":"…","enabled":true}' \
  "https://registry.example.com/api/v1/repos/acme/api/webhooks"
~~~

### <a id="get-repos-org-repo-webhooks-id"></a>`GET /api/v1/repos/{org}/{repo}/webhooks/{id}`

Repository webhook details — With the last deliveries.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `id` | path | string | yes | Webhook id. |

Response `200`:

~~~json
{
  "id": "wh_9c…",
  "name": "deploy",
  "url": "https://ci.example.com/hooks/registry",
  "method": "POST",
  "format": "json",
  "headers": {},
  "authType": "bearer",
  "authHeaderName": null,
  "hasAuthSecret": true,
  "hasSigningSecret": true,
  "events": [
    "push",
    "scan.completed"
  ],
  "enabled": true,
  "lastStatus": 200,
  "lastDeliveredAt": "2026-09-05T08:41:20.000Z",
  "lastError": null,
  "deliveries": [
    {
      "id": "d_1",
      "event": "push",
      "ok": true,
      "statusCode": 200,
      "attempts": 1,
      "durationMs": 120,
      "error": null,
      "createdAt": "2026-09-05T08:41:20.000Z"
    }
  ]
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api/webhooks/{id}"
~~~

### <a id="patch-repos-org-repo-webhooks-id"></a>`PATCH /api/v1/repos/{org}/{repo}/webhooks/{id}`

Update a repository webhook — Omitted fields keep their value.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `id` | path | string | yes | Webhook id. |
| `name` | body | string |  | Up to 64 characters. |
| `url` | body | string |  | http(s) URL the payload is sent to. |
| `events` | body | string[] |  | Event names to subscribe to (see the webhooks documentation); at least one. |
| `format` | body | json \| slack \| discord \| teams \| text |  | Payload shape; default json. |
| `method` | body | POST \| PUT \| PATCH |  | JSON receivers only; chat formats always POST. |
| `headers` | body | object |  | Extra request headers, name → value. |
| `authType` | body | none \| bearer \| basic \| header |  | How `authSecret` is sent. |
| `authHeaderName` | body | string |  | Header name for authType header. |
| `authSecret` | body | string \| null |  | Stored encrypted, never returned. Omit to keep, null to clear. |
| `signingSecret` | body | string \| null |  | HMAC signing secret for the X-Chicoree-Signature header. Omit to keep, null to clear. |
| `enabled` | body | boolean |  | Default true. |

Response `200`:

~~~json
{
  "id": "wh_9c…",
  "name": "deploy",
  "url": "https://ci.example.com/hooks/registry",
  "method": "POST",
  "format": "json",
  "headers": {},
  "authType": "bearer",
  "authHeaderName": null,
  "hasAuthSecret": true,
  "hasSigningSecret": true,
  "events": [
    "push",
    "scan.completed"
  ],
  "enabled": true,
  "lastStatus": 200,
  "lastDeliveredAt": "2026-09-05T08:41:20.000Z",
  "lastError": null,
  "deliveries": []
}
~~~

~~~sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"name":"api","url":"…","events":"…","format":"…","method":"…","headers":"…","authType":"…","authHeaderName":"…","authSecret":"…","signingSecret":"…","enabled":true}' \
  "https://registry.example.com/api/v1/repos/acme/api/webhooks/{id}"
~~~

### <a id="delete-repos-org-repo-webhooks-id"></a>`DELETE /api/v1/repos/{org}/{repo}/webhooks/{id}`

Delete a repository webhook.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `id` | path | string | yes | Webhook id. |

Response `200`:

~~~json
{
  "deleted": "wh_9c…"
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api/webhooks/{id}"
~~~

### <a id="post-repos-org-repo-webhooks-id-test"></a>`POST /api/v1/repos/{org}/{repo}/webhooks/{id}/test`

Send a test delivery — A push-shaped payload built from the most recent tag; the answer is what the receiver said.

**Who:** organization owners and admins · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `id` | path | string | yes | Webhook id. |

Response `200`:

~~~json
{
  "ok": true,
  "status": 200,
  "error": null
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api/webhooks/{id}/test"
~~~

### <a id="put-repos-org-repo-star"></a>`PUT /api/v1/repos/{org}/{repo}/star`

Star a repository.

**Who:** a signed-in user or personal access token · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |

Response `200`:

~~~json
{
  "starred": true,
  "count": 4
}
~~~

~~~sh
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api/star"
~~~

### <a id="delete-repos-org-repo-star"></a>`DELETE /api/v1/repos/{org}/{repo}/star`

Unstar a repository.

**Who:** a signed-in user or personal access token · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |

Response `200`:

~~~json
{
  "starred": false,
  "count": 3
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api/star"
~~~

## Tags



### <a id="get-repos-org-repo-tags"></a>`GET /api/v1/repos/{org}/{repo}/tags`

List tags — Newest push first. Index tags carry their variants' scans rolled up (worst case wins).

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Paginated** · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `include_artifacts` | query | boolean |  | Also list cosign signature / attestation / SBOM tags (`sha256-….sig`) and index members. Default false. |
| `page` | query | integer |  | Page number, from 1. |
| `per_page` | query | integer |  | Rows per page, 1–100 (default 50). |

Response `200`:

~~~json
{
  "items": [
    {
      "name": "1.4.0",
      "digest": "sha256:5f2b…",
      "mediaType": "application/vnd.oci.image.index.v1+json",
      "isIndex": true,
      "sizeBytes": 48211234,
      "layerCount": null,
      "pushedAt": "2026-09-05T08:41:12.000Z",
      "signed": true,
      "blocked": null,
      "scan": {
        "status": "scanned",
        "summary": {
          "High": 2,
          "Medium": 7,
          "Low": 11,
          "Unknown": 1
        }
      },
      "proxyCheckedAt": null,
      "url": "https://registry.example.com/acme/api/tags/1.4.0"
    }
  ],
  "page": 1,
  "perPage": 50,
  "total": 18,
  "pages": 1
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/repos/acme/api/tags"
~~~

### <a id="get-repos-org-repo-tags-tag"></a>`GET /api/v1/repos/{org}/{repo}/tags/{tag}`

Tag details — The image the tag points at — every field of *Image details*, plus `tag` and `tagPushedAt`; `reference` and `url` name the tag.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `tag` | path | string | yes | Tag name. |

Response `200`:

~~~json
{
  "tag": "1.4.0",
  "tagPushedAt": "2026-09-05T08:41:12.000Z",
  "digest": "sha256:5f2b…",
  "tags": [
    "1.4.0",
    "latest"
  ],
  "isIndex": false,
  "platform": "linux/amd64",
  "signed": true,
  "blocked": null
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/repos/acme/api/tags/1.4.0"
~~~

### <a id="put-repos-org-repo-tags-tag"></a>`PUT /api/v1/repos/{org}/{repo}/tags/{tag}`

Tag an image (retag) — Points the tag at an image that already exists in the repository — "promote this build to latest" without pulling and pushing. The stored manifest is pushed under the tag, so webhooks and scans follow as for any push. Immutable tags are refused when they would move; a tag already naming the digest is left alone (`changed: false`). Answers 201 for a new tag, 200 otherwise, with the image document.

**Who:** organization owners, admins and members · **Service accounts:** yes · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `tag` | path | string | yes | Tag name to create or move. |
| `digest` | body | string | yes | Digest of an image in this repository. |

Response `200`:

~~~json
{
  "tag": "latest",
  "previousDigest": "sha256:a1b2…",
  "changed": true,
  "digest": "sha256:5f2b…",
  "tags": [
    "1.4.0",
    "latest"
  ],
  "isIndex": false,
  "signed": true,
  "blocked": null
}
~~~

~~~sh
curl -X PUT -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"digest":"…"}' \
  "https://registry.example.com/api/v1/repos/acme/api/tags/1.4.0"
~~~

### <a id="post-repos-org-repo-tags-tag-copy"></a>`POST /api/v1/repos/{org}/{repo}/tags/{tag}/copy`

Copy (promote) a tagged image to another repository — Copies the image — every platform variant, its layers (mounted, not re-uploaded, when both repositories share storage) and, unless `includeArtifacts` is false, its signatures, SBOMs and provenance — into another repository, creating it when missing. Needs push rights on both sides; proxy caches, immutable destination tags and quotas are respected.

**Who:** organization owners, admins and members · **Service accounts:** yes · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `tag` | path | string | yes | Source tag. |
| `organization` | body | string |  | Destination organization slug; default: the source organization. |
| `repository` | body | string | yes | Destination repository name (created when missing). |
| `tag` | body | string |  | Destination tag; default: the source tag. |
| `includeArtifacts` | body | boolean |  | Copy attached signatures, SBOMs and provenance too. Default true. |

Response `201`:

~~~json
{
  "from": "acme/api:1.4.0",
  "to": "acme/api-prod:1.4.0",
  "digest": "sha256:5f2b…",
  "destination": {
    "organization": "acme",
    "repository": "api-prod",
    "tag": "1.4.0",
    "created": true
  },
  "blobsMounted": 9,
  "blobsUploaded": 0,
  "manifestsPushed": 4,
  "artifactsCopied": 1
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"organization":"…","repository":"…","tag":"…","includeArtifacts":true}' \
  "https://registry.example.com/api/v1/repos/acme/api/tags/1.4.0/copy"
~~~

### <a id="delete-repos-org-repo-tags-tag"></a>`DELETE /api/v1/repos/{org}/{repo}/tags/{tag}`

Delete a tag — Removes the tag through the registry. When `latest` pointed at the deleted image it moves to the newest remaining tag (or goes with the last image) unless `keep_latest=true`. Protected tags are refused.

**Who:** organization owners and admins · **Service accounts:** yes · **Write:** needs a read & write token · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `tag` | path | string | yes | Tag name. |
| `keep_latest` | query | boolean |  | Leave `latest` where it is. Default false. |

Response `200`:

~~~json
{
  "deleted": "1.3.9",
  "latest": "moved",
  "latestTarget": "1.4.0"
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api/tags/1.4.0"
~~~

### <a id="get-repos-org-repo-untagged"></a>`GET /api/v1/repos/{org}/{repo}/untagged`

List untagged manifests — Manifests no tag points at, newest first — what *prune-untagged* would remove. Index members and attached artifacts are left out unless `include_artifacts=true`.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Paginated** · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `include_artifacts` | query | boolean |  | Also list cosign signature / attestation / SBOM tags (`sha256-….sig`) and index members. Default false. |
| `page` | query | integer |  | Page number, from 1. |
| `per_page` | query | integer |  | Rows per page, 1–100 (default 50). |

Response `200`:

~~~json
{
  "items": [
    {
      "digest": "sha256:9c0e…",
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "artifactType": null,
      "isIndex": false,
      "sizeBytes": 1421,
      "contentBytes": 48211234,
      "platform": "linux/arm64",
      "pushedAt": "2026-09-01T07:00:00.000Z",
      "pushedBy": "user:u_7f…",
      "indexMember": false,
      "parentTags": [],
      "attestation": false,
      "referrer": false,
      "subjectDigest": null,
      "referrerCount": 0
    }
  ],
  "page": 1,
  "perPage": 50,
  "total": 1,
  "pages": 1
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/repos/acme/api/untagged"
~~~

## Images



### <a id="get-repos-org-repo-manifests-digest"></a>`GET /api/v1/repos/{org}/{repo}/manifests/{digest}`

Image details — Everything the tag page shows: media type, size, tags, who pushed it, the image config (platform, entrypoint, labels), layers with their Dockerfile instructions, the variants of an index, the scan result, signature state and the pull-policy block reason.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `digest` | path | string | yes | Manifest digest, `sha256:<64 hex>`. |

Response `200`:

~~~json
{
  "digest": "sha256:5f2b…",
  "tags": [
    "1.4.0",
    "latest"
  ],
  "mediaType": "application/vnd.oci.image.manifest.v1+json",
  "artifactType": null,
  "isIndex": false,
  "manifestBytes": 1421,
  "sizeBytes": 48211234,
  "pushedAt": "2026-09-05T08:41:12.000Z",
  "pushedBy": {
    "type": "user",
    "id": "u_7f…",
    "label": "Jo Doe"
  },
  "platform": "linux/amd64",
  "config": {
    "created": "2026-09-05T08:40:51.000Z",
    "os": "linux",
    "architecture": "amd64",
    "variant": null,
    "user": "app",
    "workingDir": "/app",
    "entrypoint": [
      "/app/server"
    ],
    "cmd": [],
    "env": [
      "PATH=/usr/local/sbin:…"
    ],
    "exposedPorts": [
      "8080/tcp"
    ],
    "labels": {
      "org.opencontainers.image.source": "https://github.com/acme/api"
    }
  },
  "layers": [
    {
      "digest": "sha256:aa…",
      "sizeBytes": 3400000,
      "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
      "command": "ADD alpine-minirootfs.tar.gz /"
    }
  ],
  "variants": [],
  "indexes": [],
  "subjectDigest": null,
  "scan": {
    "status": "scanned",
    "scanner": "trivy",
    "scannerVersion": "0.74.0",
    "updatedAt": "2026-09-05T08:43:02.000Z",
    "summary": {
      "Critical": 0,
      "High": 2,
      "Medium": 7,
      "Low": 11,
      "Negligible": 0,
      "Unknown": 1
    },
    "effectiveSummary": {
      "Critical": 0,
      "High": 1,
      "Medium": 7,
      "Low": 11,
      "Negligible": 0,
      "Unknown": 1
    },
    "error": null
  },
  "signed": true,
  "blocked": null,
  "canDelete": {
    "ok": true,
    "reason": null
  },
  "reference": "registry.example.com/acme/api@sha256:5f2b…",
  "url": "https://registry.example.com/acme/api/tags/sha256:5f2b…"
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/repos/acme/api/manifests/sha256:5f2b…"
~~~

### <a id="delete-repos-org-repo-manifests-digest"></a>`DELETE /api/v1/repos/{org}/{repo}/manifests/{digest}`

Delete an image by digest — Every tag pointing at it goes too. Members of an index that still exists and images carrying a protected tag are refused.

**Who:** organization owners and admins · **Service accounts:** yes · **Write:** needs a read & write token · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `digest` | path | string | yes | Manifest digest, `sha256:<64 hex>`. |

Response `200`:

~~~json
{
  "digest": "sha256:5f2b…",
  "tags": [
    "1.3.9"
  ]
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api/manifests/sha256:5f2b…"
~~~

### <a id="post-repos-org-repo-manifests-digest-copy"></a>`POST /api/v1/repos/{org}/{repo}/manifests/{digest}/copy`

Copy an image by digest to another repository — The same as copying a tag, for an image addressed by digest; `tag` is required.

**Who:** organization owners, admins and members · **Service accounts:** yes · **Write:** needs a read & write token · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `digest` | path | string | yes | Manifest digest, `sha256:<64 hex>`. |
| `organization` | body | string |  | Destination organization slug; default: the source organization. |
| `repository` | body | string | yes | Destination repository name (created when missing). |
| `tag` | body | string | yes | Destination tag. |
| `includeArtifacts` | body | boolean |  | Copy attached signatures, SBOMs and provenance too. Default true. |

Response `201`:

~~~json
{
  "from": "acme/api@sha256:5f2b…",
  "to": "acme/api-prod:1.4.0",
  "digest": "sha256:5f2b…",
  "destination": {
    "organization": "acme",
    "repository": "api-prod",
    "tag": "1.4.0",
    "created": false
  },
  "blobsMounted": 9,
  "blobsUploaded": 0,
  "manifestsPushed": 4,
  "artifactsCopied": 1
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"organization":"…","repository":"…","tag":"…","includeArtifacts":true}' \
  "https://registry.example.com/api/v1/repos/acme/api/manifests/sha256:5f2b…/copy"
~~~

### <a id="get-repos-org-repo-manifests-digest-scan"></a>`GET /api/v1/repos/{org}/{repo}/manifests/{digest}/scan`

Scan gate — The image's current scan judged against a severity threshold — what a pipeline calls before shipping. `wait` blocks until a running scan finishes (at most 300 s); `fail_on` sets the threshold, accepted risks do not count, `unrated` adds findings without a rating. `passed` is true or false when the image could be judged, null otherwise (`note` says why). Indexes are not scanned: gate a platform variant.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Since:** 2026-09-05.3

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `digest` | path | string | yes | Manifest digest, `sha256:<64 hex>`. |
| `wait` | query | integer |  | Seconds to wait for a running scan, 0–300. |
| `fail_on` | query | critical \| high \| medium \| low |  | Fail on findings at this severity or above; omitted = report only. |
| `unrated` | query | boolean |  | Count findings without a rating as failures. |

Response `200`:

~~~json
{
  "digest": "sha256:5f2b…",
  "isIndex": false,
  "scan": {
    "status": "scanned",
    "scanner": "trivy",
    "scannerVersion": "0.74.0",
    "updatedAt": "2026-09-05T08:43:02.000Z",
    "summary": {
      "Critical": 0,
      "High": 2,
      "Medium": 7,
      "Low": 11,
      "Negligible": 0,
      "Unknown": 1
    },
    "effectiveSummary": {
      "Critical": 0,
      "High": 1,
      "Medium": 7,
      "Low": 11,
      "Negligible": 0,
      "Unknown": 1
    },
    "error": null
  },
  "summary": {
    "High": 2,
    "Medium": 7,
    "Low": 11,
    "Unknown": 1
  },
  "effectiveSummary": {
    "High": 1,
    "Medium": 7,
    "Low": 11,
    "Unknown": 1
  },
  "threshold": {
    "failOn": "high",
    "unrated": false
  },
  "passed": false,
  "violation": "1 high finding; policy blocks high and above",
  "note": null,
  "checkedAt": "2026-09-05T09:00:00.000Z"
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/repos/acme/api/manifests/sha256:5f2b…/scan"
~~~

### <a id="post-repos-org-repo-manifests-digest-scan"></a>`POST /api/v1/repos/{org}/{repo}/manifests/{digest}/scan`

Queue a vulnerability scan — Re-scans one image. Indexes, attestations and images already being scanned are refused with the reason in `message`; `queued` says whether a scan started. With `wait` the call also waits for the result and answers like the scan gate (200 instead of 202).

**Who:** instance administrators · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `digest` | path | string | yes | Manifest digest, `sha256:<64 hex>`. |
| `wait` | query | integer |  | Seconds to wait for the scan, 0–300; with a value the answer is the scan gate document. |
| `fail_on` | query | critical \| high \| medium \| low |  | Threshold for the gate when waiting. |
| `unrated` | query | boolean |  | Count unrated findings as failures when waiting. |

Response `202`:

~~~json
{
  "queued": true,
  "message": "Scan queued; the result appears when it finishes."
}
~~~

~~~sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/repos/acme/api/manifests/sha256:5f2b…/scan"
~~~

## Security



### <a id="get-repos-org-repo-manifests-digest-vulnerabilities"></a>`GET /api/v1/repos/{org}/{repo}/manifests/{digest}/vulnerabilities`

Vulnerabilities of an image — The normalised findings of the last scan, worst first, each with the accepted risk that covers it (if any). `summary` counts every finding, `effectiveSummary` only those no exception accepts — what the pull policy judges.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Paginated** · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `digest` | path | string | yes | Manifest digest, `sha256:<64 hex>`. |
| `severity` | query | string |  | Comma-separated: Critical, High, Medium, Low, Negligible, Unknown. |
| `fixed` | query | boolean |  | Only findings with a fixed version. |
| `q` | query | string |  | Substring of the id, package, title or ecosystem. |
| `include_accepted` | query | boolean |  | Include findings an accepted risk covers. Default true. |
| `format` | query | json \| sarif \| vex |  | `sarif`: the whole image as SARIF 2.1.0 (GitHub code scanning; accepted risks become suppressions). `vex`: a CycloneDX 1.5 VEX document (accepted risks are not_affected with the justification). Filters and paging apply to json only. |
| `page` | query | integer |  | Page number, from 1. |
| `per_page` | query | integer |  | Rows per page, 1–100 (default 50). |

Response `200`:

~~~json
{
  "digest": "sha256:5f2b…",
  "scan": {
    "status": "scanned",
    "scanner": "trivy",
    "scannerVersion": "0.74.0",
    "updatedAt": "2026-09-05T08:43:02.000Z",
    "summary": {
      "Critical": 0,
      "High": 2,
      "Medium": 7,
      "Low": 11,
      "Negligible": 0,
      "Unknown": 1
    },
    "effectiveSummary": {
      "Critical": 0,
      "High": 1,
      "Medium": 7,
      "Low": 11,
      "Negligible": 0,
      "Unknown": 1
    },
    "error": null
  },
  "items": [
    {
      "id": "CVE-2026-1234",
      "severity": "High",
      "package": "openssl",
      "version": "3.3.1-r0",
      "fixedIn": "3.3.2-r0",
      "type": "os",
      "ecosystem": "alpine",
      "distro": "Alpine Linux v3.21",
      "title": "openssl: buffer overflow in …",
      "description": "…",
      "links": [
        "https://nvd.nist.gov/vuln/detail/CVE-2026-1234"
      ],
      "layerDigest": "sha256:aa…",
      "accepted": null
    }
  ],
  "page": 1,
  "perPage": 50,
  "total": 21,
  "pages": 1
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/repos/acme/api/manifests/sha256:5f2b…/vulnerabilities"
~~~

### <a id="get-repos-org-repo-manifests-digest-artifacts"></a>`GET /api/v1/repos/{org}/{repo}/manifests/{digest}/artifacts`

Signatures, SBOMs and provenance of an image — The attached artifacts (referrers API and cosign tag convention) with their verification state against the trusted keys and identities in scope. For an index, the variants' artifacts are included.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `repo` | path | string | yes | Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`. |
| `digest` | path | string | yes | Manifest digest, `sha256:<64 hex>`. |

Response `200`:

~~~json
{
  "subjects": [
    {
      "digest": "sha256:5f2b…",
      "label": "image"
    }
  ],
  "signatures": [
    {
      "digest": "sha256:77…",
      "subjectDigest": "sha256:5f2b…",
      "source": "referrer",
      "tag": null,
      "createdAt": "2026-09-05T08:41:40.000Z",
      "sizeBytes": 2311,
      "mediaType": "application/vnd.oci.image.manifest.v1+json",
      "artifactType": "application/vnd.dev.cosign.simplesigning.v1+json",
      "format": "sigstore-bundle",
      "predicateType": null,
      "signatures": 1,
      "verification": {
        "status": "verified",
        "keyName": "release",
        "signer": null,
        "keyFingerprint": "SHA256:…",
        "identity": null,
        "issuer": null,
        "description": "verified by key release"
      },
      "download": "https://registry.example.com/api/artifacts/acme%2Fapi/sha256:77…"
    }
  ],
  "sboms": [],
  "provenance": [],
  "others": [],
  "trustedKeys": 1,
  "memberKeys": 0,
  "trustedIdentities": 0,
  "total": 1
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/repos/acme/api/manifests/sha256:5f2b…/artifacts"
~~~

## Search



### <a id="get-search"></a>`GET /api/v1/search`

Search — Repositories (name, description, `org/name`), tags (`repo:tag` narrows the repository), manifest digests (a hex prefix) and organizations the caller may see. Every group is paged on its own with `page`/`per_page`.

**Who:** anyone (public repositories only without credentials) · **Service accounts:** yes · **Write:** no · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `q` | query | string | yes | At least 2 characters. |
| `type` | query | repositories \| tags \| digests \| organizations |  | Only one group (default: all four). |
| `page` | query | integer |  | Page number, from 1. |
| `per_page` | query | integer |  | Rows per page, 1–100 (default 50). |

Response `200`:

~~~json
{
  "q": "api",
  "total": 3,
  "repositories": {
    "items": [
      {
        "id": "d2f4…",
        "organization": "acme",
        "name": "api",
        "path": "acme/api",
        "reference": "registry.example.com/acme/api",
        "description": "The public API server",
        "visibility": "private",
        "pullCount": 4213,
        "starCount": 3,
        "tagCount": 18,
        "sizeBytes": 734003200,
        "lastPushedAt": "2026-09-05T08:41:12.000Z",
        "updatedAt": "2026-09-05T08:41:12.000Z",
        "proxy": false,
        "lastCheckedAt": null,
        "url": "https://registry.example.com/acme/api"
      }
    ],
    "page": 1,
    "perPage": 20,
    "total": 1,
    "pages": 1
  },
  "tags": {
    "items": [
      {
        "organization": "acme",
        "repository": "api",
        "tag": "api-1",
        "digest": "sha256:…",
        "pushedAt": "…",
        "visibility": "private"
      }
    ],
    "page": 1,
    "perPage": 20,
    "total": 1,
    "pages": 1
  },
  "digests": {
    "items": [],
    "page": 1,
    "perPage": 20,
    "total": 0,
    "pages": 1
  },
  "organizations": {
    "items": [
      {
        "slug": "acme",
        "name": "Acme",
        "repositoryCount": 12,
        "member": true
      }
    ],
    "page": 1,
    "perPage": 20,
    "total": 1,
    "pages": 1
  }
}
~~~

~~~sh
curl \
  "https://registry.example.com/api/v1/search?q=api"
~~~

## Account



### <a id="get-me-starred"></a>`GET /api/v1/me/starred`

Repositories I starred.

**Who:** a signed-in user or personal access token · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.1

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `limit` | query | integer |  | At most this many, 1–200 (default 50). |

Response `200`:

~~~json
{
  "items": [
    {
      "id": "d2f4…",
      "organization": "acme",
      "name": "api",
      "path": "acme/api",
      "reference": "registry.example.com/acme/api",
      "description": "The public API server",
      "visibility": "private",
      "pullCount": 4213,
      "starCount": 3,
      "tagCount": 18,
      "sizeBytes": 734003200,
      "lastPushedAt": "2026-09-05T08:41:12.000Z",
      "updatedAt": "2026-09-05T08:41:12.000Z",
      "proxy": false,
      "lastCheckedAt": null,
      "url": "https://registry.example.com/acme/api",
      "starredAt": "2026-09-03T12:00:00.000Z"
    }
  ],
  "total": 1
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/me/starred"
~~~

### <a id="get-me-usage"></a>`GET /api/v1/me/usage`

My usage against my limits — What counts against the caller's account limits: the organizations they own that have no limit of their own for that kind; with the month's traffic and the label administrators gave the account (a plan name, say).

**Who:** a signed-in user or personal access token · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `month` | query | string |  | Calendar month of the traffic figures, `YYYY-MM` in UTC (default: the current month). |

Response `200`:

~~~json
{
  "user": "u_7f…",
  "usage": {
    "organizations": 2,
    "publicRepositories": 3,
    "privateRepositories": 12,
    "storageBytes": 21474836480,
    "members": 6
  },
  "limits": {
    "maxOrganizations": null,
    "maxPublicRepositories": null,
    "maxPrivateRepositories": null,
    "maxStorageBytes": 107374182400
  },
  "percent": {
    "organizations": null,
    "publicRepositories": null,
    "privateRepositories": null,
    "storage": 20
  },
  "label": "Pro",
  "traffic": {
    "month": "2026-09",
    "from": "2026-09-01",
    "to": "2026-10-01",
    "pullBytes": 734003200,
    "redirectBytes": 4194304000,
    "pushBytes": 268435456,
    "blobPulls": 812,
    "manifestPulls": 1290
  }
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/me/usage"
~~~

## Administration



### <a id="get-users"></a>`GET /api/v1/users`

List users — Accounts on this instance. `email` finds one address exactly (case-insensitive); `q` searches names and addresses. Read-only tokens may read.

**Who:** instance administrators · **Service accounts:** no · **Write:** no · **Paginated** · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `email` | query | string |  | Exact email address. |
| `q` | query | string |  | Substring of the name or email. |
| `page` | query | integer |  | Page number, from 1. |
| `per_page` | query | integer |  | Rows per page, 1–100 (default 50). |

Response `200`:

~~~json
{
  "items": [
    {
      "id": "u_7f…",
      "name": "Jo Doe",
      "email": "jo@example.com",
      "role": "user",
      "emailVerified": true,
      "twoFactorEnabled": false,
      "banned": false,
      "createdAt": "2026-08-30T08:00:00.000Z"
    }
  ],
  "page": 1,
  "perPage": 50,
  "total": 1,
  "pages": 1
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/users"
~~~

### <a id="get-users-userId"></a>`GET /api/v1/users/{userId}`

User details — The account with how many organizations it owns and belongs to, and the label of its limits.

**Who:** instance administrators · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `userId` | path | string | yes | The user's id (from `GET /users` or `GET /me`). |

Response `200`:

~~~json
{
  "id": "u_7f…",
  "name": "Jo Doe",
  "email": "jo@example.com",
  "role": "user",
  "emailVerified": true,
  "twoFactorEnabled": false,
  "banned": false,
  "createdAt": "2026-08-30T08:00:00.000Z",
  "organizations": {
    "owned": 1,
    "memberships": 3
  },
  "accessTokens": 2,
  "label": "Pro"
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/users/{userId}"
~~~

### <a id="get-users-userId-organizations"></a>`GET /api/v1/users/{userId}/organizations`

A user's organizations — Every organization the account belongs to, with its role there and the organization's size and limits label.

**Who:** instance administrators · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `userId` | path | string | yes | The user's id (from `GET /users` or `GET /me`). |

Response `200`:

~~~json
{
  "user": "u_7f…",
  "items": [
    {
      "id": "9a1c…",
      "slug": "acme",
      "name": "Acme",
      "role": "owner",
      "memberCount": 4,
      "repositoryCount": 12,
      "storageBytes": 12884901888,
      "label": "Team"
    }
  ],
  "total": 1
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/users/{userId}/organizations"
~~~

### <a id="get-users-userId-usage"></a>`GET /api/v1/users/{userId}/usage`

A user's usage against their limits — Like `GET /me/usage`, for any account.

**Who:** instance administrators · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `userId` | path | string | yes | The user's id (from `GET /users` or `GET /me`). |
| `month` | query | string |  | Calendar month of the traffic figures, `YYYY-MM` in UTC (default: the current month). |

Response `200`:

~~~json
{
  "user": "u_7f…",
  "usage": {
    "organizations": 2,
    "publicRepositories": 3,
    "privateRepositories": 12,
    "storageBytes": 21474836480,
    "members": 6
  },
  "limits": {
    "maxOrganizations": null,
    "maxPublicRepositories": null,
    "maxPrivateRepositories": null,
    "maxStorageBytes": 107374182400
  },
  "percent": {
    "organizations": null,
    "publicRepositories": null,
    "privateRepositories": null,
    "storage": 20
  },
  "label": "Pro",
  "traffic": {
    "month": "2026-09",
    "from": "2026-09-01",
    "to": "2026-10-01",
    "pullBytes": 734003200,
    "redirectBytes": 4194304000,
    "pushBytes": 268435456,
    "blobPulls": 812,
    "manifestPulls": 1290
  }
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/users/{userId}/usage"
~~~

### <a id="get-users-userId-limits"></a>`GET /api/v1/users/{userId}/limits`

Account limits — The account's limits row: caps on what the user owns, summed across their organizations that have no limit of their own. `configured` is false when there is no row (unlimited).

**Who:** instance administrators · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `userId` | path | string | yes | The user's id (from `GET /users` or `GET /me`). |

Response `200`:

~~~json
{
  "user": "u_7f…",
  "configured": true,
  "limits": {
    "maxOrganizations": null,
    "maxPublicRepositories": null,
    "maxPrivateRepositories": null,
    "maxStorageBytes": 107374182400
  },
  "label": "Pro",
  "note": "",
  "updatedAt": "2026-09-05T09:00:00.000Z",
  "updatedBy": "u_admin…"
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/users/{userId}/limits"
~~~

### <a id="patch-users-userId-limits"></a>`PATCH /api/v1/users/{userId}/limits`

Change account limits — Send only the fields to change; null lifts a limit. Creates the row when there is none. The same rules registryd enforces at push time apply from the next request.

**Who:** instance administrators · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `userId` | path | string | yes | The user's id (from `GET /users` or `GET /me`). |
| `maxOrganizations` | body | integer \| null |  | Organizations the user may own; null lifts the limit. |
| `maxPublicRepositories` | body | integer \| null |  | null lifts the limit. |
| `maxPrivateRepositories` | body | integer \| null |  | null lifts the limit. |
| `maxStorageBytes` | body | integer \| null |  | Deduplicated bytes; null lifts the limit. |
| `label` | body | string |  | Shown to the owner next to their usage while an account portal is configured (a plan name, say); at most 80 characters, empty hides it. |
| `note` | body | string |  | For administrators only. |

Response `200`:

~~~json
{
  "user": "u_7f…",
  "configured": true,
  "limits": {
    "maxOrganizations": null,
    "maxPublicRepositories": null,
    "maxPrivateRepositories": null,
    "maxStorageBytes": 107374182400
  },
  "label": "Pro",
  "note": "",
  "updatedAt": "2026-09-05T09:00:00.000Z",
  "updatedBy": "u_admin…"
}
~~~

~~~sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"maxOrganizations":"…","maxPublicRepositories":"…","maxPrivateRepositories":"…","maxStorageBytes":"…","label":"…","note":"…"}' \
  "https://registry.example.com/api/v1/users/{userId}/limits"
~~~

### <a id="delete-users-userId-limits"></a>`DELETE /api/v1/users/{userId}/limits`

Remove account limits — Drops the row: the account is unlimited again. `removed` is false when there was none.

**Who:** instance administrators · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `userId` | path | string | yes | The user's id (from `GET /users` or `GET /me`). |

Response `200`:

~~~json
{
  "user": "u_7f…",
  "removed": true
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/users/{userId}/limits"
~~~

### <a id="get-orgs-org-limits"></a>`GET /api/v1/orgs/{org}/limits`

Organization limits — The organization's limits row. A limit set here governs the organization; the owners' account limits apply only to kinds it leaves unlimited. `configured` is false when there is no row.

**Who:** instance administrators · **Service accounts:** no · **Write:** no · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "organization": "acme",
  "configured": true,
  "limits": {
    "maxPublicRepositories": null,
    "maxPrivateRepositories": 20,
    "maxStorageBytes": 53687091200,
    "maxMembers": 5
  },
  "label": "Team",
  "note": "5 seats since 2026-09",
  "updatedAt": "2026-09-05T09:00:00.000Z",
  "updatedBy": "u_admin…"
}
~~~

~~~sh
curl -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/limits"
~~~

### <a id="patch-orgs-org-limits"></a>`PATCH /api/v1/orgs/{org}/limits`

Change organization limits — Send only the fields to change; null lifts a limit. Creates the row when there is none. `maxMembers` counts every role; an open invitation holds a seat until it is accepted or cancelled.

**Who:** instance administrators · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |
| `maxPublicRepositories` | body | integer \| null |  | null lifts the limit. |
| `maxPrivateRepositories` | body | integer \| null |  | null lifts the limit. |
| `maxStorageBytes` | body | integer \| null |  | Deduplicated bytes; null lifts the limit. |
| `label` | body | string |  | Shown to the owner next to their usage while an account portal is configured (a plan name, say); at most 80 characters, empty hides it. |
| `note` | body | string |  | For administrators only. |
| `maxMembers` | body | integer \| null |  | At least 1; null lifts the limit. |

Response `200`:

~~~json
{
  "organization": "acme",
  "configured": true,
  "limits": {
    "maxPublicRepositories": null,
    "maxPrivateRepositories": 20,
    "maxStorageBytes": 53687091200,
    "maxMembers": 5
  },
  "label": "Team",
  "note": "5 seats since 2026-09",
  "updatedAt": "2026-09-05T09:00:00.000Z",
  "updatedBy": "u_admin…"
}
~~~

~~~sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"maxPublicRepositories":"…","maxPrivateRepositories":"…","maxStorageBytes":"…","label":"…","note":"…","maxMembers":"…"}' \
  "https://registry.example.com/api/v1/orgs/acme/limits"
~~~

### <a id="delete-orgs-org-limits"></a>`DELETE /api/v1/orgs/{org}/limits`

Remove organization limits — Drops the row; only the owners' account limits remain. `removed` is false when there was none.

**Who:** instance administrators · **Service accounts:** no · **Write:** needs a read & write token · **Since:** 2026-09-05.4

| Name | In | Type | Required | Description |
| --- | --- | --- | --- | --- |
| `org` | path | string | yes | Organization slug. Top-level images live in `library`. |

Response `200`:

~~~json
{
  "organization": "acme",
  "removed": true
}
~~~

~~~sh
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://registry.example.com/api/v1/orgs/acme/limits"
~~~

## Changelog

This API follows the registry's features: whenever a feature is added, changed or removed, the endpoints that expose it and this documentation change with it in the same release. The revision moves every time — compare it with the changelog before relying on a new field, and read the changelog before upgrading.

### 2026-09-06.6

- Scan workers: Administration → Scanning → "Offload scans to workers" (SCAN_WORKERS, SCAN_WORKER_TOKEN) hands Trivy scans to external workers over the internal worker protocol (`POST /api/internal/worker/claim`, `/heartbeat`, `/tasks/<id>/result`, `/tasks/<id>/fail`, bearer token; not part of /api/v1). The worker is a separate program (chicoree-scan-worker); the protocol is documented in the README. Without a worker online, scans run inline as before. No /api/v1 change.
- TRIVY_SERVER_TOKEN (environment only) authenticates the web container and the bundled `trivy` server profile to a Trivy server started with `--token`, so one vulnerability database can serve every replica and every scan worker.

### 2026-09-06.5

- The Attestations tab shows the cosign/oras sign-and-attach commands only to viewers who may push to the repository (owner, admin or member of a non-proxy organization, instance administrators); everyone else sees a plain note. No API change.

### 2026-09-06.4

- The library organization is virtual in the UI: no list, search result, dashboard entry, notification, audit label or job result shows a `library/` prefix, and `/<name>` opens the top-level repository. Storage and the `/orgs/library/…` routes are unchanged; `path` and `reference` fields already omitted the prefix.
- Explore opens with an overview — trending repositories (pulls in the last 7 days), organizations busiest first with drill-down, recently updated — and `?view=all` is the filterable list. No API change.
- Anonymous calls to the header search typeahead (`/api/search`) count against the anonymous API rate limit per address (`RATE_LIMIT_API_ANONYMOUS`).

### 2026-09-06.3

- Editions: Administration → Branding (INSTANCE_EDITION as default) switches the landing page between self-hosted wording and a hosted service — sign-up as the call to action, the free plan named from the default limits, a link to the account portal's plans. No API change.
- Browsing without an account: Explore, search, organization pages and public repositories open for visitors without a session, in a reduced shell with sign-in and sign-up; pages that need a user still redirect to sign-in. No API change.

### 2026-09-06.2

- Storage enforcement: the quota-enforce job (Administration → Jobs, POST /api/jobs/quota-enforce) notifies organizations and accounts above their storage limit and, after graceDays, removes the oldest images until the limit is met, protected tags excepted, then runs garbage collection. New notification and organization webhook events quota.exceeded and quota.pruned.

### 2026-09-06.1

- Changed: the plan card on Settings and Organization → Settings appears only while an account portal is configured; a self-hosted registry with plain limits shows users nothing about them. The label on limits rows is documented accordingly.

### 2026-09-05.5

- Changed: an organization's own limit governs it alone. When an organization has a storage or repository limit of its own, the owners' account limits are not consulted for it and its usage does not count against their accounts; account limits cover the owner's organizations without such a limit. GET /me/usage and GET /users/{userId}/usage report that pool. Enforced the same way by registryd at push time.
- OpenAPI: `integer | null` body fields are typed as nullable integers, and enums with null carry a JSON null instead of the string "null".

### 2026-09-05.4

- Member limit: organizations can be capped at a number of members (Administration → Organizations → Limits, maxMembers); an open invitation holds a seat. Enforced when inviting, accepting an invitation, adding a member and on group-binding logins. GET /orgs/{org}/usage reports members and maxMembers.
- Usage: GET /orgs/{org}/usage and the new GET /me/usage carry the month's traffic (pullBytes, redirectBytes, pushBytes, blobPulls, manifestPulls; ?month=YYYY-MM) and the label administrators gave the limits.
- Administration: GET /users (exact email or search), GET /users/{userId}, GET /users/{userId}/organizations, GET /users/{userId}/usage; GET/PATCH/DELETE /orgs/{org}/limits and /users/{userId}/limits read, change and drop limits rows, including a label shown to the owner and an administrators-only note.
- Default limits: Administration → Limits gives every new account and organization a limits row (DEFAULT_USER_MAX_ORGANIZATIONS, DEFAULT_USER_MAX_PUBLIC_REPOS, DEFAULT_USER_MAX_PRIVATE_REPOS, DEFAULT_USER_MAX_STORAGE_GIB, DEFAULT_ORG_MAX_PUBLIC_REPOS, DEFAULT_ORG_MAX_PRIVATE_REPOS, DEFAULT_ORG_MAX_STORAGE_GIB, DEFAULT_ORG_MAX_MEMBERS as defaults).
- Account portal: Administration → Limits (PORTAL_URL, PORTAL_LABEL as defaults) adds a Manage button to the account and organization settings that opens the portal with a one-time token; the portal verifies it with POST /api/auth/one-time-token/verify.

### 2026-09-05.3

- Retag: PUT /repos/{org}/{repo}/tags/{tag} points a tag at an image already in the repository.
- Promote: POST …/tags/{tag}/copy and POST …/manifests/{digest}/copy copy an image (with variants and attached artifacts) into another repository, creating it when missing.
- Scan gate: GET …/manifests/{digest}/scan waits for a running scan and judges it against a threshold (wait, fail_on, unrated); POST …/scan accepts the same parameters to queue and wait in one call.
- A composite GitHub Action, .github/actions/scan-gate, fails a job on the gate's verdict.
- Organizations: create, rename and delete; usage against limits; policies (default visibility, pull policy, signature policy, member keys) to read and change.
- Service accounts: list, create (secret returned once), details, delete and rotate.
- Members and invitations: change roles, remove members, list, create and cancel invitations.
- Webhooks: list, create, read, update, delete and test, for organizations and repositories.
- Repository policies: read the effective pull and signature policy, change the overrides.
- Exports: GET …/vulnerabilities?format=sarif (SARIF 2.1.0) and ?format=vex (CycloneDX 1.5 VEX) for security dashboards and GitHub code scanning.
- Conditional requests: GET answers carry a weak ETag and honour If-None-Match with 304.
- The OpenAPI document is validated by npm run lint, and administrators see a notice on the overview when the API revision changed since they last acknowledged it.
- Rate limits: requests are counted per credential (per address anonymously) in windows set under Administration → Rate limits (RATE_LIMIT_API_AUTHENTICATED, RATE_LIMIT_API_ANONYMOUS); over the limit the API answers 429 with the new code rate_limited and Retry-After, and every answer carries X-RateLimit-Limit / -Remaining / -Reset.
- Metrics: chicoree_api_requests_total{endpoint,method,status,credential} on the Prometheus endpoint.
- Deprecation policy: endpoints that are going away carry Deprecation, Sunset and Link headers and are marked in the docs for at least one revision before removal.
- Keyless CI authentication: POST /auth/exchange trades a workflow's OIDC token (GitHub Actions, GitLab, any trusted issuer) for a short-lived chc_ci_ credential that works for the API and docker login; organizations manage the trusted identities under /orgs/{org}/ci-identities and in Organization → Service accounts. A login GitHub Action (.github/actions/login) wraps the exchange.

### 2026-09-05.2

- Administrators can switch the API off (Administration → Auth providers → Access, default from API_ENABLED); every endpoint then answers 403 with the new error code api_disabled.

### 2026-09-05.1

- Initial release of the REST API under /api/v1.
- Organizations: list, details, repositories, members and the audit log.
- Repositories: create, read, update and delete; tags; untagged manifests; stars.
- Images: manifest details with config, layers and variants; delete by tag or digest; vulnerabilities; signatures, SBOMs and provenance; queue a scan.
- Search across repositories, tags, digests and organizations.
- Personal access tokens, service accounts and the browser session authenticate; read-only tokens are refused on writes.
