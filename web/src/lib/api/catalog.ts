// The endpoint catalog: one entry per route handler under app/api/v1. It is
// the single description of the API — GET /api/v1 serves it as JSON, the
// documentation (lib/api/docs.ts → /docs/api and API.md) is rendered from
// it, and `npm run api:docs -- --check` fails when a route exists without an
// entry or the other way round. Pure data: no database, no Node imports.

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Who may call the endpoint. Roles are the organization roles (lib/org-roles.ts);
 * instance administrators always pass.
 */
export type ApiAccess =
  /** Anyone, including anonymous callers (they see public repositories only). */
  | "public"
  /** Any authenticated caller (a token, a service account or a session). */
  | "authenticated"
  /** A signed-in user (not a service account). */
  | "user"
  /** Any member of the organization (viewer and up). */
  | "member"
  /** Owner, admin or member of the organization. */
  | "writer"
  /** Owner or admin of the organization. */
  | "manager"
  /** Instance administrator. */
  | "admin";

export interface ApiParam {
  name: string;
  in: "path" | "query" | "body";
  type: string;
  required?: boolean;
  description: string;
}

export interface ApiEndpoint {
  method: ApiMethod;
  /** Relative to /api/v1; `{name}` marks a path parameter. */
  path: string;
  group: ApiGroup;
  summary: string;
  description?: string;
  access: ApiAccess;
  /** A write: read-only tokens are refused. */
  write?: boolean;
  /** Service accounts may call it (within their organization and repository list). */
  serviceAccounts?: boolean;
  params?: ApiParam[];
  /** Lists come back as { items, page, perPage, total, pages }. */
  paginated?: boolean;
  /** Status code of the success response when it is not 200. */
  status?: number;
  /** Example success response body. */
  example?: unknown;
  /** Revision the endpoint appeared in (lib/api/version.ts). */
  since: string;
  /**
   * Announced removal. Responses carry Deprecation (and Sunset) headers, the
   * docs show a warning, and the endpoint stays for at least one revision
   * after `since` before it may go (see CLAUDE.md).
   */
  deprecated?: {
    /** Revision the deprecation was announced in. */
    since: string;
    /** Date after which the endpoint may disappear (YYYY-MM-DD), when decided. */
    sunset?: string;
    /** What to use instead, as a path or a sentence. */
    replacement?: string;
    note?: string;
  };
}

export type ApiGroup = "General" | "Organizations" | "Repositories" | "Tags" | "Images" | "Security" | "Search" | "Account";

export const API_GROUPS: ApiGroup[] = ["General", "Organizations", "Repositories", "Tags", "Images", "Security", "Search", "Account"];

const PAGE_PARAMS: ApiParam[] = [
  { name: "page", in: "query", type: "integer", description: "Page number, from 1." },
  { name: "per_page", in: "query", type: "integer", description: "Rows per page, 1–100 (default 50)." },
];

const ORG_PARAM: ApiParam = { name: "org", in: "path", type: "string", required: true, description: "Organization slug. Top-level images live in `library`." };
const REPO_PARAM: ApiParam = {
  name: "repo",
  in: "path",
  type: "string",
  required: true,
  description: "Repository name. Nested names of proxy caches (`bitnami/redis`) are one segment with the slash encoded as `%2F`.",
};
const DIGEST_PARAM: ApiParam = { name: "digest", in: "path", type: "string", required: true, description: "Manifest digest, `sha256:<64 hex>`." };
const INCLUDE_ARTIFACTS: ApiParam = {
  name: "include_artifacts",
  in: "query",
  type: "boolean",
  description: "Also list cosign signature / attestation / SBOM tags (`sha256-….sig`) and index members. Default false.",
};

const ORG_EXAMPLE = {
  id: "9a1c…",
  slug: "acme",
  name: "Acme",
  role: "admin",
  repositoryCount: 12,
  proxy: false,
  createdAt: "2026-09-01T10:12:00.000Z",
  url: "https://registry.example.com/acme",
};

const REPO_EXAMPLE = {
  id: "d2f4…",
  organization: "acme",
  name: "api",
  path: "acme/api",
  reference: "registry.example.com/acme/api",
  description: "The public API server",
  visibility: "private",
  pullCount: 4213,
  starCount: 3,
  tagCount: 18,
  sizeBytes: 734003200,
  lastPushedAt: "2026-09-05T08:41:12.000Z",
  updatedAt: "2026-09-05T08:41:12.000Z",
  proxy: false,
  lastCheckedAt: null,
  url: "https://registry.example.com/acme/api",
};

const SCAN_EXAMPLE = {
  status: "scanned",
  scanner: "trivy",
  scannerVersion: "0.74.0",
  updatedAt: "2026-09-05T08:43:02.000Z",
  summary: { Critical: 0, High: 2, Medium: 7, Low: 11, Negligible: 0, Unknown: 1 },
  effectiveSummary: { Critical: 0, High: 1, Medium: 7, Low: 11, Negligible: 0, Unknown: 1 },
  error: null,
};

const TAG_EXAMPLE = {
  name: "1.4.0",
  digest: "sha256:5f2b…",
  mediaType: "application/vnd.oci.image.index.v1+json",
  isIndex: true,
  sizeBytes: 48211234,
  layerCount: null,
  pushedAt: "2026-09-05T08:41:12.000Z",
  signed: true,
  blocked: null,
  scan: { status: "scanned", summary: { High: 2, Medium: 7, Low: 11, Unknown: 1 } },
  proxyCheckedAt: null,
  url: "https://registry.example.com/acme/api/tags/1.4.0",
};

const WEBHOOK_EXAMPLE = {
  id: "wh_9c…",
  name: "deploy",
  url: "https://ci.example.com/hooks/registry",
  method: "POST",
  format: "json",
  headers: {},
  authType: "bearer",
  authHeaderName: null,
  hasAuthSecret: true,
  hasSigningSecret: true,
  events: ["push", "scan.completed"],
  enabled: true,
  lastStatus: 200,
  lastDeliveredAt: "2026-09-05T08:41:20.000Z",
  lastError: null,
};

