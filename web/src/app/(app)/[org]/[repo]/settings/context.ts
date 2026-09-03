import { notFound, redirect } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { getRepoByPath } from "@/lib/data";
import { MANAGER_ROLES } from "@/lib/org-roles";

/** Repository + access check shared by every settings tab (managers only). */
export async function repoSettingsContext(params: Promise<{ org: string; repo: string }>) {
  const { org: orgSlug, repo: repoName } = await params;
  const found = await getRepoByPath(orgSlug, repoName);
  if (!found) notFound();
  const ctx = await getOrgContext(orgSlug);
  if (!ctx?.role || !MANAGER_ROLES.includes(ctx.role)) redirect(`/${orgSlug}/${repoName}`);
  return { orgSlug, repoName, repo: found.repo, base: `/${orgSlug}/${repoName}/settings` };
}
