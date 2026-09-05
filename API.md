# Chicorée REST API

> **This API follows the registry's features: whenever a feature is added, changed or removed, the endpoints that expose it and this documentation change with it in the same release. The revision moves every time — compare it with the changelog before relying on a new field, and read the changelog before upgrading.**
>
> Current revision: `2026-09-05.3` · [Changelog](#changelog) · index: `GET https://registry.example.com/api/v1` · in the app: `/docs/api`

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
| Browser session | Being signed in | The same rights as in the web app — handy for trying calls in the browser. |
| None | — | Public repositories, tags, images and scan results. |

Expired tokens, banned accounts and unknown secrets answer `401`; a valid credential without the right answers `403` with the reason. Every use of a token updates its *last used* time and address (*Settings → Access tokens*).

Administrators can switch the whole API off (*Administration → Auth providers → Access*, default from `API_ENABLED`): every endpoint, the index and the OpenAPI document then answer `403` with code `api_disabled`. docker login and the jobs API are not affected.

## Conventions

- Responses are JSON (`application/json`, UTF-8). Timestamps are ISO 8601 in UTC (`2026-09-05T08:41:12.000Z`), sizes are bytes, digests are `sha256:<64 hex>`. Absent values are `null`, not omitted.
- Requests with a body send JSON with `Content-Type: application/json`.
- **Paging.** Lists take `page` (from 1) and `per_page` (1–100, default 50) and answer `{ "items": [...], "page": 1, "perPage": 50, "total": 123, "pages": 3 }`. A page past the end returns the last page.
- **Booleans** in the query string are `true`/`1`/`yes` (anything else is false).
- **Repository names** of proxy caches can be nested (`bitnami/redis`); in a path they are one segment with the slash percent-encoded: `/repos/dockerhub/bitnami%2Fredis`. Top-level images (`registry.example.com/nginx`) live in the `library` organization.
- Renamed or transferred repositories are **not** redirected by the API; use the new name (`docker pull` and the web pages do redirect).
- Every response carries `X-Api-Version: 1` and `X-Api-Revision: 2026-09-05.3`, and `Cache-Control: private, no-store`.
- Changes made through the API are audited like changes made in the app, with `"via": "api"` in the entry's details.
- Unknown paths under `/api/v1` answer a JSON `404`; an unsupported method answers `405`.

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

**Repositories**

| Endpoint | What it does | Who |
| --- | --- | --- |
| [`GET /api/v1/repos/{org}/{repo}`](#get-repos-org-repo) | Repository details | anyone |
| [`PATCH /api/v1/repos/{org}/{repo}`](#patch-repos-org-repo) | Update a repository | organization owners and admins |
| [`DELETE /api/v1/repos/{org}/{repo}`](#delete-repos-org-repo) | Delete a repository | organization owners and admins |
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

## Changelog

This API follows the registry's features: whenever a feature is added, changed or removed, the endpoints that expose it and this documentation change with it in the same release. The revision moves every time — compare it with the changelog before relying on a new field, and read the changelog before upgrading.

### 2026-09-05.3

- Retag: PUT /repos/{org}/{repo}/tags/{tag} points a tag at an image already in the repository.
- Promote: POST …/tags/{tag}/copy and POST …/manifests/{digest}/copy copy an image (with variants and attached artifacts) into another repository, creating it when missing.
- Scan gate: GET …/manifests/{digest}/scan waits for a running scan and judges it against a threshold (wait, fail_on, unrated); POST …/scan accepts the same parameters to queue and wait in one call.
- A composite GitHub Action, .github/actions/scan-gate, fails a job on the gate's verdict.

### 2026-09-05.2

- Administrators can switch the API off (Administration → Auth providers → Access, default from API_ENABLED); every endpoint then answers 403 with the new error code api_disabled.

### 2026-09-05.1

- Initial release of the REST API under /api/v1.
- Organizations: list, details, repositories, members and the audit log.
- Repositories: create, read, update and delete; tags; untagged manifests; stars.
- Images: manifest details with config, layers and variants; delete by tag or digest; vulnerabilities; signatures, SBOMs and provenance; queue a scan.
- Search across repositories, tags, digests and organizations.
- Personal access tokens, service accounts and the browser session authenticate; read-only tokens are refused on writes.