const WEBHOOK_BODY: ApiParam[] = [
  { name: "name", in: "body", type: "string", required: true, description: "Up to 64 characters." },
  { name: "url", in: "body", type: "string", required: true, description: "http(s) URL the payload is sent to." },
  { name: "events", in: "body", type: "string[]", required: true, description: "Event names to subscribe to (see the webhooks documentation); at least one." },
  { name: "format", in: "body", type: "json | slack | discord | teams | text", description: "Payload shape; default json." },
  { name: "method", in: "body", type: "POST | PUT | PATCH", description: "JSON receivers only; chat formats always POST." },
  { name: "headers", in: "body", type: "object", description: "Extra request headers, name → value." },
  { name: "authType", in: "body", type: "none | bearer | basic | header", description: "How `authSecret` is sent." },
  { name: "authHeaderName", in: "body", type: "string", description: "Header name for authType header." },
  { name: "authSecret", in: "body", type: "string | null", description: "Stored encrypted, never returned. Omit to keep, null to clear." },
  { name: "signingSecret", in: "body", type: "string | null", description: "HMAC signing secret for the X-Chicoree-Signature header. Omit to keep, null to clear." },
  { name: "enabled", in: "body", type: "boolean", description: "Default true." },
];

/** The same six webhook endpoints exist for organizations and repositories. */
function webhookEndpoints(scope: "organization" | "repository"): ApiEndpoint[] {
  const base = scope === "organization" ? "/orgs/{org}/webhooks" : "/repos/{org}/{repo}/webhooks";
  const params = scope === "organization" ? [ORG_PARAM] : [ORG_PARAM, REPO_PARAM];
  const id: ApiParam = { name: "id", in: "path", type: "string", required: true, description: "Webhook id." };
  const group: ApiGroup = scope === "organization" ? "Organizations" : "Repositories";
  const noun = scope === "organization" ? "organization" : "repository";
  return [
    { method: "GET", path: base, group, summary: `List ${noun} webhooks`, description: scope === "organization" ? "Organization-wide hooks apply to every repository." : "The repository's own hooks; organization-wide ones are listed on the organization.", access: "manager", params, example: { items: [WEBHOOK_EXAMPLE], total: 1, max: scope === "organization" ? 10 : 5 }, since: "2026-09-05.3" },
    { method: "POST", path: base, group, summary: `Create a ${noun} webhook`, access: "manager", write: true, status: 201, params: [...params, ...WEBHOOK_BODY], example: { ...WEBHOOK_EXAMPLE, deliveries: [] }, since: "2026-09-05.3" },
    { method: "GET", path: `${base}/{id}`, group, summary: `${noun[0].toUpperCase()}${noun.slice(1)} webhook details`, description: "With the last deliveries.", access: "manager", params: [...params, id], example: { ...WEBHOOK_EXAMPLE, deliveries: [{ id: "d_1", event: "push", ok: true, statusCode: 200, attempts: 1, durationMs: 120, error: null, createdAt: "2026-09-05T08:41:20.000Z" }] }, since: "2026-09-05.3" },
    { method: "PATCH", path: `${base}/{id}`, group, summary: `Update a ${noun} webhook`, description: "Omitted fields keep their value.", access: "manager", write: true, params: [...params, id, ...WEBHOOK_BODY.map((p) => ({ ...p, required: false }))], example: { ...WEBHOOK_EXAMPLE, deliveries: [] }, since: "2026-09-05.3" },
    { method: "DELETE", path: `${base}/{id}`, group, summary: `Delete a ${noun} webhook`, access: "manager", write: true, params: [...params, id], example: { deleted: "wh_9c…" }, since: "2026-09-05.3" },
    { method: "POST", path: `${base}/{id}/test`, group, summary: `Send a test delivery`, description: "A push-shaped payload built from the most recent tag; the answer is what the receiver said.", access: "manager", write: true, params: [...params, id], example: { ok: true, status: 200, error: null }, since: "2026-09-05.3" },
  ];
}

