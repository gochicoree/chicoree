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
