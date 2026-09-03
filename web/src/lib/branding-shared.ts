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
  /** PNG or SVG as a data: URL (≤ LOGO_MAX_BYTES), or "" for the built-in mark. */
  logoDataUrl: string;
  /** #rrggbb, or "" for the default. Applied as the --brand token. */
  accentColor: string;
  footerLinks: FooterLink[];
  announcement: Announcement;
}

export const DEFAULT_BRANDING: BrandingSettings = {
  instanceName: "Chicorée",
  tagline: "Self-hosted OCI container registry",
  logoDataUrl: "",
  accentColor: "",
  footerLinks: [],
  announcement: { enabled: false, level: "info", text: "", dismissible: true },
};

export const LOGO_MAX_BYTES = 64 * 1024;
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

/**
 * Validate an uploaded logo data URL: PNG or SVG, size cap, and no scripting
 * inside SVGs (the image is inlined in every page).
 */
export function validateLogoDataUrl(dataUrl: string): { ok: true } | { ok: false; error: string } {
  const m = /^data:(image\/png|image\/svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) return { ok: false, error: "The logo must be a PNG or SVG file." };
  const b64 = m[2].replace(/\s+/g, "");
  const bytes = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (bytes > LOGO_MAX_BYTES) return { ok: false, error: `The logo must be ${LOGO_MAX_BYTES / 1024} KB or smaller.` };
  if (bytes <= 0) return { ok: false, error: "The logo file is empty." };
  const decoded = decodeBase64(b64);
  if (m[1] === "image/png") {
    const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (decoded.length < 8 || magic.some((b, i) => decoded[i] !== b)) return { ok: false, error: "That file is not a PNG image." };
  } else {
    const text = new TextDecoder().decode(decoded).toLowerCase();
    if (!text.includes("<svg")) return { ok: false, error: "That file is not an SVG image." };
    if (/<script|javascript:|on[a-z]+\s*=|<foreignobject|<iframe|<embed|<object|xlink:href\s*=\s*["']?\s*(?!#|data:image)/.test(text)) {
      return { ok: false, error: "SVG logos must not contain scripts, event handlers or external references." };
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
