# Pagination

Every long list in the web app is paged. Nothing is silently truncated any
more: a list either shows a page of a known total, or it says in its heading
that it is a deliberate top-N.

---

## README-ready: what pages, and how

### Using it

Server-rendered lists page through the URL, so a page is a link you can share
and it survives a reload. Each control shows the slice and the total —
`151–200 of 334 entries` — with previous / next and, on wider screens, page
numbers. Filters are kept when you change page; changing a filter starts over
at page 1.

Screens that hold more than one list give each list its own search parameter,
so paging the tags of a repository does not move its untagged manifests:
`/acme/alpine?tags=3&untagged=2`.

A page number past the end (a stale link, or a filter that shrank the list)
lands on the last page instead of on an empty table.

### What pages, and how big a page is

| Where | List | Rows / page | URL parameter |
| --- | --- | --- | --- |
| `/admin/audit`, `/<org>/audit` | Audit entries | 50 | `page` |
| `/admin/security` | CVE / package search results | 50 | `page` |
| `/admin/security`, `/<org>/security` | Blocked images | 25 | `blocked` |
| `/admin/security`, `/<org>/security` | Accepted risks (exceptions) | 25 | `exc` |
| `/admin/jobs` | Runs across every job | 25 | `page` |
| `/admin/jobs/<job>` | Runs of one job | 25 | `page` |
| `/admin/users` | Users | 50 | `page` |
| `/admin/organizations` | Organizations | 50 | `page` |
| `/<org>` | Repositories | 25 | `page` |
| `/<org>/<repo>` | Tags | 50 | `tags` |
| `/<org>/<repo>` | Untagged manifests | 50 | `untagged` |
| `/<org>/<repo>/settings/mirror` | Mirror runs | 5 | `runs` |
| `/dashboard` | Recent activity | 12 | `activity` |
| `/explore` | Repositories | 30 | `page` |
| `/search` | Repositories / tags / digests / organizations | 20 each | `repos`, `tags`, `digests`, `orgs` |

Three lists filter in the browser and therefore page in the component, with no
URL parameter:

| Where | List | Rows / page |
| --- | --- | --- |
| Image → Vulnerabilities | Findings | 25 / 50 / 100 (chosen next to the pager, default 50) |
| Repository / organization settings → Webhooks | Delivery log of one hook | 10 |
| Repository settings → Mirror | Per-tag lines inside one run | 50 |

The findings table filters by severity, "fix available", "hide accepted" and a
search box; the pager works over the filtered set and returns to page 1
whenever a filter or the search text changes.

The webhook delivery log is pruned to the newest 50 deliveries per hook when a
delivery is recorded, so its five pages are the whole log.

### Lists that are deliberately short

Some tables are a top-N by design and say so in their heading rather than
pretending to be complete:

- Administration → Metrics: *Top 8 by egress*, *Top 8 by pulls*, *Top 8 by size*.
- Security: *Top 10 most affected* repositories.
- The dashboard's *Starred* and *Recently viewed* cards stay compact lists with
  a "Show all" toggle.

Per-organization tables (metrics → traffic and storage by organization) list
every organization; `/admin/organizations` is the paged view of the same set.

---

## ARCHITECTURE-ready notes

### `lib/paginate-shared.ts` — the one source of paging truth

Pure module (no `@/db`, no Node built-ins), imported by server queries, server
components and client components alike.

- `PAGE_SIZES` — the page size of every list, in one object. `FINDINGS_PAGE_SIZES`
  holds the 25/50/100 choices of the findings table; `WEBHOOK_LOG_MAX` (50) is
  the per-hook cap the delivery writer prunes to and the reader honours.
- `parsePage(value)` / `pageParam(params, key)` — a page number out of a search
  parameter: positive safe integers only, anything else is page 1. Arrays
  (`?page=2&page=9`) take the first value.
- `paginate(total, page, pageSize) → PageState` — clamps the requested page
  into `1…pages` and derives `offset`, `first`, `last`, `hasPrev`, `hasNext`.
  `PageState` is a plain object, so a server component can hand it to a client
  component.
- `paginatedQuery({ page, pageSize, count, rows })` — runs the `COUNT(*)` and
  the `LIMIT/OFFSET` slice in parallel and returns `{ rows, state }`. If the
  requested page turned out to be past the end, it re-reads the last page —
  the only case where a list issues a second slice query.
