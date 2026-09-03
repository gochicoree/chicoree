"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { organization, repositories, retentionPolicies } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { runJob } from "@/lib/jobs";
import { imagePath } from "@/lib/library";
import { describeRetention, parseDaysField, parseKeepMatching, planScope, type RetentionSettings } from "@/lib/retention";
import type { PlannedManifest, PlannedTag } from "@/lib/retention-shared";
import type { RetentionDetailLine } from "@/lib/retention";
import { validateTagPattern } from "@/lib/tag-rules-shared";

export interface RetentionPreview {
  generatedAt: string;
  repositories: {
    path: string;
    scope: "repository" | "organization";
    policy: string;
    tags: PlannedTag[];
    manifests: PlannedManifest[];
    keptTags: PlannedTag[];
    keptManifests: PlannedManifest[];
  }[];
}

export interface RetentionRunSummary {
  runId: string;
  repositories: number;
  tags: { planned: number; deleted: number; failed: number };
  manifests: { planned: number; deleted: number; failed: number };
  detail: RetentionDetailLine[];
  truncated: number;
}

export interface RetentionActionResult {
  error?: string;
  saved?: boolean;
  preview?: RetentionPreview;
  run?: RetentionRunSummary;
}

async function scopeContext(formData: FormData) {
  const organizationId = String(formData.get("organizationId") ?? "");
  const repositoryId = String(formData.get("repositoryId") ?? "") || null;
  await requireSession();
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) {
    return { error: "Only organization owners and admins can change retention policies." } as const;
  }
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (!org) return { error: "Organization not found." } as const;
  let repo: typeof repositories.$inferSelect | null = null;
  if (repositoryId) {
    repo = (await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) })) ?? null;
    if (!repo || repo.organizationId !== organizationId) return { error: "Repository not found." } as const;
  }
  return { org, repo } as const;
}

function readPolicy(formData: FormData): { policy: RetentionSettings } | { error: string } {
  const keepLast = parseDaysField(String(formData.get("keepLast") ?? ""), "Keep last");
  if ("error" in keepLast) return keepLast;
  const olderThan = parseDaysField(String(formData.get("deleteOlderThanDays") ?? ""), "Delete tags older than");
  if ("error" in olderThan) return olderThan;
  const untagged = parseDaysField(String(formData.get("deleteUntaggedAfterDays") ?? ""), "Delete untagged manifests after");
  if ("error" in untagged) return untagged;
  const keepMatchingRaw = String(formData.get("keepMatching") ?? "").trim();
  for (const p of parseKeepMatching(keepMatchingRaw)) {
    const invalid = validateTagPattern(p);
    if (invalid) return { error: `Keep matching: ${invalid}` };
  }
  return {
    policy: {
      enabled: formData.get("enabled") === "on",
      keepLast: keepLast.value,
      keepMatching: keepMatchingRaw || null,
      deleteOlderThanDays: olderThan.value,
      deleteUntaggedAfterDays: untagged.value,
    },
  };
}

function revalidateScope(org: { slug: string }, repo: { name: string } | null) {
  if (repo) {
    revalidatePath(`/${org.slug}/${repo.name}/settings`, "layout");
    revalidatePath(`/${org.slug}/${repo.name}`);
  } else {
    revalidatePath(`/${org.slug}`, "layout");
  }
}

/** Save the scope's policy; a repository in "inherit" mode drops its own row. */
export async function saveRetentionPolicy(_prev: RetentionActionResult | null, formData: FormData): Promise<RetentionActionResult> {
  const ctx = await scopeContext(formData);
  if ("error" in ctx) return { error: ctx.error };
  const session = await requireSession();

  if (ctx.repo && formData.get("mode") === "inherit") {
    await db.delete(retentionPolicies).where(eq(retentionPolicies.repositoryId, ctx.repo.id));
    revalidateScope(ctx.org, ctx.repo);
    return { saved: true };
  }

  const read = readPolicy(formData);
  if ("error" in read) return { error: read.error };
  const values = {
    organizationId: ctx.org.id,
    repositoryId: ctx.repo?.id ?? null,
    ...read.policy,
    updatedBy: session.user.id,
    updatedAt: new Date(),
  };
  const existing = await db.query.retentionPolicies.findFirst({
    where: and(
      eq(retentionPolicies.organizationId, ctx.org.id),
      ctx.repo ? eq(retentionPolicies.repositoryId, ctx.repo.id) : isNull(retentionPolicies.repositoryId),
    ),
  });
  if (existing) {
    await db.update(retentionPolicies).set(values).where(eq(retentionPolicies.id, existing.id));
  } else {
    await db.insert(retentionPolicies).values(values);
  }
  revalidateScope(ctx.org, ctx.repo);
  return { saved: true };
}

/**
 * What the policy in the form would delete right now — for one repository,
 * or every repository of the organization (those with their own policy keep
 * it). Nothing is deleted.
 */
export async function previewRetention(_prev: RetentionActionResult | null, formData: FormData): Promise<RetentionActionResult> {
  const ctx = await scopeContext(formData);
  if ("error" in ctx) return { error: ctx.error };
  let override: RetentionSettings | undefined;
  if (!(ctx.repo && formData.get("mode") === "inherit")) {
    const read = readPolicy(formData);
    if ("error" in read) return { error: read.error };
    override = read.policy;
  }
  const plans = await planScope({ organizationId: ctx.org.id, repositoryId: ctx.repo?.id, override });
  return {
    preview: {
      generatedAt: new Date().toISOString(),
      repositories: plans.map((p) => ({
        path: p.path,
        scope: p.scope,
        policy: describeRetention({ ...p.policy, enabled: true }),
        tags: p.plan.tags,
        manifests: p.plan.manifests,
        keptTags: p.plan.keptTags,
        keptManifests: p.plan.keptManifests,
      })),
    },
  };
}

/** Apply the saved policies of the scope now (not a dry run); recorded as a `retention` job run. */
export async function runRetentionNow(_prev: RetentionActionResult | null, formData: FormData): Promise<RetentionActionResult> {
  const ctx = await scopeContext(formData);
  if ("error" in ctx) return { error: ctx.error };
  const session = await requireSession();
  const run = await runJob(
    "retention",
    {
      dryRun: "false",
      organization: ctx.org.slug,
      repository: ctx.repo ? imagePath(ctx.org.slug, ctx.repo.name) : "",
    },
    `user:${session.user.id}`,
  );
  revalidateScope(ctx.org, ctx.repo);
  revalidatePath("/admin/jobs");
  if (run.status !== "succeeded" || !run.result) return { error: run.error ?? "The retention run failed." };
  const r = run.result as {
    repositories: number;
    tags: RetentionRunSummary["tags"];
    manifests: RetentionRunSummary["manifests"];
    detail: RetentionDetailLine[];
    truncated: number;
  };
  return {
    run: {
      runId: run.id,
      repositories: r.repositories,
      tags: r.tags,
      manifests: r.manifests,
      detail: r.detail,
      truncated: r.truncated,
    },
  };
}
