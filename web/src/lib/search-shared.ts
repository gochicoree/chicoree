// Search: pure helpers and types shared by the API route, the results page
// and the header search box (no database imports here).

export type SearchHitKind = "repository" | "tag" | "digest" | "organization";

/** One row of the typeahead dropdown / a mixed result list. */
export interface SearchHit {
  kind: SearchHitKind;
  /** Main text: "acme/alpine", "acme/alpine:3.20", "sha256:9f8e…", "Acme Corp". */
  label: string;
  href: string;
  /** Secondary line (description, digest, slug). */
  detail?: string;
  /** Right-aligned hint (visibility, pulls, relative time). */
  meta?: string;
}

export const SEARCH_MAX_QUERY = 120;
/** Typeahead only asks the server from this many characters on. */
export const SEARCH_MIN_TYPEAHEAD = 2;
export const SEARCH_TYPEAHEAD_LIMIT = 8;

/** Trim, collapse whitespace and cap the length of a raw query. */
export function normalizeQuery(raw: string | null | undefined): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_MAX_QUERY);
}

/**
 * A query that looks like a content digest: `sha256:<hex>` or a bare hex
 * string of at least 12 characters. Returns the lowercase hex prefix.
 */
export function digestQuery(q: string): { hex: string; exact: boolean } | null {
  const m = /^(?:sha256:)?([0-9a-fA-F]{12,64})$/.exec(q.trim());
  if (!m) return null;
  const hex = m[1].toLowerCase();
  return { hex, exact: hex.length === 64 };
}

/**
 * `repo:tag` syntax: everything after the last colon is a tag pattern when
 * it contains no slash (so `sha256:…` and bare words are left alone).
 */
export function splitTagQuery(q: string): { repo: string; tag: string } | null {
  const i = q.lastIndexOf(":");
  if (i <= 0 || i === q.length - 1) return null;
  const tag = q.slice(i + 1);
  if (tag.includes("/") || q.startsWith("sha256:")) return null;
  return { repo: q.slice(0, i), tag };
}

/** Escape `%`, `_` and `\` so the text is matched literally by ILIKE. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const KIND_LABEL: Record<SearchHitKind, string> = {
  repository: "Repository",
  tag: "Tag",
  digest: "Digest",
  organization: "Organization",
};

export function searchHref(q: string): string {
  return `/search?q=${encodeURIComponent(q)}`;
}
