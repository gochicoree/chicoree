// The API documentation as Markdown, rendered from the catalog and the
// version line. One source, two outputs: /docs/api in the app (with the
// instance's own addresses) and API.md at the repository root (with
// placeholder addresses, written by `npm run api:docs`). Pure: no database,
// no Node imports, so the generator script can import it directly.
import { ACCESS_LABELS, API_CATALOG, API_GROUPS, type ApiEndpoint, type ApiParam } from "./catalog";
import { API_BASE, API_CHANGELOG, API_NOTICE, API_REVISION, API_VERSION } from "./version";

export interface DocsOptions {
  /** Where the web app is reached, e.g. https://registry.example.com (no trailing slash). */
  appUrl: string;
  /** What users type after `docker login`. */
  registryHost: string;
  /** Instance name for the title; "Chicorée" when unset. */
  instanceName?: string;
  /** In the app the page links to itself; the repository file links to the app path. */
  inApp?: boolean;
  /** Include the endpoint overview and reference (default true; the in-app guide leaves them to the browser). */
  endpoints?: boolean;
}

const ERROR_CODES: [string, number, string][] = [
  ["bad_request", 400, "A parameter is malformed (a bad digest, an unknown severity, invalid JSON)."],
  ["unauthorized", 401, "No usable credential: missing, unknown, expired or a banned account."],
  ["forbidden", 403, "The credential is valid but may not do this (role, read-only token, restriction, service account)."],
  ["not_found", 404, "The organization, repository, tag or image does not exist — or is not visible to the caller."],
  ["conflict", 409, "The registry's state refuses the change: a name is taken, a tag is protected, an index member cannot go alone, a scan is already running."],
  ["unprocessable", 422, "The body is well-formed but a value is not acceptable (name rules, quotas, missing fields)."],
  ["rate_limited", 429, "Too many requests in the current window; `Retry-After` says when to try again."],
  ["api_disabled", 403, "An administrator switched the API off (*Administration → Auth providers → Access*, or `API_ENABLED=false`); every endpoint answers this until it is on again."],
  ["internal", 500, "Something failed on the server; the details are in the web app's log."],
];

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  return [line(header), `| ${header.map(() => "---").join(" | ")} |`, ...rows.map(line)].join("\n");
}

function anchor(e: ApiEndpoint): string {
  return `${e.method.toLowerCase()}-${e.path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "index"}`;
}

function fullPath(e: ApiEndpoint): string {
  return `${API_BASE}${e.path === "/" ? "" : e.path}`;
}

function paramRows(params: ApiParam[]): string {
  return table(
    ["Name", "In", "Type", "Required", "Description"],
    params.map((p) => [`\`${p.name}\``, p.in, p.type, p.required ? "yes" : "", p.description]),
  );
}

function jsonBlock(value: unknown): string {
  return "~~~json\n" + JSON.stringify(value, null, 2) + "\n~~~";
}

function endpointSection(e: ApiEndpoint, o: DocsOptions): string {
  const facts = [
    e.deprecated ? `**Deprecated since ${e.deprecated.since}${e.deprecated.sunset ? `, sunset ${e.deprecated.sunset}` : ""}**${e.deprecated.replacement ? ` — use ${e.deprecated.replacement}` : ""}${e.deprecated.note ? ` — ${e.deprecated.note}` : ""}` : "",
    `**Who:** ${ACCESS_LABELS[e.access]}`,
    `**Service accounts:** ${e.serviceAccounts ? "yes" : "no"}`,
    e.write ? "**Write:** needs a read & write token" : "**Write:** no",
    e.paginated ? "**Paginated**" : "",
    `**Since:** ${e.since}`,
  ].filter(Boolean);
  const parts = [
    `### <a id="${anchor(e)}"></a>\`${e.method} ${fullPath(e)}\``,
    "",
    e.summary + (e.description ? ` — ${e.description}` : "."),
    "",
    facts.join(" · "),
  ];
  if (e.params?.length) parts.push("", paramRows(e.params));
  if (e.example !== undefined) {
    parts.push("", `Response \`${e.status ?? 200}\`:`, "", jsonBlock(e.example));
  }
  parts.push("", `~~~sh\n${curlFor(e, o)}\n~~~`);
  return parts.join("\n");
}

/** A curl line for the endpoint with example values filled in. */
function curlFor(e: ApiEndpoint, o: DocsOptions): string {
  const path = fullPath(e)
    .replace("{org}", "acme")
    .replace("{repo}", "api")
    .replace("{tag}", "1.4.0")
    .replace("{digest}", "sha256:5f2b…");
  const auth = e.access === "public" ? "" : ' -H "Authorization: Bearer $TOKEN"';
  const method = e.method === "GET" ? "" : ` -X ${e.method}`;
  const body = e.params?.filter((p) => p.in === "body");
  const data =
    body && body.length
      ? ` \\\n  -H "Content-Type: application/json" -d '${JSON.stringify(Object.fromEntries(body.map((p) => [p.name, exampleValue(p)])))}'`
      : "";
  const query = e.path === "/search" ? "?q=api" : "";
  return `curl${method}${auth}${data} \\\n  "${o.appUrl}${path}${query}"`;
}

