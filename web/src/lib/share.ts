// Share previews: what a link to this registry shows when it is pasted into
// a chat, a social feed or a wiki. Open Graph / Twitter tags come from the
// page-level generateMetadata functions, the preview images from the
// opengraph-image routes; both take their facts from here. Everything in
// this module is public by construction — a private repository yields null,
// so a crawler (always anonymous) never learns it exists.
import type { Metadata } from "next";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getBranding } from "./branding";
import { repoKindOf } from "./data";
import { env } from "./env";
import { formatCount, relativeTime } from "./format";
import type { RepoKind } from "./helm-shared";
import { configMediaType } from "./index-variant";
import { imagePath } from "./library-shared";
import { repoHref } from "./proxy-shared";
import { imageAbout } from "./readme";

/** The instance as it introduces itself on every card. */
export interface ShareInstance {
  name: string;
  tagline: string;
  /** Registry host for pull commands (REGISTRY_HOST). */
  host: string;
  /** Uploaded logo as a data URL when the card renderer can draw it. */
  logoDataUrl: string | null;
  /** #rrggbb accent for the mark and the strata. */
  accent: string;
}

export const DEFAULT_ACCENT = "#3d68c7";

export async function shareInstance(): Promise<ShareInstance> {
  const b = await getBranding();
  return {
    name: b.instanceName,
    tagline: b.tagline,
    host: env.registryHost,
    logoDataUrl: drawableDataUrl(b.logoDataUrl),
    accent: /^#[0-9a-fA-F]{6}$/.test(b.accentColor) ? b.accentColor : DEFAULT_ACCENT,
  };
}

/** Pictures the card renderer (satori + resvg) can rasterise; WebP is not among them. */
export function drawableDataUrl(dataUrl: string | null | undefined): string | null {
  if (!dataUrl) return null;
  return /^data:image\/(png|jpeg|svg\+xml);/.test(dataUrl) ? dataUrl : null;
}

export interface RepoShare {
  id: string;
  orgSlug: string;
  orgName: string;
  name: string;
  /** What people type: `nginx` for the library, `acme/api` elsewhere. */
  path: string;
  /** The page, relative to the site root. */
  href: string;
  /** Hand-written description, README excerpt or OCI description — may be empty. */
  description: string;
  kind: RepoKind;
  tagCount: number;
  pullCount: number;
  lastPushedAt: Date | null;
  /** Repository picture, else the organization's, when drawable. */
  logoDataUrl: string | null;
}

// cosign's tag convention: never counted as tags people care about.
const ARTIFACT_TAG = "^sha256-[0-9a-f]{64}\\.(sig|att|sbom)$";

/** A public repository's share facts, or null when it is private or missing. */
export async function repoShare(orgSlug: string, repoName: string): Promise<RepoShare | null> {
  const { rows } = await db.execute(sql`
    SELECT r.id, r.name, r.description, r.pull_count, r.readme, r.logo, o.name AS org_name, o.logo AS org_logo,
      (SELECT count(*)::int FROM tags t WHERE t.repository_id = r.id AND t.name !~ ${ARTIFACT_TAG}) AS tag_count,
      (SELECT max(t.updated_at) FROM tags t WHERE t.repository_id = r.id) AS last_pushed_at,
      (SELECT ${configMediaType(sql.raw("m"))} FROM tags t
         JOIN manifests m ON m.repository_id = t.repository_id AND m.digest = t.manifest_digest
         WHERE t.repository_id = r.id ORDER BY t.updated_at DESC LIMIT 1) AS latest_config_media_type
    FROM repositories r JOIN organization o ON o.id = r.organization_id
    WHERE o.slug = ${orgSlug} AND r.name = ${repoName} AND r.visibility = 'public'`);
  const r = rows[0];
  if (!r) return null;
  const id = r.id as string;
  let description = String(r.description ?? "").trim();
  if (!description && r.readme) description = excerpt(String(r.readme));
  if (!description) description = (await imageAbout(id))?.description?.trim() ?? "";
  return {
    id,
    orgSlug,
    orgName: r.org_name as string,
    name: r.name as string,
    path: imagePath(orgSlug, repoName),
    href: repoHref(orgSlug, repoName),
    description: truncate(description, 200),
    kind: repoKindOf((r.latest_config_media_type as string | null) ?? null),
    tagCount: Number(r.tag_count ?? 0),
    pullCount: Number(r.pull_count ?? 0),
    lastPushedAt: r.last_pushed_at ? new Date(r.last_pushed_at as string) : null,
    logoDataUrl: drawableDataUrl(r.logo as string | null) ?? drawableDataUrl(r.org_logo as string | null),
  };
}

