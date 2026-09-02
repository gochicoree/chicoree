"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { organization, organizationSettings, repositories } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { LEVELS, refreshOrganizationBlocks, refreshRepositoryBlocks, type Level } from "@/lib/pull-policy";

export interface PolicyResult {
  error?: string;
  saved?: boolean;
  blocked?: number;
}

function readLevel(value: FormDataEntryValue | null): Level | null {
  const v = String(value ?? "");
  return (LEVELS as string[]).includes(v) ? (v as Level) : null;
}

export async function setOrgPullPolicy(_prev: PolicyResult | null, formData: FormData): Promise<PolicyResult> {
  await requireSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  const role = await getOrgRole(organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can change the pull policy." };
  const level = readLevel(formData.get("level"));
  const unrated = formData.get("unrated") === "on";
  await db
    .insert(organizationSettings)
    .values({ organizationId, blockPullsAt: level, blockUnrated: unrated, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: organizationSettings.organizationId,
      set: { blockPullsAt: level, blockUnrated: unrated, updatedAt: new Date() },
    });
  await refreshOrganizationBlocks(organizationId);
  const org = await db.query.organization.findFirst({ where: eq(organization.id, organizationId) });
  if (org) {
    revalidatePath(`/${org.slug}/settings`);
    revalidatePath(`/${org.slug}`, "layout");
  }
  return { saved: true };
}

export async function setRepoPullPolicy(_prev: PolicyResult | null, formData: FormData): Promise<PolicyResult> {
  await requireSession();
  const repositoryId = String(formData.get("repositoryId") ?? "");
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { error: "Repository not found." };
  const role = await getOrgRole(repo.organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can change the pull policy." };
  const raw = String(formData.get("level") ?? "");
  const level: "off" | Level | null = raw === "off" ? "off" : raw === "" ? null : readLevel(raw);
  // The unrated switch only means something with an explicit level; "inherit" takes the organization's.
  const unrated = level && level !== "off" ? formData.get("unrated") === "on" : null;
  await db
    .update(repositories)
    .set({ blockPullsAt: level, blockUnrated: unrated, updatedAt: new Date() })
    .where(eq(repositories.id, repositoryId));
  const { blocked } = await refreshRepositoryBlocks(repositoryId);
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (org) {
    revalidatePath(`/${org.slug}/${repo.name}/settings`);
    revalidatePath(`/${org.slug}/${repo.name}`);
  }
  return { saved: true, blocked };
}
