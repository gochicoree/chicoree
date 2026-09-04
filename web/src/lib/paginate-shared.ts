// Pagination: the one place that knows how a page is read from the URL, how
// big a page of each list is, and how a page link is built. Pure helpers, no
// database imports — client components import this too.

/** Values a query object may carry; arrays and blanks are handled for you. */
export type QueryValue = string | number | boolean | null | undefined | string[];
export type QueryLike = Record<string, QueryValue> | URLSearchParams;

/**
 * Rows per page of every paginated list, in one place. Lists that share a
 * component share an entry.
 */
export const PAGE_SIZES = {
  /** Audit log (admin and organization). */
  audit: 50,
  /** CVE / package search on the security pages. */
  cveSearch: 50,
  /** Images the pull policy blocks. */
  blockedImages: 25,
  /** Accepted risks (vulnerability exceptions). */
  exceptions: 25,
  /** Findings of one image (client-side filtering; see FINDINGS_PAGE_SIZES). */
  findings: 50,
  /** Background job runs. */
  jobRuns: 25,
  /** Webhook deliveries of one hook. */
  webhookDeliveries: 10,
  /** Mirror runs of one repository. */
  mirrorRuns: 5,
  /** Per-tag log lines inside one mirror run. */
  mirrorLog: 50,
  /** Instance users. */
  users: 50,
  /** Instance organizations. */
  organizations: 50,
  /** Tags of a repository. */
  tags: 50,
  /** Untagged manifests of a repository. */
  untagged: 50,
  /** Push / delete activity feeds. */
  activity: 12,
  /** Repository lists (organization page). */
  repositories: 25,
  /** One group of the search results page. */
  search: 20,
  /** Explore. */
  explore: 30,
} as const;

/** Rows-per-page choices offered on the findings table. */
export const FINDINGS_PAGE_SIZES = [25, 50, 100] as const;

/** The webhook delivery log is pruned to this many rows per hook on write. */
export const WEBHOOK_LOG_MAX = 50;

/** A positive integer page number, or 1 for anything else. */
export function parsePage(value: unknown): number {
  const first = Array.isArray(value) ? value[0] : value;
  const n = typeof first === "number" ? first : Number(String(first ?? "").trim());
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

function read(params: QueryLike, key: string): QueryValue {
  return params instanceof URLSearchParams ? params.get(key) : params[key];
}

/** The page a URL asks for, e.g. pageParam(searchParams, "tags"). */
export function pageParam(params: QueryLike | undefined, key = "page"): number {
  return params ? parsePage(read(params, key)) : 1;
}

/** Everything a control and a query need to render and slice one page. */
export interface PageState {
  /** The page actually shown: clamped to 1…pages. */
  page: number;
  pageSize: number;
  /** Rows matching the filter, across every page. */
  total: number;
  /** Number of pages, at least 1. */
  pages: number;
  /** Rows to skip for this page (SQL OFFSET). */
  offset: number;
  /** 1-based index of the first row on this page (0 when empty). */
  first: number;
  /** 1-based index of the last row on this page (0 when empty). */
  last: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/** Clamp a requested page against a known total. */
export function paginate(total: number, requestedPage: number, pageSize: number): PageState {
  const size = Math.max(1, Math.trunc(pageSize) || 1);
  const count = Math.max(0, Math.trunc(total) || 0);
  const pages = Math.max(1, Math.ceil(count / size));
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), pages);
  const offset = (page - 1) * size;
  const first = count === 0 ? 0 : offset + 1;
  const last = Math.min(count, offset + size);
  return { page, pageSize: size, total: count, pages, offset, first, last, hasPrev: page > 1, hasNext: page < pages };
}

/**
 * Slice a list that is already in memory (client-side filtering) — same
 * clamping as the server queries.
 */
export function pageSlice<T>(rows: T[], requestedPage: number, pageSize: number): { rows: T[]; state: PageState } {
  const state = paginate(rows.length, requestedPage, pageSize);
  return { rows: rows.slice(state.offset, state.offset + state.pageSize), state };
}

/**
 * Run one COUNT and one LIMIT/OFFSET slice in parallel. A page past the end
 * (a stale link, a filter that shrank) re-reads the last page instead of
 * showing nothing.
 */
export async function paginatedQuery<T>(opts: {
  page: number;
  pageSize: number;
  count: () => Promise<number>;
  rows: (limit: number, offset: number) => Promise<T[]>;
}): Promise<{ rows: T[]; state: PageState }> {
  const size = Math.max(1, Math.trunc(opts.pageSize) || 1);
  const requested = Math.max(1, Math.trunc(opts.page) || 1);
  const [rows, total] = await Promise.all([opts.rows(size, (requested - 1) * size), opts.count()]);
  const state = paginate(total, requested, size);
  if (state.page === requested) return { rows, state };
  return { rows: await opts.rows(size, state.offset), state };
}

function entries(params: QueryLike): [string, QueryValue][] {
  return params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
}

/**
 * A link to another page that keeps every other query parameter (filters,
 * search terms, the page of a second list on the same screen). Page 1 drops
 * the parameter so the first page has the plain URL.
 */
export function pageHref(basePath: string, params: QueryLike | undefined, page: number, key = "page"): string {
  const out = new URLSearchParams();
  for (const [k, v] of entries(params ?? {})) {
    if (k === key || v === undefined || v === null || v === false) continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      const s = String(item);
      if (s !== "") out.append(k, s);
    }
  }
  if (page > 1) out.set(key, String(page));
  const qs = out.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * The page numbers to show around the current one, with 0 standing in for a
 * gap ("…"). Always includes the first page, the last page and the current
 * one, and never more than `max` entries — so the control cannot grow wide
 * enough to overflow.
 */
export function pageWindow(page: number, pages: number, max = 7): number[] {
  if (pages <= max) return Array.from({ length: pages }, (_, i) => i + 1);
  // first + last + up to two gap markers leave `inner` numbers in the middle
  const inner = Math.max(1, max - 4);
  const first = Math.min(Math.max(2, page - Math.floor(inner / 2)), pages - inner);
  const last = first + inner - 1;
  const out: number[] = [1];
  if (first > 2) out.push(0);
  for (let p = first; p <= last; p++) out.push(p);
  if (last < pages - 1) out.push(0);
  out.push(pages);
  return out;
}

/** One of the offered page sizes, or the fallback. */
export function clampPageSize(value: unknown, options: readonly number[], fallback: number): number {
  const n = parsePage(value);
  return options.includes(n) ? n : fallback;
}

/** "1–50 of 312" (or "No entries"), the label the control shows. */
export function rangeLabel(state: PageState, noun = "rows"): string {
  if (state.total === 0) return `No ${noun}`;
  const n = state.total.toLocaleString("en-US");
  if (state.total <= state.pageSize) return `${n} ${noun}`;
  return `${state.first.toLocaleString("en-US")}–${state.last.toLocaleString("en-US")} of ${n} ${noun}`;
}
