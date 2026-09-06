"use server";

// Per-repository access grants (Repository → Settings → Access): admin
// permission on the repository is required — owners, admins, or an admin grant.
import { revalidatePath } from "next/cache";
import { getRepoContext, removeRepoGrant, setRepoGrant } from "@/lib/repo-access";
import { isRepoPermission } from "@/lib/repo-access-shared";
import { requireSession } from "@/lib/session";
import { repoHref } from "@/lib/proxy-shared";

export interface AccessActionResult {
  error?: string;
  message?: string;
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function setGrantAction(_prev: AccessActionResult | null, fd: FormData): Promise<AccessActionResult> {
  const session = await requireSession();
  const orgSlug = str(fd, "orgSlug");
  const repoName = str(fd, "repoName");
  const access = await getRepoContext(orgSlug, repoName);
  if (!access?.can.manage) return { error: "Only repository admins can change access." };
  const subjectType = str(fd, "subjectType");
  const permission = str(fd, "permission");
  if (subjectType !== "user" && subjectType !== "team") return { error: "Pick a person or a team." };
  if (!isRepoPermission(permission)) return { error: "Unknown permission." };
  const res = await setRepoGrant({ repositoryId: access.repo.id, organizationId: access.org.id, subjectType, subjectId: str(fd, "subjectId"), permission, actorUserId: session.user.id });
  if (res.error !== undefined) return { error: res.error };
  revalidatePath(`${repoHref(orgSlug, repoName)}/settings/access`);
  return { message: `Access set to ${permission}` };
}

export async function removeGrantAction(_prev: AccessActionResult | null, fd: FormData): Promise<AccessActionResult> {
  await requireSession();
  const orgSlug = str(fd, "orgSlug");
  const repoName = str(fd, "repoName");
  const access = await getRepoContext(orgSlug, repoName);
  if (!access?.can.manage) return { error: "Only repository admins can change access." };
  const res = await removeRepoGrant({ repositoryId: access.repo.id, organizationId: access.org.id, grantId: str(fd, "grantId") });
  if (res.error !== undefined) return { error: res.error };
  revalidatePath(`${repoHref(orgSlug, repoName)}/settings/access`);
  return { message: "Access removed" };
}
