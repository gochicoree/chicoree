import { notFound, redirect } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { getRepoByPath } from "@/lib/data";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";

/** Repository + access check shared by every settings tab (managers only). */
export async function repoSettingsContext(params: Promise<{ org: string; repo: string }>) {
  const { org: orgSlug, repo: rawRepo } = await params;
  const repoName = decodeRepoParam(rawRepo);
  const found = await getRepoByPath(orgSlug, repoName);
  if (!found) notFound();
  const ctx = await getOrgContext(orgSlug);
  const href = repoHref(orgSlug, repoName);
  if (!ctx?.role || !MANAGER_ROLES.includes(ctx.role)) redirect(href);
  return { orgSlug, repoName, repo: found.repo, href, base: `${href}/settings` };
}
