// The public REST API's version line. API_VERSION is the path prefix
// (/api/v1); API_REVISION moves with every addition, change or removal and
// is what clients compare. GET /api/v1 serves both together with the
// changelog, and the documentation (lib/api/docs.ts) renders it.
//
// Rule of the house: a feature that is added, changed or removed anywhere
// in the registry changes this API in the same release — the catalog
// (lib/api/catalog.ts), the route handlers under app/api/v1 and the entry
// below all move together. Never edit one without the others.

export const API_VERSION = 1;
export const API_BASE = `/api/v${API_VERSION}`;

export interface ApiChange {
  /** Revision string, YYYY-MM-DD.n — newest entry first. */
  revision: string;
  /** What changed, one sentence per item. Prefix removals with "Removed:" and breaking changes with "Breaking:". */
  changes: string[];
}

export const API_CHANGELOG: ApiChange[] = [
  {
    revision: "2026-09-07.5",
    changes: [
      "Security: `GET /repos/{org}/{repo}/artifacts/{digest}/packages` pages through the packages of an SBOM artifact (`q`, `page`, `per_page` up to 500), sorted by name; the tag page's package dialog uses the same list instead of loading the whole document.",
      "Keyless CI: GitHub now writes the owner's and the repository's ids into the token subject (`repo:owner@123/repo@456:ref:…`); `POST /auth/exchange` matches trusted identities written with or without the ids, so subjects documented as `repo:owner/repo:ref:…` keep working.",
    ],
  },
  {
    revision: "2026-09-07.4",
    changes: [
      "Tags: `sizeBytes` and `layerCount` of a multi-arch tag are those of its first platform variant the registry holds (previously null), and the new `sizePlatform` names that platform (`linux/amd64`); it is null for single-platform images. The tag list and the untagged list on the repository page show the same figures.",
      "Repositories: `kind` is judged from that variant when the newest tag is a multi-arch index, so an image pushed for several platforms is `image` (previously `empty`).",
    ],
  },
  {
    revision: "2026-09-07.3",
    changes: [
      "Helm charts: `GET /repos/{org}/{repo}/tags/{tag}/chart` carries `provenance` when the chart was pushed with its `.prov` file (which files it names, whether the archive matches, the PGP key id). Tag and manifest details treat a manifest as a chart by its config media type even when Chart.yaml cannot be read.",
    ],
  },
  {
    revision: "2026-09-07.2",
    changes: [
      "Helm charts: repositories carry `kind` (`image` | `chart` | `empty`, from the newest tag) and `helmReference` (`oci://…`) for charts; tags carry `chart: { name, version, appVersion }`; manifest and tag details carry `kind`, `chart` (Chart.yaml) and `helm` commands. New `GET /repos/{org}/{repo}/tags/{tag}/chart` returns Chart.yaml, values.yaml, the README and the file list from the archive. For charts, `platform`, `config` and `scan` are null in tag and manifest details.",
    ],
  },
  {
    revision: "2026-09-07.1",
    changes: [
      "Teams: `GET/POST /orgs/{org}/teams`, `GET/PATCH/DELETE /orgs/{org}/teams/{team}`, `GET /orgs/{org}/teams/{team}/members`, `PUT/DELETE /orgs/{org}/teams/{team}/members/{userId}`. Teams group members of an organization so repository access can be granted to all of them at once.",
      "Per-repository permissions: `GET /repos/{org}/{repo}/access`, `PUT/DELETE /repos/{org}/{repo}/access/{user|team}/{id}` with `permission: pull | push | admin`. The organization role stays the baseline for every repository; a grant raises what one person or one team may do in one repository. Docker tokens, the API's write checks and the pages honour grants.",
      "`GET /repos/{org}/{repo}/size-history?days=` — the compressed size of the newest image pushed each day; the repository page charts it for members.",
      "Notation signatures: referrers of type `application/vnd.cncf.notary.signature` are recognised (`format: notation` in attestation and signature responses), their JWS envelope verified against the embedded certificate, and counted as verified when the signing certificate or its issuer is in the trust store — trusted signing keys now accept X.509 certificate PEMs.",
    ],
  },
  {
    revision: "2026-09-06.9",
    changes: [
      "Webhook format `custom` with `payloadTemplate`: a JSON body of your own with {{placeholders}} (repository, organization, tag, digest, reference, registry, actor, timestamp, deliveryId, event.<path>); a value that is exactly \"{{event}}\" embeds the whole event. Webhook responses carry `payloadTemplate` (null for other formats).",
    ],
  },
  {
    revision: "2026-09-06.8",
    changes: [
      "Webhook format `none`: the delivery is the bare request (method of your choice, headers, authentication) with no body — for deploy hooks that read their parameters from the URL and would misread the payload, such as a PaaS deploy endpoint.",
    ],
  },
  {
    revision: "2026-09-06.7",
    changes: [
      "Webhooks accept `method: GET`: the delivery carries no body (event and delivery id stay in the headers, authentication applies as before), for receivers that act on the request itself — a deploy hook, say.",
    ],
  },
  {
    revision: "2026-09-06.6",
    changes: [
      "Scan workers: Administration → Scanning → \"Offload scans to workers\" (SCAN_WORKERS, SCAN_WORKER_TOKEN) hands Trivy scans to external workers over the internal worker protocol (`POST /api/internal/worker/claim`, `/heartbeat`, `/tasks/<id>/result`, `/tasks/<id>/fail`, bearer token; not part of /api/v1). The worker is a separate program (scan-worker); the protocol is documented in the README. Without a worker online, scans run inline as before. No /api/v1 change.",
      "TRIVY_SERVER_TOKEN (environment only) authenticates the web container and the bundled `trivy` server profile to a Trivy server started with `--token`, so one vulnerability database can serve every replica and every scan worker.",
    ],
  },
  {
    revision: "2026-09-06.5",
    changes: [
      "The Attestations tab shows the cosign/oras sign-and-attach commands only to viewers who may push to the repository (owner, admin or member of a non-proxy organization, instance administrators); everyone else sees a plain note. No API change.",
    ],
  },
  {
    revision: "2026-09-06.4",
    changes: [
      "The library organization is virtual in the UI: no list, search result, dashboard entry, notification, audit label or job result shows a `library/` prefix, and `/<name>` opens the top-level repository. Storage and the `/orgs/library/…` routes are unchanged; `path` and `reference` fields already omitted the prefix.",
      "Explore opens with an overview — trending repositories (pulls in the last 7 days), organizations busiest first with drill-down, recently updated — and `?view=all` is the filterable list. No API change.",
      "Anonymous calls to the header search typeahead (`/api/search`) count against the anonymous API rate limit per address (`RATE_LIMIT_API_ANONYMOUS`).",
    ],
  },
  {
    revision: "2026-09-06.3",
    changes: [
      "Editions: Administration → Branding (INSTANCE_EDITION as default) switches the landing page between self-hosted wording and a hosted service — sign-up as the call to action, the free plan named from the default limits, a link to the account portal's plans. No API change.",
      "Browsing without an account: Explore, search, organization pages and public repositories open for visitors without a session, in a reduced shell with sign-in and sign-up; pages that need a user still redirect to sign-in. No API change.",
    ],
  },
  {
    revision: "2026-09-06.2",
    changes: [
      "Storage enforcement: the quota-enforce job (Administration → Jobs, POST /api/jobs/quota-enforce) notifies organizations and accounts above their storage limit and, after graceDays, removes the oldest images until the limit is met, protected tags excepted, then runs garbage collection. New notification and organization webhook events quota.exceeded and quota.pruned.",
    ],
  },
  {
    revision: "2026-09-06.1",
    changes: [
      "Changed: the plan card on Settings and Organization → Settings appears only while an account portal is configured; a self-hosted registry with plain limits shows users nothing about them. The label on limits rows is documented accordingly.",
    ],
  },
  {
    revision: "2026-09-05.5",
    changes: [
      "Changed: an organization's own limit governs it alone. When an organization has a storage or repository limit of its own, the owners' account limits are not consulted for it and its usage does not count against their accounts; account limits cover the owner's organizations without such a limit. GET /me/usage and GET /users/{userId}/usage report that pool. Enforced the same way by registryd at push time.",
      "OpenAPI: `integer | null` body fields are typed as nullable integers, and enums with null carry a JSON null instead of the string \"null\".",
    ],
  },
  {
    revision: "2026-09-05.4",
    changes: [
      "Member limit: organizations can be capped at a number of members (Administration → Organizations → Limits, maxMembers); an open invitation holds a seat. Enforced when inviting, accepting an invitation, adding a member and on group-binding logins. GET /orgs/{org}/usage reports members and maxMembers.",
      "Usage: GET /orgs/{org}/usage and the new GET /me/usage carry the month's traffic (pullBytes, redirectBytes, pushBytes, blobPulls, manifestPulls; ?month=YYYY-MM) and the label administrators gave the limits.",
      "Administration: GET /users (exact email or search), GET /users/{userId}, GET /users/{userId}/organizations, GET /users/{userId}/usage; GET/PATCH/DELETE /orgs/{org}/limits and /users/{userId}/limits read, change and drop limits rows, including a label shown to the owner and an administrators-only note.",
      "Default limits: Administration → Limits gives every new account and organization a limits row (DEFAULT_USER_MAX_ORGANIZATIONS, DEFAULT_USER_MAX_PUBLIC_REPOS, DEFAULT_USER_MAX_PRIVATE_REPOS, DEFAULT_USER_MAX_STORAGE_GIB, DEFAULT_ORG_MAX_PUBLIC_REPOS, DEFAULT_ORG_MAX_PRIVATE_REPOS, DEFAULT_ORG_MAX_STORAGE_GIB, DEFAULT_ORG_MAX_MEMBERS as defaults).",
      "Account portal: Administration → Limits (PORTAL_URL, PORTAL_LABEL as defaults) adds a Manage button to the account and organization settings that opens the portal with a one-time token; the portal verifies it with POST /api/auth/one-time-token/verify.",
    ],
  },
  {
    revision: "2026-09-05.3",
    changes: [
      "Retag: PUT /repos/{org}/{repo}/tags/{tag} points a tag at an image already in the repository.",
      "Promote: POST …/tags/{tag}/copy and POST …/manifests/{digest}/copy copy an image (with variants and attached artifacts) into another repository, creating it when missing.",
      "Scan gate: GET …/manifests/{digest}/scan waits for a running scan and judges it against a threshold (wait, fail_on, unrated); POST …/scan accepts the same parameters to queue and wait in one call.",
      "A composite GitHub Action, .github/actions/scan-gate, fails a job on the gate's verdict.",
      "Organizations: create, rename and delete; usage against limits; policies (default visibility, pull policy, signature policy, member keys) to read and change.",
      "Service accounts: list, create (secret returned once), details, delete and rotate.",
      "Members and invitations: change roles, remove members, list, create and cancel invitations.",
      "Webhooks: list, create, read, update, delete and test, for organizations and repositories.",
      "Repository policies: read the effective pull and signature policy, change the overrides.",
      "Exports: GET …/vulnerabilities?format=sarif (SARIF 2.1.0) and ?format=vex (CycloneDX 1.5 VEX) for security dashboards and GitHub code scanning.",
      "Conditional requests: GET answers carry a weak ETag and honour If-None-Match with 304.",
      "The OpenAPI document is validated by npm run lint, and administrators see a notice on the overview when the API revision changed since they last acknowledged it.",
      "Rate limits: requests are counted per credential (per address anonymously) in windows set under Administration → Rate limits (RATE_LIMIT_API_AUTHENTICATED, RATE_LIMIT_API_ANONYMOUS); over the limit the API answers 429 with the new code rate_limited and Retry-After, and every answer carries X-RateLimit-Limit / -Remaining / -Reset.",
      "Metrics: chicoree_api_requests_total{endpoint,method,status,credential} on the Prometheus endpoint.",
      "Deprecation policy: endpoints that are going away carry Deprecation, Sunset and Link headers and are marked in the docs for at least one revision before removal.",
      "Keyless CI authentication: POST /auth/exchange trades a workflow's OIDC token (GitHub Actions, GitLab, any trusted issuer) for a short-lived chc_ci_ credential that works for the API and docker login; organizations manage the trusted identities under /orgs/{org}/ci-identities and in Organization → Service accounts. A login GitHub Action (.github/actions/login) wraps the exchange.",
    ],
  },
  {
    revision: "2026-09-05.2",
    changes: [
      "Administrators can switch the API off (Administration → Auth providers → Access, default from API_ENABLED); every endpoint then answers 403 with the new error code api_disabled.",
    ],
  },
  {
    revision: "2026-09-05.1",
    changes: [
      "Initial release of the REST API under /api/v1.",
      "Organizations: list, details, repositories, members and the audit log.",
      "Repositories: create, read, update and delete; tags; untagged manifests; stars.",
      "Images: manifest details with config, layers and variants; delete by tag or digest; vulnerabilities; signatures, SBOMs and provenance; queue a scan.",
      "Search across repositories, tags, digests and organizations.",
      "Personal access tokens, service accounts and the browser session authenticate; read-only tokens are refused on writes.",
    ],
  },
];

export const API_REVISION = API_CHANGELOG[0].revision;

/** Shown wherever the API is documented and in the GET /api/v1 index. */
export const API_NOTICE =
  "This API follows the registry's features: whenever a feature is added, changed or removed, " +
  "the endpoints that expose it and this documentation change with it in the same release. " +
  "The revision moves every time — compare it with the changelog before relying on a new field, " +
  "and read the changelog before upgrading.";
