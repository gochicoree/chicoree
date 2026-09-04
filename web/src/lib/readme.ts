// Repository README rendering (Markdown → sanitized HTML) and the "About"
// fallback built from OCI image annotations / labels when no README is set.
// Server only: sanitize-html and the database live here; the client editor
// previews through the previewReadme action.
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { sql } from "drizzle-orm";
import { db } from "@/db";

const HTTPS_RE = /^https:\/\//i;

/**
 * Strict allowlist: structure, emphasis, code, tables and links. Links get
 * rel="nofollow noopener"; images must come from https (relative or http
 * sources are dropped); scripts, styles, event handlers and every other
 * attribute are discarded. Relative links stay as they are.
 */
const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr", "blockquote",
    "ul", "ol", "li",
    "pre", "code", "kbd",
    "em", "strong", "b", "i", "del", "s", "sup", "sub",
    "a", "img",
    "table", "thead", "tbody", "tr", "th", "td",
    "input",
  ],
  allowedAttributes: {
    a: ["href", "title", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    code: ["class"],
    th: ["align"],
    td: ["align"],
    ol: ["start"],
    input: ["type", "checked", "disabled"],
  },
  allowedClasses: { code: ["language-*"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["https"] },
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: "nofollow noopener" } }),
    // GFM task lists render as checkboxes; nothing else is a form control.
    input: (tagName, attribs) => ({ tagName, attribs: { type: "checkbox", disabled: "", ...(attribs.checked !== undefined ? { checked: "" } : {}) } }),
  },
  exclusiveFilter: (frame) => frame.tag === "img" && !HTTPS_RE.test(String(frame.attribs.src ?? "")),
};

/** Markdown (GFM) → HTML that is safe to inject into the page. */
export function renderReadme(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
  return sanitizeHtml(html, SANITIZE);
}

// --- About block from OCI annotations / labels --------------------------------

const OCI = "org.opencontainers.image.";

export interface ImageAbout {
  /** Tag the metadata was read from. */
  tag: string;
  description?: string;
  title?: string;
  version?: string;
  vendor?: string;
  licenses?: string;
  authors?: string;
  links: { label: string; url: string }[];
}

type Labels = Record<string, string>;

function pick(labels: Labels, key: string): string | undefined {
  const v = labels[OCI + key];
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : undefined;
}

function isHttpUrl(v: string | undefined): v is string {
  return !!v && /^https?:\/\/\S+$/i.test(v);
}

function labelsOf(config: unknown): Labels {
  const c = config as { config?: { Labels?: unknown } } | null;
  const l = c?.config?.Labels;
  return l && typeof l === "object" && !Array.isArray(l) ? (l as Labels) : {};
}

function annotationsOf(payload: string): { annotations: Labels; firstChild: string | null } {
  try {
    const p = JSON.parse(payload) as { annotations?: unknown; manifests?: { digest?: string }[] };
    const a = p.annotations && typeof p.annotations === "object" ? (p.annotations as Labels) : {};
    const firstChild = Array.isArray(p.manifests) ? (p.manifests.find((m) => m?.digest)?.digest ?? null) : null;
    return { annotations: a, firstChild };
  } catch {
    return { annotations: {}, firstChild: null };
  }
}

/**
 * Metadata of the repository's `latest` tag (else the newest tag): image
 * config labels first, manifest annotations filling the gaps. Multi-arch
 * indexes fall back to their first platform manifest for labels. Null when
 * the image carries no org.opencontainers.image.* metadata.
 */
export async function imageAbout(repositoryId: string): Promise<ImageAbout | null> {
  const { rows } = await db.execute(sql`
    SELECT t.name AS tag, m.payload, m.config
    FROM tags t JOIN manifests m ON m.repository_id = t.repository_id AND m.digest = t.manifest_digest
    WHERE t.repository_id = ${repositoryId}
    ORDER BY (t.name = 'latest') DESC, t.updated_at DESC
    LIMIT 1`);
  const row = rows[0];
  if (!row) return null;
  const { annotations, firstChild } = annotationsOf(String(row.payload));
  let labels = labelsOf(row.config);
  let childAnnotations: Labels = {};
  if (Object.keys(labels).length === 0 && firstChild) {
    const child = await db.execute(sql`
      SELECT payload, config FROM manifests WHERE repository_id = ${repositoryId} AND digest = ${firstChild} LIMIT 1`);
    const c = child.rows[0];
    if (c) {
      labels = labelsOf(c.config);
      childAnnotations = annotationsOf(String(c.payload)).annotations;
    }
  }
  const merged: Labels = { ...childAnnotations, ...annotations, ...labels };
  const about: ImageAbout = {
    tag: String(row.tag),
    description: pick(merged, "description"),
    title: pick(merged, "title"),
    version: pick(merged, "version"),
    vendor: pick(merged, "vendor"),
    licenses: pick(merged, "licenses"),
    authors: pick(merged, "authors"),
    links: [],
  };
  const source = pick(merged, "source");
  const url = pick(merged, "url");
  const documentation = pick(merged, "documentation");
  if (isHttpUrl(source)) about.links.push({ label: "Source", url: source });
  if (isHttpUrl(url) && url !== source) about.links.push({ label: "Website", url });
  if (isHttpUrl(documentation) && documentation !== source && documentation !== url) about.links.push({ label: "Documentation", url: documentation });
  const hasAnything = about.description || about.title || about.version || about.vendor || about.licenses || about.authors || about.links.length > 0;
  return hasAnything ? about : null;
}
