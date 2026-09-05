// Server-side helpers for entity pictures (organization, repository, user).
//
// The bytes live in one text column as a data: URL. Listings never load them:
// they select only `substr(md5(<column>), 1, 8)`, which is exactly the version
// the route handler recomputes, so a replaced picture yields a different URL
// and the year-long cache entry is bypassed rather than revalidated.
import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { parseLogoDataUrl } from "./branding-shared";
import { LOGO_VERSION_LENGTH } from "./logo-shared";

/** MD5 of the stored data URL: the ETag, and the source of the `v` parameter. */
export function logoDigest(dataUrl: string): string {
  return createHash("md5").update(dataUrl, "utf8").digest("hex");
}

/** The cache-busting version of a picture, or null when there is none. */
export function logoVersionOf(dataUrl: string | null | undefined): string | null {
  return dataUrl ? logoDigest(dataUrl).slice(0, LOGO_VERSION_LENGTH) : null;
}

/**
 * The same version computed by Postgres, for raw `sql` listings:
 * `logoVersionSql("o.logo")` → `substr(md5(o.logo), 1, 8)` (null when unset).
 * `column` is always a literal in the caller, never user input.
 */
export function logoVersionSql(column: string): SQL {
  return sql.raw(`substr(md5(${column}), 1, ${LOGO_VERSION_LENGTH})`);
}

export interface DecodedLogo {
  mediaType: string;
  body: Buffer;
  etag: string;
}

/** Stored data URL → the response body, its content type and its ETag. */
export function decodeLogo(dataUrl: string): DecodedLogo | null {
  const parsed = parseLogoDataUrl(dataUrl);
  if (!parsed) return null;
  return {
    // SVGs are text; say so, or browsers guess the encoding.
    mediaType: parsed.mediaType === "image/svg+xml" ? "image/svg+xml; charset=utf-8" : parsed.mediaType,
    body: Buffer.from(parsed.base64, "base64"),
    etag: `"${logoDigest(dataUrl)}"`,
  };
}

/** RFC 9110 If-None-Match: `*` or a list containing our (strong) tag. */
export function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const value = header.trim();
  if (value === "*") return true;
  return value.split(",").some((t) => {
    const tag = t.trim();
    return tag === etag || tag === `W/${etag}`;
  });
}
