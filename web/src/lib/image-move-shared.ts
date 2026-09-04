// Pure helpers shared by the "Move or copy" modal and its server action.
// No database, no Node APIs: safe to import from a client component.

export type ImageMoveMode = "copy" | "move";

/** The tag grammar registryd enforces (internal/api/router.go `tagRe`). */
export const TAG_NAME_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;

/** Why `tag` is not an acceptable tag name, or null. */
export function tagNameProblem(tag: string): string | null {
  if (!tag) return "Enter a destination tag.";
  if (tag.length > 128) return "Tags are at most 128 characters.";
  if (!TAG_NAME_RE.test(tag)) {
    return "Tags start with a letter, digit or underscore and continue with letters, digits, . _ or -.";
  }
  return null;
}

/** The path a client pulls from: `nginx` for the library organization, `org/repo` otherwise. */
export function pullPath(orgSlug: string, repoName: string): string {
  return orgSlug === "library" ? repoName : `${orgSlug}/${repoName}`;
}

/** Full `docker pull` reference for a destination. */
export function pullReference(registryHost: string, orgSlug: string, repoName: string, tag: string): string {
  return `${registryHost}/${pullPath(orgSlug, repoName)}:${tag}`;
}
