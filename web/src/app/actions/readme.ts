"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, repositories } from "@/db/schema";
import { getOrgRole, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { recordAudit } from "@/lib/audit";
import { renderReadme } from "@/lib/readme";
import { README_MAX_BYTES, readmeBytes } from "@/lib/readme-shared";
import { repoHref } from "@/lib/proxy-shared";

export interface ReadmeResult {
  error?: string;
  saved?: boolean;
}

/** Save the repository README (owners and admins of the organization). */
export async function updateReadme(_prev: ReadmeResult | null, formData: FormData): Promise<ReadmeResult> {
  await requireSession();
  const repoId = String(formData.get("repositoryId") ?? "");
  const readme = String(formData.get("readme") ?? "").replace(/\r\n/g, "\n");
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repoId) });
  if (!repo) return { error: "Repository not found." };
  const role = await getOrgRole(repo.organizationId);
  if (!role || !MANAGER_ROLES.includes(role)) return { error: "Only organization owners and admins can edit the README." };
  const bytes = readmeBytes(readme);
  if (bytes > README_MAX_BYTES) return { error: `The README is ${Math.ceil(bytes / 1024)} KB; the limit is ${README_MAX_BYTES / 1024} KB.` };

  const value = readme.trim() ? readme : null;
  await db.update(repositories).set({ readme: value, updatedAt: new Date() }).where(eq(repositories.id, repoId));
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  await recordAudit({
    action: "repo.readme",
    organizationId: repo.organizationId,
    targetType: "repository",
    targetId: repoId,
    targetLabel: `${org?.slug}/${repo.name}`,
    details: { bytes, cleared: value === null },
  });
  if (org) {
    const href = repoHref(org.slug, repo.name);
    revalidatePath(href);
    revalidatePath(`${href}/settings`);
  }
  return { saved: true };
}

/** Render Markdown the way the repository page will (signed-in users only). */
export async function previewReadme(markdown: string): Promise<{ html?: string; error?: string }> {
  await requireSession();
  const text = String(markdown ?? "");
  if (readmeBytes(text) > README_MAX_BYTES) return { error: `The README exceeds ${README_MAX_BYTES / 1024} KB.` };
  return { html: renderReadme(text) };
}