export interface OrgShare {
  slug: string;
  name: string;
  href: string;
  publicRepos: number;
  pullCount: number;
  lastPushedAt: Date | null;
  logoDataUrl: string | null;
}

/** An organization's public face: only its public repositories count. */
export async function orgShare(slug: string): Promise<OrgShare | null> {
  const { rows } = await db.execute(sql`
    SELECT o.name, o.logo,
      (SELECT count(*)::int FROM repositories r WHERE r.organization_id = o.id AND r.visibility = 'public') AS public_repos,
      (SELECT COALESCE(sum(r.pull_count), 0)::bigint FROM repositories r WHERE r.organization_id = o.id AND r.visibility = 'public') AS pull_count,
      (SELECT max(t.updated_at) FROM tags t JOIN repositories r ON r.id = t.repository_id
         WHERE r.organization_id = o.id AND r.visibility = 'public') AS last_pushed_at
    FROM organization o WHERE o.slug = ${slug}`);
  const r = rows[0];
  if (!r) return null;
  return {
    slug,
    name: r.name as string,
    href: `/${encodeURIComponent(slug)}`,
    publicRepos: Number(r.public_repos ?? 0),
    pullCount: Number(r.pull_count ?? 0),
    lastPushedAt: r.last_pushed_at ? new Date(r.last_pushed_at as string) : null,
    logoDataUrl: drawableDataUrl(r.logo as string | null),
  };
}

export interface TagShare {
  pushedAt: Date;
  isIndex: boolean;
  /** `linux/amd64`-style platforms: the index's members, or the image's own. */
  platforms: string[];
}

/** One tag of a public repository, or null when the tag does not exist. */
export async function tagShare(repoId: string, tag: string): Promise<TagShare | null> {
  const { rows } = await db.execute(sql`
    SELECT t.updated_at, m.media_type, m.payload, m.config
    FROM tags t JOIN manifests m ON m.repository_id = t.repository_id AND m.digest = t.manifest_digest
    WHERE t.repository_id = ${repoId} AND t.name = ${tag}`);
  const r = rows[0];
  if (!r) return null;
  const mediaType = String(r.media_type ?? "");
  const isIndex = mediaType.includes("index") || mediaType.includes("list");
  const platforms: string[] = [];
  if (isIndex) {
    try {
      const payload = JSON.parse(String(r.payload)) as { manifests?: { platform?: { os?: string; architecture?: string; variant?: string }; annotations?: Record<string, string> }[] };
      for (const m of payload.manifests ?? []) {
        if (m.annotations?.["vnd.docker.reference.type"] === "attestation-manifest") continue;
        const p = m.platform;
        if (!p?.os || p.os === "unknown") continue;
        platforms.push([p.os, p.architecture, p.variant].filter(Boolean).join("/"));
      }
    } catch {
      // an index we cannot read stays a "multi-arch" tag without platforms
    }
  } else {
    const c = r.config as { os?: string; architecture?: string; variant?: string } | null;
    if (c?.os && c.architecture) platforms.push([c.os, c.architecture, c.variant].filter(Boolean).join("/"));
  }
  return { pushedAt: new Date(r.updated_at as string), isIndex, platforms };
}

// --- text helpers ---

