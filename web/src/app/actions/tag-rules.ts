"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { organization, repositories, tagRules } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { validateTagPattern } from "@/lib/tag-rules-shared";

export interface TagRuleResult {
  error?: string;
  saved?: boolean;
}

const MAX_RULES_PER_SCOPE = 50;

async function requireManager(organizationId: string) {
  const session = await requireSession();
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) {
    return { error: "Only organization owners and admins can manage tag rules." } as const;
  }
  return { session } as const;
}

async function revalidateOrg(organizationId: string) {
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (org) revalidatePath(`/${org.slug}`, "layout");
}

/** Add a rule to an organization (repositoryId empty) or one repository. Same pattern in the same scope: flags are merged. */
export async function addTagRule(_prev: TagRuleResult | null, formData: FormData): Promise<TagRuleResult> {
  const organizationId = String(formData.get("organizationId") ?? "");
  const repositoryId = String(formData.get("repositoryId") ?? "") || null;
  const pattern = String(formData.get("pattern") ?? "").trim();
  const immutable = formData.get("immutable") === "on";
  const isProtected = formData.get("protected") === "on";

  const ctx = await requireManager(organizationId);
  if ("error" in ctx) return { error: ctx.error };
  if (repositoryId) {
    const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
    if (!repo || repo.organizationId !== organizationId) return { error: "Repository not found." };
  }
  const invalid = validateTagPattern(pattern);
  if (invalid) return { error: invalid };
  if (!immutable && !isProtected) return { error: "Tick immutable, protected, or both." };

  const scope = and(
    eq(tagRules.organizationId, organizationId),
    repositoryId ? eq(tagRules.repositoryId, repositoryId) : isNull(tagRules.repositoryId),
  );
  const existing = await db.query.tagRules.findMany({ where: scope });
  const same = existing.find((r) => r.pattern === pattern);
  if (same) {
    await db
      .update(tagRules)
      .set({ immutable: same.immutable || immutable, protected: same.protected || isProtected })
      .where(eq(tagRules.id, same.id));
  } else {
    if (existing.length >= MAX_RULES_PER_SCOPE) return { error: `At most ${MAX_RULES_PER_SCOPE} rules per scope.` };
    await db.insert(tagRules).values({
      organizationId,
      repositoryId,
      pattern,
      immutable,
      protected: isProtected,
      createdBy: ctx.session.user.id,
    });
  }
  await revalidateOrg(organizationId);
  return { saved: true };
}

export async function removeTagRule(formData: FormData): Promise<TagRuleResult> {
  const id = String(formData.get("id") ?? "");
  const rule = await db.query.tagRules.findFirst({ where: eq(tagRules.id, id) });
  if (!rule) return { error: "Rule not found." };
  const ctx = await requireManager(rule.organizationId);
  if ("error" in ctx) return { error: ctx.error };
  await db.delete(tagRules).where(eq(tagRules.id, id));
  await revalidateOrg(rule.organizationId);
  return { saved: true };
}
