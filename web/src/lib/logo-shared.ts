// Organization, repository and user pictures: pure helpers shared by the
// server queries, the route handler and the client components.
//
// A picture is stored as a data: URL in one column (organization.logo,
// repositories.logo, user.image) but is never inlined into a listing — pages
// carry only a LogoRef and the browser fetches the bytes from
// /api/logo/<kind>/<id>?v=<version>. The version is the first
// LOGO_VERSION_LENGTH hex digits of the MD5 of the stored data URL, so
// replacing a picture changes the URL and busts every cache.
import { LOGO_MAX_BYTES } from "./branding-shared";

export type LogoKind = "organization" | "repository" | "user";

export const LOGO_KINDS: readonly LogoKind[] = ["organization", "repository", "user"];

/** How much of the MD5 the cache-busting query parameter carries. */
export const LOGO_VERSION_LENGTH = 8;

/** Everything a page needs to point at a picture: no bytes, just an address. */
export interface LogoRef {
  kind: LogoKind;
  id: string;
  /** First LOGO_VERSION_LENGTH hex digits of the MD5 of the stored data URL. */
  version: string;
}

export function isLogoKind(value: string): value is LogoKind {
  return (LOGO_KINDS as readonly string[]).includes(value);
}

/** The route that serves the picture. Immutable for a given version. */
export function logoSrc(ref: LogoRef): string {
  return `/api/logo/${ref.kind}/${encodeURIComponent(ref.id)}?v=${encodeURIComponent(ref.version)}`;
}

/**
 * Build a ref from a query row: `version` is null/empty whenever the entity
 * has no picture, which is what the listing SQL returns.
 */
export function logoRef(kind: LogoKind, id: string | null | undefined, version: unknown): LogoRef | null {
  if (!id) return null;
  const v = typeof version === "string" ? version.trim() : "";
  if (!v) return null;
  return { kind, id, version: v };
}

/** Human-readable cap for hints and error messages. */
export const LOGO_MAX_KB = LOGO_MAX_BYTES / 1024;

export type { LogoMediaType, ParsedLogo } from "./branding-shared";
export {
  LOGO_ACCEPT,
  LOGO_FORMATS_LABEL,
  LOGO_MAX_BYTES,
  LOGO_MEDIA_TYPES,
  parseLogoDataUrl,
  validateLogoDataUrl,
} from "./branding-shared";