function exampleValue(p: ApiParam): unknown {
  if (p.name === "name") return "api";
  if (p.name === "description") return "The public API server";
  if (p.name === "visibility") return "private";
  if (p.type === "boolean") return true;
  if (p.type === "integer") return 1;
  return "…";
}

/** The complete document. */
export function apiDocsMarkdown(o: DocsOptions): string {
  const name = o.instanceName || "Chicorée";
  const docsPath = "/docs/api";
  const groups = API_GROUPS.filter((g) => API_CATALOG.some((e) => e.group === g));

  const overview = groups
    .map((g) => {
      const rows = API_CATALOG.filter((e) => e.group === g).map((e) => [
        `[\`${e.method} ${fullPath(e)}\`](#${anchor(e)})`,
        e.summary,
        ACCESS_LABELS[e.access].split(" (")[0],
      ]);
      return `**${g}**\n\n${table(["Endpoint", "What it does", "Who"], rows)}`;
    })
    .join("\n\n");

  const reference = groups.map((g) => [`## ${g}`, "", ...API_CATALOG.filter((e) => e.group === g).map((e) => endpointSection(e, o))].join("\n\n")).join("\n\n");

  const changelog = API_CHANGELOG.map((c) => [`### ${c.revision}`, "", ...c.changes.map((ch) => `- ${ch}`)].join("\n")).join("\n\n");

  return `# ${name} REST API

> **${API_NOTICE}**
>
> Current revision: \`${API_REVISION}\` · [Changelog](#changelog) · index: \`GET ${o.appUrl}${API_BASE}\`${o.inApp ? "" : ` · in the app: \`${docsPath}\``}

