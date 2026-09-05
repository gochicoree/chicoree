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
    path: "/repos/{org}/{repo}/manifests/{digest}/scan",
    group: "Images",
    summary: "Queue a vulnerability scan",
    description: "Re-scans one image. Indexes, attestations and images already being scanned are refused with the reason in `message`; `queued` says whether a scan started.",
    access: "admin",
    write: true,
    status: 202,
    params: [ORG_PARAM, REPO_PARAM, DIGEST_PARAM],
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