export const API_CATALOG: ApiEndpoint[] = [
  // --- General ------------------------------------------------------------
  {
    method: "GET",
    path: "/",
    group: "General",
    summary: "API index",
    description: "Version, revision, changelog, the notice about how the API evolves, and the catalog of endpoints. Needs no credentials.",
    access: "public",
    example: {
      name: "Chicorée REST API",
      version: 1,
      revision: "2026-09-05.1",
      docs: "https://registry.example.com/docs/api",
      notice: "This API follows the registry's features: …",
      changelog: [{ revision: "2026-09-05.1", changes: ["Initial release …"] }],
      endpoints: [{ method: "GET", path: "/api/v1/orgs", summary: "List organizations", access: "public" }],
    },
    since: "2026-09-05.1",
  },
  {
    method: "GET",
    path: "/openapi.json",
    group: "General",
    summary: "OpenAPI document",
    description: "An OpenAPI 3.1 description of every endpoint for Swagger UI, Postman, Insomnia or client generators. Response schemas are inferred from the documented examples. Needs no credentials.",
    access: "public",
    example: { openapi: "3.1.0", info: { title: "Chicorée REST API", version: "2026-09-05.1" }, paths: { "/api/v1/orgs": { get: { summary: "List organizations" } } } },
    since: "2026-09-05.1",
  },
  {
    method: "POST",
    path: "/auth/exchange",
    group: "General",
    summary: "Exchange a CI OIDC token for a registry credential",
    description:
      "Keyless authentication: send the OIDC token your CI system issued (GitHub Actions, GitLab, any issuer an organization trusts) and get a short-lived credential back. The token is verified against the issuer's published keys, its audience must be this registry's URL or host, and its subject must match a trusted CI identity. The credential works as a bearer token here and as the docker login password. Needs no other credentials.",
    access: "public",
    params: [
      { name: "token", in: "body", type: "string", required: true, description: "The OIDC token (a JWT)." },
      { name: "organization", in: "body", type: "string", description: "Organization slug, required when several organizations trust the same identity." },
      { name: "ttl", in: "body", type: "integer", description: "Lifetime in seconds, 60–3600 (default 1800)." },
    ],
    example: {
      token: "chc_ci_eyJhbGciOi…",
      expiresAt: "2026-09-05T11:00:00.000Z",
      ttlSeconds: 1800,
      identity: { id: "ci_7a…", name: "github-main", organization: "acme", permission: "push", repositories: null },
      subject: "repo:acme/api:ref:refs/heads/main",
      dockerLogin: { registry: "registry.example.com", username: "ci", password: "chc_ci_eyJhbGciOi…" },
    },
    since: "2026-09-05.3",
  },
  {
    method: "GET",
    path: "/me",
    group: "General",
    summary: "Who am I",
    description: "The caller behind the credential: the user and, for tokens, the token's scope, expiry and restriction; for service accounts, the account and its permission.",
    access: "authenticated",
    serviceAccounts: true,
    example: {
      kind: "user",
      via: "token",
      user: { id: "u_7f…", name: "Jo Doe", email: "jo@example.com", role: "user", emailVerified: true },
      token: { id: "t_3a…", name: "ci", scope: "write", expiresAt: "2026-12-04T00:00:00.000Z", organization: "acme", repositories: null },
      serviceAccount: null,
      api: { version: 1, revision: "2026-09-05.1" },
    },
    since: "2026-09-05.1",
  },

  // --- Organizations ------------------------------------------------------
  {
    method: "GET",
    path: "/orgs",
    group: "Organizations",
    summary: "List organizations",
    description: "Organizations the caller belongs to or that have a repository the caller can see. `role` is the caller's role there (null when not a member; instance administrators are owners everywhere).",
    access: "public",
    serviceAccounts: true,
    paginated: true,
    params: [{ name: "q", in: "query", type: "string", description: "Filter by name or slug (substring)." }, ...PAGE_PARAMS],
    example: { items: [ORG_EXAMPLE], page: 1, perPage: 50, total: 1, pages: 1 },
    since: "2026-09-05.1",
  },
  {
    method: "GET",
    path: "/orgs/{org}",
    group: "Organizations",
    summary: "Organization details",
    access: "public",
    serviceAccounts: true,
    params: [ORG_PARAM],
    example: { ...ORG_EXAMPLE, memberCount: 5, storageBytes: 12884901888 },
    since: "2026-09-05.1",
  },
  {
    method: "GET",
    path: "/orgs/{org}/repos",
    group: "Organizations",
    summary: "List repositories of an organization",
    description: "Private repositories appear for members only.",
    access: "public",
    serviceAccounts: true,
    paginated: true,
    params: [
      ORG_PARAM,
      { name: "q", in: "query", type: "string", description: "Filter by name or description (substring)." },
      { name: "visibility", in: "query", type: "public | private", description: "Only one visibility." },
      { name: "sort", in: "query", type: "updated | pulls | name", description: "Order; default `updated` (newest push first)." },
      ...PAGE_PARAMS,
    ],
    example: { items: [REPO_EXAMPLE], page: 1, perPage: 50, total: 12, pages: 1 },
    since: "2026-09-05.1",
  },
  {
    method: "POST",
    path: "/orgs/{org}/repos",
    group: "Organizations",
    summary: "Create a repository",
    description: "Pushing to a new name creates a repository too; use this to set the description and visibility first. Quotas apply. Tokens limited to a repository list cannot create repositories.",
    access: "writer",
    write: true,
    status: 201,
    params: [
      ORG_PARAM,
      { name: "name", in: "body", type: "string", required: true, description: "Lowercase letters, digits and single `._-` separators; up to 100 characters (nested with `/` in proxy caches)." },
      { name: "description", in: "body", type: "string", description: "Shown in listings." },
      { name: "visibility", in: "body", type: "public | private", description: "Default: the organization's default visibility." },
    ],
    example: REPO_EXAMPLE,
    since: "2026-09-05.1",
  },
  {
    method: "GET",
    path: "/orgs/{org}/members",
    group: "Organizations",
    summary: "List members",
    access: "member",
    params: [ORG_PARAM],
    example: { items: [{ userId: "u_7f…", name: "Jo Doe", email: "jo@example.com", role: "owner", joinedAt: "2026-08-02T09:00:00.000Z" }], total: 1 },
    since: "2026-09-05.1",
  },
  {
    method: "GET",
    path: "/orgs/{org}/audit",
    group: "Organizations",
    summary: "Organization audit log",
    description: "Every change made through the app in this organization, newest first. Same filters as the audit page.",
    access: "manager",
    paginated: true,
    params: [
      ORG_PARAM,
      { name: "q", in: "query", type: "string", description: "Matches actor, target, action, or an exact id / address." },
      { name: "action", in: "query", type: "string", description: "Action or prefix, e.g. `tag.delete` or `repo`." },
      { name: "from", in: "query", type: "date", description: "YYYY-MM-DD, inclusive." },
      { name: "to", in: "query", type: "date", description: "YYYY-MM-DD, inclusive." },
      ...PAGE_PARAMS,
    ],
    example: {
      items: [
        {
          id: 8123,
          createdAt: "2026-09-05T08:50:00.000Z",
          actor: { type: "user", id: "u_7f…", label: "jo@example.com", impersonatorId: null },
          action: "tag.delete",
          target: { type: "tag", id: "d2f4…:1.3.9", label: "acme/api:1.3.9" },
          details: { outcome: { deleted: "1.3.9", latest: "unchanged" }, via: "api" },
          ip: "10.0.0.7",
          userAgent: "curl/8.7.1",
        },
      ],
      page: 1,
      perPage: 50,
      total: 1,
      pages: 1,
    },
    since: "2026-09-05.1",
  },

  {
    method: "POST",
    path: "/orgs",
    group: "Organizations",
    summary: "Create an organization",
    description: "The caller becomes its owner. Subject to the instance's organization-creation policy and the caller's limits; slugs become image namespaces.",
    access: "user",
    write: true,
    status: 201,
    params: [
      { name: "slug", in: "body", type: "string", required: true, description: "Lowercase letters, digits and single ._- separators; the image namespace." },
      { name: "name", in: "body", type: "string", description: "Display name; defaults to the slug." },
    ],
    example: { ...ORG_EXAMPLE, role: "owner", repositoryCount: 0, memberCount: 1, storageBytes: 0 },
    since: "2026-09-05.3",
  },
  {
    method: "PATCH",
    path: "/orgs/{org}",
    group: "Organizations",
    summary: "Rename an organization",
    description: "Changes the display name (the slug is changed in the app, which sets up redirects).",
    access: "manager",
    write: true,
    params: [ORG_PARAM, { name: "name", in: "body", type: "string", required: true, description: "New display name." }],
    example: { ...ORG_EXAMPLE, name: "Acme Corp", memberCount: 5, storageBytes: 12884901888 },
    since: "2026-09-05.3",
  },
  {
    method: "DELETE",
    path: "/orgs/{org}",
    group: "Organizations",
    summary: "Delete an organization",
    description: "Owners only. Removes every repository, member, invitation and service account; blob data is reclaimed by garbage collection. The library organization cannot be deleted.",
    access: "manager",
    write: true,
    params: [ORG_PARAM],
    example: { deleted: "acme" },
    since: "2026-09-05.3",
  },
  {
    method: "GET",
    path: "/orgs/{org}/usage",
    group: "Organizations",
    summary: "Usage against limits",
    access: "manager",
    params: [ORG_PARAM],
    example: { organization: "acme", usage: { publicRepositories: 2, privateRepositories: 10, storageBytes: 12884901888 }, limits: { maxPublicRepositories: null, maxPrivateRepositories: 20, maxStorageBytes: 53687091200 }, percent: { publicRepositories: null, privateRepositories: 50, storage: 24 } },
    since: "2026-09-05.3",
  },
  {
    method: "GET",
    path: "/orgs/{org}/policies",
    group: "Organizations",
    summary: "Organization policies",
    description: "Default visibility for new repositories, the vulnerability pull policy, the signature policy and whether members' personal signing keys are trusted.",
    access: "member",
    params: [ORG_PARAM],
    example: { defaultVisibility: "private", pullPolicy: { blockPullsAt: "high", blockUnrated: false }, requireSignature: false, trustMemberKeys: true },
    since: "2026-09-05.3",
  },
  {
    method: "PATCH",
    path: "/orgs/{org}/policies",
    group: "Organizations",
    summary: "Change organization policies",
    description: "Send only the fields to change. Pull and signature changes recompute which images are blocked; changing trustMemberKeys re-verifies every signature.",
    access: "manager",
    write: true,
    params: [
      ORG_PARAM,
      { name: "defaultVisibility", in: "body", type: "public | private | null", description: "null = each pusher's own default." },
      { name: "blockPullsAt", in: "body", type: "critical | high | medium | low | null", description: "Block pulls of images with findings at this severity or above; null = never." },
      { name: "blockUnrated", in: "body", type: "boolean", description: "Count findings without a rating." },
      { name: "requireSignature", in: "body", type: "boolean", description: "Block pulls of unsigned images." },
      { name: "trustMemberKeys", in: "body", type: "boolean", description: "Members' personal signing keys count as trusted." },
    ],
    example: { defaultVisibility: "private", pullPolicy: { blockPullsAt: "critical", blockUnrated: true }, requireSignature: true, trustMemberKeys: true },
    since: "2026-09-05.3",
  },
  {
    method: "GET",
    path: "/orgs/{org}/service-accounts",
    group: "Organizations",
    summary: "List service accounts",
    access: "manager",
    params: [ORG_PARAM],
    example: { items: [{ id: "sa_4b…", name: "ci-deploy", description: "GitHub Actions", permission: "push", tokenPrefix: "chc_sa_ab12cd…", repositories: null, createdAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-12-01T10:00:00.000Z", lastUsedAt: "2026-09-05T08:41:00.000Z", lastUsedIp: "10.0.0.9" }], total: 1 },
    since: "2026-09-05.3",
  },
  {
    method: "POST",
    path: "/orgs/{org}/service-accounts",
    group: "Organizations",
    summary: "Create a service account",
    description: "The secret is in the answer once and never again. Expiry follows the instance's token policy.",
    access: "manager",
    write: true,
    status: 201,
    params: [
      ORG_PARAM,
      { name: "name", in: "body", type: "string", required: true, description: "Lowercase letters, digits and single ._- separators; unique in the organization." },
      { name: "description", in: "body", type: "string", description: "Shown in the list." },
      { name: "permission", in: "body", type: "pull | push | admin", description: "Default pull; admin adds delete." },
      { name: "expiresInDays", in: "body", type: "integer", description: "Lifetime in days; omit both expiry fields for never (when the policy allows)." },
      { name: "expiresAt", in: "body", type: "date", description: "Alternative to expiresInDays: an ISO date." },
      { name: "repositories", in: "body", type: "string[]", description: "Limit to these repository names; omit for every repository." },
    ],
    example: { ...{ id: "sa_4b…", name: "ci-deploy", description: "GitHub Actions", permission: "push", tokenPrefix: "chc_sa_ab12cd…", repositories: null, createdAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-12-01T10:00:00.000Z", lastUsedAt: "2026-09-05T08:41:00.000Z", lastUsedIp: "10.0.0.9" }, secret: "chc_sa_ab12cd…full-secret" },
    since: "2026-09-05.3",
  },
  {
    method: "GET",
    path: "/orgs/{org}/service-accounts/{id}",
    group: "Organizations",
    summary: "Service account details",
    access: "manager",
    params: [ORG_PARAM, { name: "id", in: "path", type: "string", required: true, description: "Service account id." }],
    example: { id: "sa_4b…", name: "ci-deploy", description: "GitHub Actions", permission: "push", tokenPrefix: "chc_sa_ab12cd…", repositories: null, createdAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-12-01T10:00:00.000Z", lastUsedAt: "2026-09-05T08:41:00.000Z", lastUsedIp: "10.0.0.9" },
    since: "2026-09-05.3",
  },
  {
    method: "DELETE",
    path: "/orgs/{org}/service-accounts/{id}",
    group: "Organizations",
    summary: "Delete a service account",
    access: "manager",
    write: true,
    params: [ORG_PARAM, { name: "id", in: "path", type: "string", required: true, description: "Service account id." }],
    example: { deleted: "sa_4b…", name: "ci-deploy" },
    since: "2026-09-05.3",
  },
  {
    method: "POST",
    path: "/orgs/{org}/service-accounts/{id}/rotate",
    group: "Organizations",
    summary: "Rotate a service account's secret",
    description: "Same id, name, permission and repositories; the old secret stops working at once. The lifetime restarts from now under the policy.",
    access: "manager",
    write: true,
    params: [ORG_PARAM, { name: "id", in: "path", type: "string", required: true, description: "Service account id." }],
    example: { ...{ id: "sa_4b…", name: "ci-deploy", description: "GitHub Actions", permission: "push", tokenPrefix: "chc_sa_ab12cd…", repositories: null, createdAt: "2026-09-01T10:00:00.000Z", expiresAt: "2026-12-01T10:00:00.000Z", lastUsedAt: "2026-09-05T08:41:00.000Z", lastUsedIp: "10.0.0.9" }, secret: "chc_sa_ef34gh…new-secret" },
    since: "2026-09-05.3",
  },
  {
    method: "PATCH",
    path: "/orgs/{org}/members/{userId}",
    group: "Organizations",
    summary: "Change a member's role",
    description: "Owners and admins; only owners (or instance administrators) may make or unmake owners, and the last owner cannot be demoted.",
    access: "manager",
    write: true,
    params: [ORG_PARAM, { name: "userId", in: "path", type: "string", required: true, description: "The member's user id." }, { name: "role", in: "body", type: "owner | admin | member | viewer", required: true, description: "New role." }],
    example: { userId: "u_7f…", name: "Jo Doe", email: "jo@example.com", role: "admin", joinedAt: "2026-08-02T09:00:00.000Z" },
    since: "2026-09-05.3",
  },
  {
    method: "DELETE",
    path: "/orgs/{org}/members/{userId}",
    group: "Organizations",
    summary: "Remove a member",
    description: "The last owner cannot be removed.",
    access: "manager",
    write: true,
    params: [ORG_PARAM, { name: "userId", in: "path", type: "string", required: true, description: "The member's user id." }],
    example: { removed: "u_7f…", email: "jo@example.com" },
    since: "2026-09-05.3",
  },
  {
    method: "GET",
    path: "/orgs/{org}/invitations",
    group: "Organizations",
    summary: "List pending invitations",
    access: "manager",
    params: [ORG_PARAM],
    example: { items: [{ id: "inv_2e…", email: "new@example.com", role: "member", status: "pending", expiresAt: "2026-09-07T09:00:00.000Z", createdAt: "2026-09-05T09:00:00.000Z", inviterId: "u_7f…" }], total: 1 },
    since: "2026-09-05.3",
  },
  {
    method: "POST",
    path: "/orgs/{org}/invitations",
    group: "Organizations",
    summary: "Invite someone by email",
    description: "Sends the invitation email when mail is configured (`emailSent` says whether it went out); `acceptUrl` can be handed over by other means. Invitations expire after 48 hours.",
    access: "manager",
    write: true,
    status: 201,
    params: [ORG_PARAM, { name: "email", in: "body", type: "string", required: true, description: "Address to invite." }, { name: "role", in: "body", type: "owner | admin | member | viewer", description: "Default member; owner needs an owner." }],
    example: { id: "inv_2e…", email: "new@example.com", role: "member", status: "pending", expiresAt: "2026-09-07T09:00:00.000Z", createdAt: "2026-09-05T09:00:00.000Z", inviterId: "u_7f…", emailSent: true, acceptUrl: "https://registry.example.com/accept-invitation/inv_2e…" },
    since: "2026-09-05.3",
  },
  {
    method: "DELETE",
    path: "/orgs/{org}/invitations/{id}",
    group: "Organizations",
    summary: "Cancel an invitation",
    access: "manager",
    write: true,
    params: [ORG_PARAM, { name: "id", in: "path", type: "string", required: true, description: "Invitation id." }],
    example: { canceled: "inv_2e…", email: "new@example.com" },
    since: "2026-09-05.3",
  },
  {
    method: "GET",
    path: "/orgs/{org}/ci-identities",
    group: "Organizations",
    summary: "List trusted CI identities",
    description: "Workflows that may authenticate keylessly through POST /auth/exchange.",
    access: "manager",
    params: [ORG_PARAM],
    example: { items: [{ id: "ci_7a…", name: "github-main", issuer: "https://token.actions.githubusercontent.com", subject: "repo:acme/api:ref:refs/heads/main", permission: "push", repositories: null, createdAt: "2026-09-05T10:00:00.000Z", lastUsedAt: "2026-09-05T10:30:00.000Z", lastSubject: "repo:acme/api:ref:refs/heads/main" }], total: 1 },
    since: "2026-09-05.3",
  },
  {
    method: "POST",
    path: "/orgs/{org}/ci-identities",
    group: "Organizations",
    summary: "Trust a CI identity",
    access: "manager",
    write: true,
    status: 201,
    params: [
      ORG_PARAM,
      { name: "name", in: "body", type: "string", required: true, description: "Lowercase letters, digits and single ._- separators." },
      { name: "issuer", in: "body", type: "string", required: true, description: "The token's issuer URL, e.g. https://token.actions.githubusercontent.com or https://gitlab.com." },
      { name: "subject", in: "body", type: "string", required: true, description: "The token's sub claim, exact or with * wildcards, e.g. repo:acme/api:ref:refs/heads/main." },
      { name: "permission", in: "body", type: "pull | push | admin", description: "Default push." },
      { name: "repositories", in: "body", type: "string[]", description: "Limit to these repository names." },
    ],
    example: { id: "ci_7a…", name: "github-main", issuer: "https://token.actions.githubusercontent.com", subject: "repo:acme/api:ref:refs/heads/main", permission: "push", repositories: null, createdAt: "2026-09-05T10:00:00.000Z", lastUsedAt: "2026-09-05T10:30:00.000Z", lastSubject: "repo:acme/api:ref:refs/heads/main" },
    since: "2026-09-05.3",
  },
  {
    method: "DELETE",
    path: "/orgs/{org}/ci-identities/{id}",
    group: "Organizations",
    summary: "Stop trusting a CI identity",
    description: "Credentials minted through it stop working at once.",
    access: "manager",
    write: true,
    params: [ORG_PARAM, { name: "id", in: "path", type: "string", required: true, description: "Identity id." }],
    example: { deleted: "ci_7a…", name: "github-main" },
    since: "2026-09-05.3",
  },
  ...webhookEndpoints("organization"),

  // --- Repositories -------------------------------------------------------
  {
    method: "GET",
    path: "/repos/{org}/{repo}",
    group: "Repositories",
    summary: "Repository details",
    description: "The listing fields plus the README (Markdown), storage figures and whether the caller starred it.",
    access: "public",
    serviceAccounts: true,
    params: [ORG_PARAM, REPO_PARAM],
    example: {
      ...REPO_EXAMPLE,
      createdAt: "2026-08-02T09:00:00.000Z",
      readme: "# api\n\nHow to run it…",
      storage: { logicalBytes: 2147483648, physicalBytes: 734003200, sharedBytes: 402653184, sharedWithRepositories: 3 },
      starred: false,
    },
    since: "2026-09-05.1",
  },
  {
    method: "PATCH",
    path: "/repos/{org}/{repo}",
    group: "Repositories",
    summary: "Update a repository",
    description: "Change the description and/or the visibility. Omitted fields stay as they are.",
    access: "manager",
    write: true,
    params: [
      ORG_PARAM,
      REPO_PARAM,
      { name: "description", in: "body", type: "string", description: "New description (empty string clears it)." },
      { name: "visibility", in: "body", type: "public | private", description: "Quotas apply when switching." },
    ],
    example: REPO_EXAMPLE,
    since: "2026-09-05.1",
  },
  {
    method: "DELETE",
    path: "/repos/{org}/{repo}",
    group: "Repositories",
    summary: "Delete a repository",
    description: "Removes the repository with all its tags and manifests. Blob data is reclaimed by the next garbage collection.",
    access: "manager",
    write: true,
    params: [ORG_PARAM, REPO_PARAM],
    example: { deleted: "acme/api" },
    since: "2026-09-05.1",
  },
  {
    method: "GET",
    path: "/repos/{org}/{repo}/policies",
    group: "Repositories",
    summary: "Repository policies",
    description: "The repository's overrides (`inherit` = the organization's setting) and what applies after folding them in.",
    access: "public",
    serviceAccounts: true,
    params: [ORG_PARAM, REPO_PARAM],
    example: { blockPullsAt: "inherit", blockUnrated: null, requireSignature: "inherit", effective: { pullPolicy: { level: "high", unrated: false }, requireSignature: false } },
    since: "2026-09-05.3",
  },
  {
    method: "PATCH",
    path: "/repos/{org}/{repo}/policies",
    group: "Repositories",
    summary: "Change repository policies",
    description: "Send only the fields to change; blocked images are recomputed and `blocked` says how many there are now.",
    access: "manager",
    write: true,
    params: [
      ORG_PARAM,
      REPO_PARAM,
      { name: "blockPullsAt", in: "body", type: "inherit | off | critical | high | medium | low", description: "Override of the pull policy." },
      { name: "blockUnrated", in: "body", type: "boolean | null", description: "Override for unrated findings; null inherits." },
      { name: "requireSignature", in: "body", type: "inherit | boolean", description: "Override of the signature policy." },
    ],
    example: { blockPullsAt: "critical", blockUnrated: true, requireSignature: "inherit", effective: { pullPolicy: { level: "critical", unrated: true }, requireSignature: false }, blocked: 2 },
    since: "2026-09-05.3",
  },
  ...webhookEndpoints("repository"),
  {
    method: "PUT",
    path: "/repos/{org}/{repo}/star",
    group: "Repositories",
    summary: "Star a repository",
    access: "user",
    write: true,
    params: [ORG_PARAM, REPO_PARAM],
    example: { starred: true, count: 4 },
    since: "2026-09-05.1",
  },
  {
    method: "DELETE",
    path: "/repos/{org}/{repo}/star",
    group: "Repositories",
    summary: "Unstar a repository",
    access: "user",
    write: true,
    params: [ORG_PARAM, REPO_PARAM],
    example: { starred: false, count: 3 },
    since: "2026-09-05.1",
  },

  // --- Tags ---------------------------------------------------------------
  {
    method: "GET",
    path: "/repos/{org}/{repo}/tags",
    group: "Tags",
    summary: "List tags",
    description: "Newest push first. Index tags carry their variants' scans rolled up (worst case wins).",
    access: "public",
    serviceAccounts: true,
    paginated: true,
    params: [ORG_PARAM, REPO_PARAM, INCLUDE_ARTIFACTS, ...PAGE_PARAMS],
    example: { items: [TAG_EXAMPLE], page: 1, perPage: 50, total: 18, pages: 1 },
    since: "2026-09-05.1",
  },
  {
    method: "GET",
    path: "/repos/{org}/{repo}/tags/{tag}",
    group: "Tags",
    summary: "Tag details",
    description: "The image the tag points at — every field of *Image details*, plus `tag` and `tagPushedAt`; `reference` and `url` name the tag.",
    access: "public",
    serviceAccounts: true,
    params: [ORG_PARAM, REPO_PARAM, { name: "tag", in: "path", type: "string", required: true, description: "Tag name." }],
    example: { tag: "1.4.0", tagPushedAt: "2026-09-05T08:41:12.000Z", digest: "sha256:5f2b…", tags: ["1.4.0", "latest"], isIndex: false, platform: "linux/amd64", signed: true, blocked: null },
    since: "2026-09-05.1",
  },
  {
    method: "PUT",
    path: "/repos/{org}/{repo}/tags/{tag}",
    group: "Tags",
    summary: "Tag an image (retag)",
    description:
      "Points the tag at an image that already exists in the repository — \"promote this build to latest\" without pulling and pushing. The stored manifest is pushed under the tag, so webhooks and scans follow as for any push. Immutable tags are refused when they would move; a tag already naming the digest is left alone (`changed: false`). Answers 201 for a new tag, 200 otherwise, with the image document.",
    access: "writer",
    write: true,
    serviceAccounts: true,
    params: [
      ORG_PARAM,
      REPO_PARAM,
      { name: "tag", in: "path", type: "string", required: true, description: "Tag name to create or move." },
      { name: "digest", in: "body", type: "string", required: true, description: "Digest of an image in this repository." },
    ],
    example: { tag: "latest", previousDigest: "sha256:a1b2…", changed: true, digest: "sha256:5f2b…", tags: ["1.4.0", "latest"], isIndex: false, signed: true, blocked: null },
    since: "2026-09-05.3",
  },
  {
    method: "POST",
    path: "/repos/{org}/{repo}/tags/{tag}/copy",
    group: "Tags",
    summary: "Copy (promote) a tagged image to another repository",
    description:
      "Copies the image — every platform variant, its layers (mounted, not re-uploaded, when both repositories share storage) and, unless `includeArtifacts` is false, its signatures, SBOMs and provenance — into another repository, creating it when missing. Needs push rights on both sides; proxy caches, immutable destination tags and quotas are respected.",
    access: "writer",
    write: true,
    serviceAccounts: true,
    status: 201,
    params: [
      ORG_PARAM,
      REPO_PARAM,
      { name: "tag", in: "path", type: "string", required: true, description: "Source tag." },
      { name: "organization", in: "body", type: "string", description: "Destination organization slug; default: the source organization." },
      { name: "repository", in: "body", type: "string", required: true, description: "Destination repository name (created when missing)." },
      { name: "tag", in: "body", type: "string", description: "Destination tag; default: the source tag." },
      { name: "includeArtifacts", in: "body", type: "boolean", description: "Copy attached signatures, SBOMs and provenance too. Default true." },
    ],
    example: {
      from: "acme/api:1.4.0",
      to: "acme/api-prod:1.4.0",
      digest: "sha256:5f2b…",
      destination: { organization: "acme", repository: "api-prod", tag: "1.4.0", created: true },
      blobsMounted: 9,
      blobsUploaded: 0,
      manifestsPushed: 4,
      artifactsCopied: 1,
    },
    since: "2026-09-05.3",
  },
  {
    method: "DELETE",
    path: "/repos/{org}/{repo}/tags/{tag}",
    group: "Tags",
    summary: "Delete a tag",
    description:
      "Removes the tag through the registry. When `latest` pointed at the deleted image it moves to the newest remaining tag (or goes with the last image) unless `keep_latest=true`. Protected tags are refused.",
    access: "manager",
    write: true,
    serviceAccounts: true,
    params: [
      ORG_PARAM,
      REPO_PARAM,
      { name: "tag", in: "path", type: "string", required: true, description: "Tag name." },
      { name: "keep_latest", in: "query", type: "boolean", description: "Leave `latest` where it is. Default false." },
    ],
    example: { deleted: "1.3.9", latest: "moved", latestTarget: "1.4.0" },
    since: "2026-09-05.1",
  },
  {
    method: "GET",
    path: "/repos/{org}/{repo}/untagged",
    group: "Tags",
    summary: "List untagged manifests",
    description: "Manifests no tag points at, newest first — what *prune-untagged* would remove. Index members and attached artifacts are left out unless `include_artifacts=true`.",
    access: "public",
    serviceAccounts: true,
    paginated: true,
    params: [ORG_PARAM, REPO_PARAM, INCLUDE_ARTIFACTS, ...PAGE_PARAMS],
    example: {
      items: [
        {
          digest: "sha256:9c0e…",
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          artifactType: null,
          isIndex: false,
          sizeBytes: 1421,
          contentBytes: 48211234,
          platform: "linux/arm64",
          pushedAt: "2026-09-01T07:00:00.000Z",
          pushedBy: "user:u_7f…",
          indexMember: false,
          parentTags: [],
          attestation: false,
          referrer: false,
          subjectDigest: null,
          referrerCount: 0,
        },
      ],
      page: 1,
      perPage: 50,
      total: 1,
      pages: 1,
    },
    since: "2026-09-05.1",
  },

  // --- Images -------------------------------------------------------------
  {
    method: "GET",
    path: "/repos/{org}/{repo}/manifests/{digest}",
    group: "Images",
    summary: "Image details",
    description:
      "Everything the tag page shows: media type, size, tags, who pushed it, the image config (platform, entrypoint, labels), layers with their Dockerfile instructions, the variants of an index, the scan result, signature state and the pull-policy block reason.",
    access: "public",
    serviceAccounts: true,
    params: [ORG_PARAM, REPO_PARAM, DIGEST_PARAM],
    example: {
      digest: "sha256:5f2b…",
      tags: ["1.4.0", "latest"],
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: null,
      isIndex: false,
      manifestBytes: 1421,
      sizeBytes: 48211234,
      pushedAt: "2026-09-05T08:41:12.000Z",
      pushedBy: { type: "user", id: "u_7f…", label: "Jo Doe" },
      platform: "linux/amd64",
      config: {
        created: "2026-09-05T08:40:51.000Z",
        os: "linux",
        architecture: "amd64",
        variant: null,
        user: "app",
        workingDir: "/app",
        entrypoint: ["/app/server"],
        cmd: [],
        env: ["PATH=/usr/local/sbin:…"],
        exposedPorts: ["8080/tcp"],
        labels: { "org.opencontainers.image.source": "https://github.com/acme/api" },
      },
      layers: [{ digest: "sha256:aa…", sizeBytes: 3400000, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip", command: "ADD alpine-minirootfs.tar.gz /" }],
      variants: [],
      indexes: [],
      subjectDigest: null,
      scan: SCAN_EXAMPLE,
      signed: true,
      blocked: null,
      canDelete: { ok: true, reason: null },
      reference: "registry.example.com/acme/api@sha256:5f2b…",
      url: "https://registry.example.com/acme/api/tags/sha256:5f2b…",
    },
    since: "2026-09-05.1",
  },
  {
    method: "DELETE",
    path: "/repos/{org}/{repo}/manifests/{digest}",
    group: "Images",
    summary: "Delete an image by digest",
    description: "Every tag pointing at it goes too. Members of an index that still exists and images carrying a protected tag are refused.",
    access: "manager",
    write: true,
    serviceAccounts: true,
    params: [ORG_PARAM, REPO_PARAM, DIGEST_PARAM],
    example: { digest: "sha256:5f2b…", tags: ["1.3.9"] },
    since: "2026-09-05.1",
  },
  {
    method: "POST",
    path: "/repos/{org}/{repo}/manifests/{digest}/copy",
    group: "Images",
    summary: "Copy an image by digest to another repository",
    description: "The same as copying a tag, for an image addressed by digest; `tag` is required.",
    access: "writer",
    write: true,
    serviceAccounts: true,
    status: 201,
    params: [
      ORG_PARAM,
      REPO_PARAM,
      DIGEST_PARAM,
      { name: "organization", in: "body", type: "string", description: "Destination organization slug; default: the source organization." },
      { name: "repository", in: "body", type: "string", required: true, description: "Destination repository name (created when missing)." },
      { name: "tag", in: "body", type: "string", required: true, description: "Destination tag." },
      { name: "includeArtifacts", in: "body", type: "boolean", description: "Copy attached signatures, SBOMs and provenance too. Default true." },
    ],
    example: { from: "acme/api@sha256:5f2b…", to: "acme/api-prod:1.4.0", digest: "sha256:5f2b…", destination: { organization: "acme", repository: "api-prod", tag: "1.4.0", created: false }, blobsMounted: 9, blobsUploaded: 0, manifestsPushed: 4, artifactsCopied: 1 },
    since: "2026-09-05.3",
  },
  {
    method: "GET",
    path: "/repos/{org}/{repo}/manifests/{digest}/scan",
    group: "Images",
    summary: "Scan gate",
    description:
      "The image's current scan judged against a severity threshold — what a pipeline calls before shipping. `wait` blocks until a running scan finishes (at most 300 s); `fail_on` sets the threshold, accepted risks do not count, `unrated` adds findings without a rating. `passed` is true or false when the image could be judged, null otherwise (`note` says why). Indexes are not scanned: gate a platform variant.",
    access: "public",
    serviceAccounts: true,
    params: [
      ORG_PARAM,
      REPO_PARAM,
      DIGEST_PARAM,
      { name: "wait", in: "query", type: "integer", description: "Seconds to wait for a running scan, 0–300." },
      { name: "fail_on", in: "query", type: "critical | high | medium | low", description: "Fail on findings at this severity or above; omitted = report only." },
      { name: "unrated", in: "query", type: "boolean", description: "Count findings without a rating as failures." },
    ],
    example: {
      digest: "sha256:5f2b…",
      isIndex: false,
      scan: SCAN_EXAMPLE,
      summary: { High: 2, Medium: 7, Low: 11, Unknown: 1 },
      effectiveSummary: { High: 1, Medium: 7, Low: 11, Unknown: 1 },
      threshold: { failOn: "high", unrated: false },
      passed: false,
      violation: "1 high finding; policy blocks high and above",
      note: null,
      checkedAt: "2026-09-05T09:00:00.000Z",
    },
    since: "2026-09-05.3",
  },
  {
    method: "POST",
    path: "/repos/{org}/{repo}/manifests/{digest}/scan",
    group: "Images",
    summary: "Queue a vulnerability scan",
    description:
      "Re-scans one image. Indexes, attestations and images already being scanned are refused with the reason in `message`; `queued` says whether a scan started. With `wait` the call also waits for the result and answers like the scan gate (200 instead of 202).",
    access: "admin",
    write: true,
    status: 202,
    params: [
      ORG_PARAM,
      REPO_PARAM,
      DIGEST_PARAM,
      { name: "wait", in: "query", type: "integer", description: "Seconds to wait for the scan, 0–300; with a value the answer is the scan gate document." },
      { name: "fail_on", in: "query", type: "critical | high | medium | low", description: "Threshold for the gate when waiting." },
      { name: "unrated", in: "query", type: "boolean", description: "Count unrated findings as failures when waiting." },
    ],
    example: { queued: true, message: "Scan queued; the result appears when it finishes." },
    since: "2026-09-05.1",
  },

  // --- Security -----------------------------------------------------------
  {
    method: "GET",
    path: "/repos/{org}/{repo}/manifests/{digest}/vulnerabilities",
    group: "Security",
    summary: "Vulnerabilities of an image",
    description: "The normalised findings of the last scan, worst first, each with the accepted risk that covers it (if any). `summary` counts every finding, `effectiveSummary` only those no exception accepts — what the pull policy judges.",
    access: "public",
    serviceAccounts: true,
    paginated: true,
    params: [
      ORG_PARAM,
      REPO_PARAM,
      DIGEST_PARAM,
      { name: "severity", in: "query", type: "string", description: "Comma-separated: Critical, High, Medium, Low, Negligible, Unknown." },
      { name: "fixed", in: "query", type: "boolean", description: "Only findings with a fixed version." },
      { name: "q", in: "query", type: "string", description: "Substring of the id, package, title or ecosystem." },
      { name: "include_accepted", in: "query", type: "boolean", description: "Include findings an accepted risk covers. Default true." },
      ...PAGE_PARAMS,
    ],
    example: {
      digest: "sha256:5f2b…",
      scan: SCAN_EXAMPLE,
      items: [
        {
          id: "CVE-2026-1234",
          severity: "High",
          package: "openssl",
          version: "3.3.1-r0",
          fixedIn: "3.3.2-r0",
          type: "os",
          ecosystem: "alpine",
          distro: "Alpine Linux v3.21",
          title: "openssl: buffer overflow in …",
          description: "…",
          links: ["https://nvd.nist.gov/vuln/detail/CVE-2026-1234"],
          layerDigest: "sha256:aa…",
          accepted: null,
        },
      ],
      page: 1,
      perPage: 50,
      total: 21,
      pages: 1,
    },
    since: "2026-09-05.1",
  },
  {
    method: "GET",
    path: "/repos/{org}/{repo}/manifests/{digest}/artifacts",
    group: "Security",
    summary: "Signatures, SBOMs and provenance of an image",
    description: "The attached artifacts (referrers API and cosign tag convention) with their verification state against the trusted keys and identities in scope. For an index, the variants' artifacts are included.",
    access: "public",
    serviceAccounts: true,
    params: [ORG_PARAM, REPO_PARAM, DIGEST_PARAM],
    example: {
      subjects: [{ digest: "sha256:5f2b…", label: "image" }],
      signatures: [
        {
          digest: "sha256:77…",
          subjectDigest: "sha256:5f2b…",
          source: "referrer",
          tag: null,
          createdAt: "2026-09-05T08:41:40.000Z",
          sizeBytes: 2311,
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          artifactType: "application/vnd.dev.cosign.simplesigning.v1+json",
          format: "sigstore-bundle",
          predicateType: null,
          signatures: 1,
          verification: { status: "verified", keyName: "release", signer: null, keyFingerprint: "SHA256:…", identity: null, issuer: null, description: "verified by key release" },
          download: "https://registry.example.com/api/artifacts/acme%2Fapi/sha256:77…",
        },
      ],
      sboms: [],
      provenance: [],
      others: [],
      trustedKeys: 1,
      memberKeys: 0,
      trustedIdentities: 0,
      total: 1,
    },
    since: "2026-09-05.1",
  },

  // --- Search -------------------------------------------------------------
  {
    method: "GET",
    path: "/search",
    group: "Search",
    summary: "Search",
    description: "Repositories (name, description, `org/name`), tags (`repo:tag` narrows the repository), manifest digests (a hex prefix) and organizations the caller may see. Every group is paged on its own with `page`/`per_page`.",
    access: "public",
    serviceAccounts: true,
    params: [
      { name: "q", in: "query", type: "string", required: true, description: "At least 2 characters." },
      { name: "type", in: "query", type: "repositories | tags | digests | organizations", description: "Only one group (default: all four)." },
      ...PAGE_PARAMS,
    ],
    example: {
      q: "api",
      total: 3,
      repositories: { items: [REPO_EXAMPLE], page: 1, perPage: 20, total: 1, pages: 1 },
      tags: { items: [{ organization: "acme", repository: "api", tag: "api-1", digest: "sha256:…", pushedAt: "…", visibility: "private" }], page: 1, perPage: 20, total: 1, pages: 1 },
      digests: { items: [], page: 1, perPage: 20, total: 0, pages: 1 },
      organizations: { items: [{ slug: "acme", name: "Acme", repositoryCount: 12, member: true }], page: 1, perPage: 20, total: 1, pages: 1 },
    },
    since: "2026-09-05.1",
  },

  // --- Account ------------------------------------------------------------
  {
    method: "GET",
    path: "/me/starred",
    group: "Account",
    summary: "Repositories I starred",
    access: "user",
    params: [{ name: "limit", in: "query", type: "integer", description: "At most this many, 1–200 (default 50)." }],
    example: { items: [{ ...REPO_EXAMPLE, starredAt: "2026-09-03T12:00:00.000Z" }], total: 1 },
    since: "2026-09-05.1",
  },
];

/** `/repos/{org}/{repo}` → `repos/[org]/[repo]` (the route directory under app/api/v1). */
export function routeDirectory(path: string): string {
  return path.replace(/^\//, "").replace(/\{(\w+)\}/g, "[$1]");
}

export const ACCESS_LABELS: Record<ApiAccess, string> = {
  public: "anyone (public repositories only without credentials)",
  authenticated: "any credential",
  user: "a signed-in user or personal access token",
  member: "organization members",
  writer: "organization owners, admins and members",
  manager: "organization owners and admins",
  admin: "instance administrators",
};