Everything the web app can do with organizations, repositories, tags and images is available as JSON under \`${API_BASE}\`. The same personal access tokens that authenticate \`docker login\` authenticate the API, with the same roles and restrictions, so a token that can push an image can read its scan result, and one limited to a repository sees nothing else.

## Authentication

Send the credential in the \`Authorization\` header:

~~~sh
export TOKEN=chc_pat_…
curl -H "Authorization: Bearer $TOKEN" ${o.appUrl}${API_BASE}/me
# Basic auth works too — the token is the password, the user name is ignored:
curl -u "me:$TOKEN" ${o.appUrl}${API_BASE}/me
~~~

| Credential | Where it comes from | What it can do |
| --- | --- | --- |
| Personal access token \`chc_pat_…\` | *Settings → Access tokens* | Acts as its user. A **read-only** token can only read; a **read & write** token can also change things. A token **limited to an organization** or to a **repository list** sees and changes nothing outside it, and cannot search or create repositories. |
| Service account \`chc_sa_…\` | *Organization → Service accounts* | Reads its organization's repositories (or its repository list) plus public ones. With the \`admin\` permission it can delete tags and images there. It cannot manage repositories, star, or read members and the audit log. |
| CI credential \`chc_ci_…\` | \`POST /api/v1/auth/exchange\` with the workflow's OIDC token | The same rights as a service account with the trusted identity's permission and repository list, for the lifetime of the job (at most an hour). |
| Browser session | Being signed in | The same rights as in the web app — handy for trying calls in the browser. |
| None | — | Public repositories, tags, images and scan results. |

Expired tokens, banned accounts and unknown secrets answer \`401\`; a valid credential without the right answers \`403\` with the reason. Every use of a token updates its *last used* time and address (*Settings → Access tokens*).

### Keyless CI authentication

A CI job does not need a stored secret. An organization trusts the workflow's identity once (*Organization → Service accounts → CI identities*, or the \`/orgs/{org}/ci-identities\` endpoints): the issuer of its OIDC tokens and the subject they carry, exact or with \`*\` wildcards, plus a permission and an optional repository list. The job then exchanges the token it gets from its CI system for a registry credential:

~~~sh
# GitHub Actions (permissions: id-token: write); the audience is this registry's URL
OIDC=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \\
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=${o.appUrl}" | jq -r .value)
curl -sS -H "Content-Type: application/json" -d "{\"token\": \"$OIDC\"}" ${o.appUrl}${API_BASE}/auth/exchange
# → { "token": "chc_ci_…", "expiresAt": "…", "dockerLogin": { "registry": "${o.registryHost}", "username": "ci", "password": "chc_ci_…" } }
~~~

The exchange verifies the token against the issuer's published keys (only issuers some organization trusts are contacted), checks that the audience is \`${o.appUrl}\` or \`${o.registryHost}\`, and matches the subject; GitHub subjects look like \`repo:owner/repo:ref:refs/heads/main\` (the token itself carries ids, \`repo:owner@123/repo@456:ref:…\`; both spellings match), GitLab's like \`project_path:group/project:ref_type:branch:ref:main\`. The credential is a signed token with no stored state: deleting the identity revokes it at once. The \`.github/actions/login\` action in the repository does all of this and runs \`docker login\`; \`.github/actions/build-push\` (build, push with SBOM and provenance, sign, attest) and the reusable \`release-images.yml\` workflow build on it — see the README's GitHub Actions section.

Administrators can switch the whole API off (*Administration → Auth providers → Access*, default from \`API_ENABLED\`): every endpoint, the index and the OpenAPI document then answer \`403\` with code \`api_disabled\`. docker login and the jobs API are not affected.

## Conventions

- Responses are JSON (\`application/json\`, UTF-8). Timestamps are ISO 8601 in UTC (\`2026-09-05T08:41:12.000Z\`), sizes are bytes, digests are \`sha256:<64 hex>\`. Absent values are \`null\`, not omitted.
- Requests with a body send JSON with \`Content-Type: application/json\`.
- **Paging.** Lists take \`page\` (from 1) and \`per_page\` (1–100, default 50) and answer \`{ "items": [...], "page": 1, "perPage": 50, "total": 123, "pages": 3 }\`. A page past the end returns the last page.
- **Booleans** in the query string are \`true\`/\`1\`/\`yes\` (anything else is false).
- **Repository names** of proxy caches can be nested (\`bitnami/redis\`); in a path they are one segment with the slash percent-encoded: \`/repos/dockerhub/bitnami%2Fredis\`. Top-level images (\`${o.registryHost}/nginx\`) live in the \`library\` organization.
- Renamed or transferred repositories are **not** redirected by the API; use the new name (\`docker pull\` and the web pages do redirect).
- Every response carries \`X-Api-Version: ${API_VERSION}\` and \`X-Api-Revision: ${API_REVISION}\`, and \`Cache-Control: private, no-store\`.
- Changes made through the API are audited like changes made in the app, with \`"via": "api"\` in the entry's details.
- Unknown paths under \`${API_BASE}\` answer a JSON \`404\`; an unsupported method answers \`405\`.
- **Conditional requests.** Every successful GET carries a weak \`ETag\`; send it back as \`If-None-Match\` and an unchanged answer comes back as \`304\` without a body (the rate-limit and deprecation headers still apply).
- **Exports.** \`GET …/manifests/{digest}/vulnerabilities?format=sarif\` is the image's scan as SARIF 2.1.0 for GitHub code scanning and security dashboards (accepted risks become suppressions); \`?format=vex\` is a CycloneDX 1.5 VEX document in which accepted risks are \`not_affected\` with their justification and everything else is \`in_triage\`.
- **Rate limits.** Requests are counted per credential (per address without one) in fixed windows set by the administrators (*Administration → Rate limits*, defaults \`RATE_LIMIT_API_AUTHENTICATED=1200/1m\` and \`RATE_LIMIT_API_ANONYMOUS=120/1m\`; instance administrators are exempt). Every answer carries \`X-RateLimit-Limit\`, \`X-RateLimit-Remaining\` and \`X-RateLimit-Reset\` (epoch seconds); over the limit the API answers \`429 rate_limited\` with \`Retry-After\`.
- **Deprecations.** An endpoint that is going away is announced first: its responses carry a \`Deprecation\` header (and \`Sunset\` once a date is set) with a \`Link\` to this documentation, the reference marks it, and it stays for at least one more revision. Watch the changelog for \`Removed:\` lines.

## Errors

~~~json
{ "error": "This access token is read-only; delete tags here needs a read & write token.", "code": "forbidden" }
~~~

${table(["Code", "Status", "When"], ERROR_CODES.map(([code, status, when]) => [`\`${code}\``, String(status), when]))}

Some errors add a \`details\` object (the offending \`field\`, or \`queued: false\` when a scan was not started).

## Tools

- **API browser.** ${o.inApp ? "The *Browse & try* tab above" : `\`${docsPath}\` in the app`} lists every endpoint with its parameters, sends real requests with your browser session or a token you paste, and shows the curl line for the same call.
- **OpenAPI.** \`GET ${o.appUrl}${API_BASE}/openapi.json\` is an OpenAPI 3.1 document for Swagger UI, Postman, Insomnia or client generators (response schemas are inferred from the examples below).
${o.inApp ? "" : "- **This file** (`API.md`) is generated from the catalog by `npm run api:docs` in `web/`; `npm run lint` fails when it is stale."}
${o.endpoints === false ? "" : `
## Endpoints

${overview}

${reference}
`}
## Changelog

${API_NOTICE}

${changelog}
`;
}