/**
 * The first real paragraph of a README as plain text: fenced code, HTML,
 * badges, headings and list markers dropped, links reduced to their text.
 */
export function excerpt(markdown: string, max = 200): string {
  const cleaned = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?```/g, "\n\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1");
  for (const block of cleaned.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0 || lines.every((l) => /^#{1,6}\s/.test(l) || /^[-=*_]{3,}$/.test(l) || /^\|/.test(l))) continue;
    const text = lines
      .map((l) => l.replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)+/, ""))
      .join(" ")
      .replace(/(\*\*|__|[*_~])(?=\S)(.+?)(?<=\S)\1/g, "$2")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return truncate(text, max);
  }
  return "";
}

/** Cut at a word boundary and mark the cut. */
export function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return (at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

// --- metadata builders ---

interface ShareText {
  title: string;
  description: string;
  /** Site-relative page URL, made absolute by metadataBase. */
  url: string;
  /** Card title reads "Explore · Chicorée": for pages named after a feature rather than a thing. */
  withSiteName?: boolean;
}

/** Open Graph + Twitter tags for a public page; the preview image comes from the segment's opengraph-image. */
export async function shareMetadata({ title, description, url, withSiteName }: ShareText): Promise<Metadata> {
  const b = await getBranding();
  const cardTitle = withSiteName ? `${title} · ${b.instanceName}` : title;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", siteName: b.instanceName, title: cardTitle, description, url },
    twitter: { card: "summary_large_image", title: cardTitle, description },
  };
}

/** Tags for pages that must stay out of previews and search results. */
export const NO_PREVIEW: Metadata = { robots: { index: false, follow: false } };

/** "Container image" / "Helm chart" / "Repository" as a noun for cards and descriptions. */
export function kindNoun(kind: RepoKind): string {
  return kind === "chart" ? "Helm chart" : kind === "image" ? "Container image" : "Repository";
}

/** `12 tags · 3.4k pulls · updated 2d ago` — the facts every repository card carries. */
export function repoFacts(share: Pick<RepoShare, "tagCount" | "pullCount" | "lastPushedAt">): string {
  const parts = [`${share.tagCount} ${share.tagCount === 1 ? "tag" : "tags"}`, `${formatCount(share.pullCount)} pulls`];
  if (share.lastPushedAt) parts.push(`updated ${relativeTime(share.lastPushedAt)}`);
  return parts.join(" · ");
}

export async function repoMetadata(share: RepoShare): Promise<Metadata> {
  const b = await getBranding();
  const lead = share.description || `${kindNoun(share.kind)} on ${b.instanceName}`;
  return shareMetadata({ title: share.path, description: truncate(`${lead} · ${repoFacts(share)}`, 300), url: share.href });
}

export async function orgMetadata(share: OrgShare): Promise<Metadata> {
  const b = await getBranding();
  const repos = `${share.publicRepos} public ${share.publicRepos === 1 ? "repository" : "repositories"}`;
  const parts = [`${repos} on ${b.instanceName}`];
  if (share.publicRepos > 0) parts.push(`${formatCount(share.pullCount)} pulls`);
  if (share.lastPushedAt) parts.push(`updated ${relativeTime(share.lastPushedAt)}`);
  return shareMetadata({ title: share.name, description: parts.join(" · "), url: share.href });
}

export async function tagMetadata(share: RepoShare, tag: string, t: TagShare): Promise<Metadata> {
  const parts: string[] = [];
  if (t.platforms.length > 0) parts.push(t.platforms.slice(0, 4).join(", ") + (t.platforms.length > 4 ? ", …" : ""));
  else if (t.isIndex) parts.push("multi-arch");
  parts.push(`pushed ${relativeTime(t.pushedAt)}`);
  if (share.description) parts.push(share.description);
  return shareMetadata({
    title: `${share.path}:${tag}`,
    description: truncate(parts.join(" · "), 300),
    url: `${share.href}/tags/${encodeURIComponent(tag)}`,
  });
}
