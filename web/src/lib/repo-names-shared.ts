// Repository name rules shared by the create, rename and transfer paths.
// Pure: safe for client components.
import { isValidRepoName } from "./proxy-shared";

/**
 * Names that would shadow org-level UI routes (/<org>/members …) or the
 * registry's own path markers. Pushing such a repository still works at the
 * registry level; the web UI just reserves the paths.
 */
export const RESERVED_REPO_NAMES = new Set([
  "members", "settings", "service-accounts", "new-repository", "import", "audit", "compare",
  "tags", "manifests", "blobs", "referrers",
]);

export const MAX_REPO_NAME_LENGTH = 100;

/**
 * Why `name` is not an acceptable repository name, or null. Nested names
 * (`team/app`) are only valid in proxy-cache organizations.
 */
export function repoNameProblem(name: string, allowNested: boolean): string | null {
  if (!name) return "Enter a repository name.";
  if (!allowNested && name.length > MAX_REPO_NAME_LENGTH) return `Repository names are at most ${MAX_REPO_NAME_LENGTH} characters.`;
  if (!isValidRepoName(name, allowNested)) {
    return allowNested
      ? "Repository names use lowercase letters, digits and single ._- separators, with / between path components."
      : "Repository names use lowercase letters, digits and single ._- separators.";
  }
  if (RESERVED_REPO_NAMES.has(name)) return `"${name}" is reserved; pick a different name.`;
  return null;
}

/** Organization slugs: one OCI path component (the same rule the sign-up form applies). */
export const ORG_SLUG_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
