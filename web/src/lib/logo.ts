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

/** Gravatar identifies an address by the SHA-256 of its trimmed lowercase form. */
export function gravatarHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
}

/**
 * Where an account's Gravatar lives. `d=404` means "nothing here" rather than
 * a generated pattern, so a person without one keeps their initials.
 */
export function gravatarUrl(email: string, size = 200): string {
  return `https://www.gravatar.com/avatar/${gravatarHash(email)}?s=${size}&d=404`;
}

/**
 * The version of a user's picture: their upload if they have one, else a
 * marker derived from the address when the instance falls back to Gravatar
 * (so the URL changes if they change address), else null for initials.
 */
export function userLogoVersion(
  user: { image?: string | null; email?: string | null },
  gravatar: boolean,
): string | null {
  const own = logoVersionOf(user.image);
  if (own) return own;
  if (!gravatar || !user.email) return null;
  // Must match userLogoVersionSql exactly, or the same person would get two
  // URLs (and two cache entries) depending on which query rendered them.
  return `g${createHash("md5").update(user.email.trim().toLowerCase(), "utf8").digest("hex").slice(0, LOGO_VERSION_LENGTH - 1)}`;
}

/** The same, in SQL, for listings that join the user table. */
export function userLogoVersionSql(imageColumn: string, emailColumn: string, gravatar: boolean): SQL {
  const own = `substr(md5(${imageColumn}), 1, ${LOGO_VERSION_LENGTH})`;
  if (!gravatar) return sql.raw(`CASE WHEN ${imageColumn} IS NOT NULL AND ${imageColumn} <> '' THEN ${own} END`);
  // The marker only has to change with the address; the route computes the
  // real Gravatar hash itself.
  const marker = `'g' || substr(md5(lower(btrim(${emailColumn}))), 1, ${LOGO_VERSION_LENGTH - 1})`;
  return sql.raw(`CASE WHEN ${imageColumn} IS NOT NULL AND ${imageColumn} <> '' THEN ${own} ELSE ${marker} END`);
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
