// Pure bits of the repository move rules, safe for client components
// (lib/repo-move.ts itself touches the database).

/**
 * The largest number of repositories one bulk run may move. Runs are
 * sequential — each move commits before the next is checked, so the target's
 * quotas see what has actually landed — which keeps a run honest but slow;
 * this is the point where an administrator should split the work.
 */
export const MAX_BULK_MOVE = 50;

/** Why a repository cannot be moved. `null` when it can. */
export type MoveSkipCode =
  | "repository-missing"
  | "organization-missing"
  | "same-organization"
  | "denied"
  | "target-denied"
  | "source-proxy"
  | "target-proxy"
  | "invalid-name"
  | "name-taken"
  | "repository-quota"
  | "storage-quota"
  | "failed";

/** Short label for the outcome badge; the full sentence is in `message`. */
export function skipLabel(code: MoveSkipCode | null): string {
  switch (code) {
    case "repository-missing":
      return "gone";
    case "organization-missing":
      return "no organization";
    case "same-organization":
      return "already there";
    case "denied":
    case "target-denied":
      return "not allowed";
    case "source-proxy":
      return "proxy source";
    case "target-proxy":
      return "proxy target";
    case "invalid-name":
      return "invalid name";
    case "name-taken":
      return "name taken";
    case "repository-quota":
      return "repository quota";
    case "storage-quota":
      return "storage quota";
    case "failed":
      return "failed";
    default:
      return "skipped";
  }
}
