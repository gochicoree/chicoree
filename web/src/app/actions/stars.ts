"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, repositories } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { setStar } from "@/lib/stars";
import { repoHref } from "@/lib/proxy-shared";

export interface StarResult {
  starred: boolean;
  count: number;
  error?: string;
}

/** Star / unstar a repository the caller can see. */
export async function toggleStar(repositoryId: string, starred: boolean): Promise<StarResult> {
  const session = await requireSession();
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return { starred: false, count: 0, error: "Repository not found." };
  if (repo.visibility === "private") {
    const role = await getOrgRole(repo.organizationId);
    if (!role) return { starred: false, count: 0, error: "Repository not found." };
  }
  const state = await setStar(session.user.id, repositoryId, !!starred);
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (org) revalidatePath(repoHref(org.slug, repo.name));
  revalidatePath("/dashboard");
  return state;
}