- `pageSlice(rows, page, pageSize)` — the same clamping for lists already in
  memory (the client-filtered lists).
- `pageHref(basePath, params, page, key)` — builds a page link that keeps every
  other query parameter (filters, search terms, tabs, a sibling list's page)
  and drops the parameter entirely on page 1, so the first page has the plain
  URL. Blank and `false` values are dropped; arrays are re-appended.
- `pageWindow(page, pages, max = 7)` — the page numbers to render, `0` marking
  an ellipsis. Always contains the first, last and current page and never more
  than `max` entries, so the control cannot grow wide enough to overflow.
- `rangeLabel(state, noun)` — `"151–200 of 334 entries"`, `"9 tags"`, `"No entries"`.

### `components/ui/pagination.tsx` — the one control

Two exports, `Pagination` and `PaginationFooter` (the same control wrapped in a
card footer). The component holds no state and calls no hooks, so the same file
renders in server components and in client components.

It has two modes, both driven by serializable props only:

- **URL mode** — `basePath` plus the page's `params` (and an optional
  `paramKey`); renders `next/link` anchors built with `pageHref`. Ends render
  as `<span aria-disabled="true">` rather than dead links.
- **Component mode** — `onPage(page)`; renders buttons. `pageSizeOptions` +
  `onPageSize` add the rows-per-page select used by the findings table.

Because the props are plain data, a server page can pass its `searchParams`
straight through to a client component (mirror manager, exceptions table) and
that component can still build correct hrefs.

Markup: `<nav aria-label=… data-pagination data-page data-pages data-total>`
with the range in `[data-pagination-range]` — the data attributes are what the
browser checks assert on. The range label sits on the left, the controls on the
right; page numbers are `hidden sm:flex` and a compact `page/pages` counter
takes their place below `sm`, which is what keeps 390 px free of horizontal
overflow.

### Query shape

Every paged list is one `COUNT(*)` plus one `LIMIT/OFFSET` slice over the same
`WHERE` clause, built once and shared by both, so a filter can never drift
between the count and the rows. The queries live next to the list they serve:

- `lib/audit-query.ts` — `queryAudit` now returns `{ rows, total, state }`.
- `lib/security.ts` — `blockedImages`, `listExceptions`, `searchFindings`.
- `lib/jobs.ts` — `jobRunsPage({ job, page })` (`recentJobRuns` stays for the
  admin overview card and `/api/jobs*`).
- `lib/data.ts` — `listAdminUsers`, `orgReposPage`, `recentActivity`,
  `listRepoTags`, plus `repoTagOverview`.
- `lib/admin-data.ts` — `listAdminOrganizations`.
- `lib/manifests.ts` — `untaggedManifestsPage` (`listUntaggedManifests` still
  returns everything; the retention planner needs the complete set).
- `lib/search.ts` — `searchRepositoriesPage`, `searchTagsPage`,
  `searchDigestsPage`, `searchOrganizationsPage`; `searchAll(viewer, q, pages)`
  returns each group as `{ rows, state }` and a `total` summed over the four
  group totals.

Two supporting changes:

- `repoTagOverview(repoId)` is one query returning the tag count, the newest
  tag names (capped at `COMPARE_TAG_LIMIT` = 500, for the compare selector),
  the digest of `latest` and the newest proxy check. The repository page used
  to derive those three values by scanning the full tag list; now the page
  loads only the 50 tags it renders. The compare page uses the same helper
  instead of loading every tag row.
- `listWebhookRows` no longer runs one delivery query per hook. A single
  `row_number() OVER (PARTITION BY webhook_id ORDER BY created_at DESC)` query
  reads the complete (≤ `WEBHOOK_LOG_MAX`) log of every hook of the scope; the
  manager pages it in the browser, where the log is opened and closed.

### Resetting to page 1

No filter form carries a page field, so submitting one produces a URL without
the page parameter and the list starts over at page 1 — that is true of the
audit filters, the CVE search box, the explore filters and the global search
box. Client-filtered lists reset explicitly (`useEffect` on the filter object
in the findings table).

### No schema change

Pagination is read-side only: no new tables, columns, env vars, endpoints or
jobs, and no migration.
