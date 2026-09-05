// Branding and announcements: pure types, defaults and validation shared by
// the server (settings, layout) and the admin page's live preview.

export type AnnouncementLevel = "info" | "warning" | "danger";

export interface FooterLink {
  label: string;
  url: string;
}

export interface Announcement {
  enabled: boolean;
  level: AnnouncementLevel;
  /** Plain text, at most ANNOUNCEMENT_MAX_CHARS characters. */
  text: string;
  /** Ignored for "danger": those can never be dismissed. */
  dismissible: boolean;
}

export interface BrandingSettings {
  instanceName: string;
  tagline: string;
  /** An image as a data: URL (≤ LOGO_MAX_BYTES, one of LOGO_MEDIA_TYPES), or "" for the built-in mark. */
  logoDataUrl: string;
  /** #rrggbb, or "" for the default. Applied as the --brand token. */
  accentColor: string;
  footerLinks: FooterLink[];
  announcement: Announcement;
  /**
   * Fall back to gravatar.com for accounts without an uploaded avatar. Off by
   * default: it sends a hash of the address to a third party the moment a
   * page renders that person.
   */
  gravatar: boolean;
  /**
   * Instance default for listing what belongs to something else next to
   * images: members of an index (platform variants, BuildKit attestation
   * entries) and attached artifacts in the untagged list, cosign
   * tag-convention tags (sha256-….sig / .att / .sbom) in tag lists,
   * attestation entries in variants tables. Off by default — everything
   * stays on the index page, the Attestations tab and by URL. Users override
   * it per account (user_settings.show_artifacts).
   */
  showArtifacts: boolean;
}

export const DEFAULT_BRANDING: BrandingSettings = {
  instanceName: "Chicorée",
  tagline: "Self-hosted OCI container registry",
  logoDataUrl: "",
  accentColor: "",
  footerLinks: [],
  gravatar: false,
  showArtifacts: false,
  announcement: { enabled: false, level: "info", text: "", dismissible: true },
};

/**
 * Picture size cap, shared by the instance logo and the organization,
 * repository and user pictures (see lib/logo-shared.ts).
 */
export const LOGO_MAX_BYTES = 64 * 1024;

/** Everything an uploaded picture may be. Rasters are stored as-is; SVGs are checked for scripting. */
export const LOGO_MEDIA_TYPES = ["image/png", "image/svg+xml", "image/jpeg", "image/webp"] as const;

export type LogoMediaType = (typeof LOGO_MEDIA_TYPES)[number];

/** `accept` attribute for the file inputs. */
export const LOGO_ACCEPT = LOGO_MEDIA_TYPES.join(",");

/** Human-readable format list for upload buttons and error messages. */
export const LOGO_FORMATS_LABEL = "PNG, SVG, JPEG or WebP";

export const ANNOUNCEMENT_MAX_CHARS = 500;
export const FOOTER_LINKS_MAX = 6;
export const INSTANCE_NAME_MAX = 60;
export const TAGLINE_MAX = 120;

export const ANNOUNCEMENT_LEVELS: { value: AnnouncementLevel; label: string }[] = [
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "danger", label: "Danger (cannot be dismissed)" },
];

export function isHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** FNV-1a over the banner content: the dismissal key, so edited text shows again. */
export function announcementHash(a: Pick<Announcement, "level" | "text">): string {
  let h = 0x811c9dc5;
  const s = `${a.level}\n${a.text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** The announcement can be closed by the reader (danger banners never can). */
export function announcementDismissible(a: Announcement): boolean {
  return a.level !== "danger" && a.dismissible;
}

export interface ParsedLogo {
  mediaType: LogoMediaType;
  /** Whitespace-stripped payload, exactly as it should be stored. */
  base64: string;
  bytes: Uint8Array;
}

/** Split a `data:` URL into its media type and bytes; null when it is not a format we accept. */
export function parseLogoDataUrl(dataUrl: string): ParsedLogo | null {
  const m = /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]*)$/i.exec(dataUrl ?? "");
  if (!m) return null;
  const mediaType = m[1].toLowerCase() as LogoMediaType;
  if (!(LOGO_MEDIA_TYPES as readonly string[]).includes(mediaType)) return null;
  const base64 = m[2].replace(/\s+/g, "");
  if (!base64) return null;
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch {
    return null;
  }
  return { mediaType, base64, bytes };
}

function startsWith(bytes: Uint8Array, magic: number[], at = 0): boolean {
  if (bytes.length < at + magic.length) return false;
  return magic.every((b, i) => bytes[at + i] === b);
}

/**
 * Validate an uploaded picture given as a data URL: one of LOGO_MEDIA_TYPES,
 * inside the size cap, with bytes that really are that format, and — for SVGs
 * — free of scripts, event handlers and external references (an SVG is either
 * inlined in the page or served straight back to the browser).
 *
 * One implementation for all four uses: the instance logo and the
 * organization, repository and user pictures. It runs on the client for live
 * feedback and again on the server, which is the check that counts.
 */
export function validateLogoDataUrl(dataUrl: string): { ok: true } | { ok: false; error: string } {
  const parsed = parseLogoDataUrl(dataUrl);
  if (!parsed) return { ok: false, error: `The picture must be a ${LOGO_FORMATS_LABEL} file.` };
  const { mediaType, bytes: decoded } = parsed;
  if (decoded.length > LOGO_MAX_BYTES) return { ok: false, error: `The picture must be ${LOGO_MAX_BYTES / 1024} KB or smaller.` };
  if (decoded.length === 0) return { ok: false, error: "The picture file is empty." };
  switch (mediaType) {
    case "image/png":
      if (!startsWith(decoded, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
        return { ok: false, error: "That file is not a PNG image." };
      }
      break;
    case "image/jpeg":
      if (!startsWith(decoded, [0xff, 0xd8, 0xff])) return { ok: false, error: "That file is not a JPEG image." };
      break;
    case "image/webp":
      // "RIFF" ....size.... "WEBP"
      if (!startsWith(decoded, [0x52, 0x49, 0x46, 0x46]) || !startsWith(decoded, [0x57, 0x45, 0x42, 0x50], 8)) {
        return { ok: false, error: "That file is not a WebP image." };
      }
      break;
    case "image/svg+xml": {
      const text = new TextDecoder().decode(decoded).toLowerCase();
      if (!text.includes("<svg")) return { ok: false, error: "That file is not an SVG image." };
      // The optional quote lives inside the lookahead: outside it, backtracking
      // would let a quoted `#fragment` / inline `data:image` reference match
      // the "external reference" branch and be rejected.
      if (/<script|javascript:|on[a-z]+\s*=|<foreignobject|<iframe|<embed|<object|xlink:href\s*=\s*(?!["']?\s*(?:#|data:image))/.test(text)) {
        return { ok: false, error: "SVG pictures must not contain scripts, event handlers or external references." };
      }
      break;
    }
  }
  return { ok: true };
}

function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Normalise a footer link list from user input; drops invalid entries, caps the count. */
export function sanitizeFooterLinks(links: { label?: unknown; url?: unknown }[]): FooterLink[] {
  const out: FooterLink[] = [];
  for (const l of links) {
    const label = String(l.label ?? "").trim().slice(0, 40);
    const url = String(l.url ?? "").trim();
    if (!label || !url) continue;
    if (!/^(https?:\/\/|mailto:|\/)/i.test(url)) continue;
    out.push({ label, url });
    if (out.length >= FOOTER_LINKS_MAX) break;
  }
  return out;
}
