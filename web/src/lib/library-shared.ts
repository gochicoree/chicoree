// The "library" organization is virtual to users: `registry/nginx` is stored
// as `library/nginx` (docker.io semantics), but no path anyone sees carries
// the prefix. Pure helpers, safe for client components; lib/library.ts adds
// the database side.
export const LIBRARY_SLUG = "library";
export const LIBRARY_NAME = "Library";

export function isLibrary(orgSlug: string | null | undefined): boolean {
  return orgSlug === LIBRARY_SLUG;
}

/** The path people see and pull: `nginx` for library repos, `org/repo` otherwise. */
export function imagePath(orgSlug: string | null | undefined, repoName: string): string {
  return !orgSlug || isLibrary(orgSlug) ? repoName : `${orgSlug}/${repoName}`;
}

/** Full docker reference, e.g. `registry.example.com/nginx:1.27`. */
export function imageReference(host: string, orgSlug: string | null | undefined, repoName: string, ref?: string): string {
  const base = `${host}/${imagePath(orgSlug, repoName)}`;
  if (!ref) return base;
  return ref.startsWith("sha256:") ? `${base}@${ref}` : `${base}:${ref}`;
}

/** A stored `org/repo[:tag|@digest]` label as displayed: the library prefix is dropped. */
export function displayPath(label: string): string {
  return label.startsWith(`${LIBRARY_SLUG}/`) ? label.slice(LIBRARY_SLUG.length + 1) : label;
}

/**
 * Split a scope/repo name into org + repo; single segments belong to library.
 * Deeper paths (`dockerhub/bitnami/redis`) keep everything after the
 * organization as the repository name — the registry only accepts those in
 * proxy-cache organizations.
 */
export function splitImagePath(name: string): { orgSlug: string; repoName: string } | null {
  const parts = name.split("/");
  if (parts.some((p) => !p)) return null;
  if (parts.length === 1) return { orgSlug: LIBRARY_SLUG, repoName: parts[0] };
  if (parts.length >= 2) return { orgSlug: parts[0], repoName: parts.slice(1).join("/") };
  return null;
}
