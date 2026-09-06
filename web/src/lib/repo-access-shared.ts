// Repository permissions, shared by server and client code. The
// organization role is the baseline for every repository; a grant (to a
// person or a team) raises what they may do in one repository.
import type { OrgRole } from "./org-roles";

export type RepoPermission = "pull" | "push" | "admin";

export const REPO_PERMISSIONS: { value: RepoPermission; label: string; description: string }[] = [
  { value: "pull", label: "pull", description: "Pull images and browse the repository" },
  { value: "push", label: "push", description: "Also push, retag and copy images in" },
  { value: "admin", label: "admin", description: "Also delete images, change settings, manage access" },
];

const RANK: Record<RepoPermission, number> = { pull: 1, push: 2, admin: 3 };

export function isRepoPermission(v: string): v is RepoPermission {
  return v === "pull" || v === "push" || v === "admin";
}

/** The permission an organization role gives on every repository; null for non-members. */
export function permissionFromRole(role: OrgRole | string | null | undefined): RepoPermission | null {
  switch (role) {
    case "owner":
    case "admin":
      return "admin";
    case "member":
      return "push";
    case "viewer":
      return "pull";
    default:
      return null;
  }
}

export function maxPermission(a: RepoPermission | null, b: RepoPermission | null): RepoPermission | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

export function permissionAtLeast(have: RepoPermission | null, need: RepoPermission): boolean {
  return !!have && RANK[have] >= RANK[need];
}

export const TEAM_SLUG_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
export const TEAM_NAME_MAX = 64;
export const TEAM_DESCRIPTION_MAX = 200;

/** A team slug from a display name: lowercase, separators collapsed. */
export function teamSlugFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}
