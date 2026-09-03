// Tag rules (immutable / protected tags) as stored in tag_rules. registryd
// enforces them on push and delete; the web app reads them for lock badges
// and to refuse deletions early with a readable message.
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { tagRules } from "@/db/schema";
import { tagFlags, type TagRuleLike } from "./tag-rules-shared";

export * from "./tag-rules-shared";

export type TagRuleRow = typeof tagRules.$inferSelect;

/** Rules defined at exactly one scope: a repository, or the organization (repositoryId null). */
export async function listTagRules(organizationId: string, repositoryId: string | null): Promise<TagRuleRow[]> {
  return db.query.tagRules.findMany({
    where: and(
      eq(tagRules.organizationId, organizationId),
      repositoryId ? eq(tagRules.repositoryId, repositoryId) : isNull(tagRules.repositoryId),
    ),
    orderBy: (t, { asc }) => [asc(t.pattern)],
  });
}

/**
 * Every rule that applies to a repository: its own first, then the
 * organization-wide ones — the same order registryd evaluates them in.
 */
export async function effectiveTagRules(organizationId: string, repositoryId: string): Promise<TagRuleRow[]> {
  const rows = await db.query.tagRules.findMany({
    where: and(
      eq(tagRules.organizationId, organizationId),
      or(isNull(tagRules.repositoryId), eq(tagRules.repositoryId, repositoryId)),
    ),
  });
  return rows.sort((a, b) => Number(a.repositoryId === null) - Number(b.repositoryId === null) || a.pattern.localeCompare(b.pattern));
}

/** Why a tag may not be deleted, or null. */
export function protectedReason(rules: TagRuleLike[], tag: string): string | null {
  const flags = tagFlags(rules, tag);
  return flags.protected ? `Tag "${tag}" is protected by rule "${flags.protected.pattern}" and cannot be deleted.` : null;
}
