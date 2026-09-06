"use server";

// Teams of an organization: create, rename, delete, add and remove members.
// Owners and admins only; every change is audited (lib/repo-access.ts).
import { revalidatePath } from "next/cache";
import { getOrgContext, requireSession } from "@/lib/session";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { addTeamMember, createTeam, deleteTeam, removeTeamMember, updateTeam } from "@/lib/repo-access";

export interface TeamActionResult {
  error?: string;
  message?: string;
}

async function managerContext(orgSlug: string) {
  const session = await requireSession();
  const ctx = await getOrgContext(orgSlug);
  if (!ctx || !ctx.role || !MANAGER_ROLES.includes(ctx.role)) return null;
  return { session, org: ctx.org };
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function createTeamAction(_prev: TeamActionResult | null, fd: FormData): Promise<TeamActionResult> {
  const orgSlug = str(fd, "orgSlug");
  const c = await managerContext(orgSlug);
  if (!c) return { error: "Only owners and admins manage teams." };
  const res = await createTeam({ organizationId: c.org.id, name: str(fd, "name"), slug: str(fd, "slug") || undefined, description: str(fd, "description"), actorUserId: c.session.user.id });
  if (res.error !== undefined) return { error: res.error };
  revalidatePath(`/${orgSlug}/teams`);
  return { message: `Team ${res.team.name} created` };
}

export async function updateTeamAction(_prev: TeamActionResult | null, fd: FormData): Promise<TeamActionResult> {
  const orgSlug = str(fd, "orgSlug");
  const c = await managerContext(orgSlug);
  if (!c) return { error: "Only owners and admins manage teams." };
  const res = await updateTeam({ organizationId: c.org.id, teamId: str(fd, "teamId"), name: str(fd, "name"), slug: str(fd, "slug") || undefined, description: str(fd, "description") });
  if (res.error !== undefined) return { error: res.error };
  revalidatePath(`/${orgSlug}/teams`);
  return { message: "Team saved" };
}

export async function deleteTeamAction(_prev: TeamActionResult | null, fd: FormData): Promise<TeamActionResult> {
  const orgSlug = str(fd, "orgSlug");
  const c = await managerContext(orgSlug);
  if (!c) return { error: "Only owners and admins manage teams." };
  const res = await deleteTeam({ organizationId: c.org.id, teamId: str(fd, "teamId") });
  if (res.error !== undefined) return { error: res.error };
  revalidatePath(`/${orgSlug}/teams`);
  return { message: `Team ${res.team.name} deleted` };
}

export async function addTeamMemberAction(_prev: TeamActionResult | null, fd: FormData): Promise<TeamActionResult> {
  const orgSlug = str(fd, "orgSlug");
  const c = await managerContext(orgSlug);
  if (!c) return { error: "Only owners and admins manage teams." };
  const res = await addTeamMember({ organizationId: c.org.id, teamId: str(fd, "teamId"), userId: str(fd, "userId"), actorUserId: c.session.user.id });
  if (res.error !== undefined) return { error: res.error };
  revalidatePath(`/${orgSlug}/teams`);
  return { message: "Added to the team" };
}

export async function removeTeamMemberAction(_prev: TeamActionResult | null, fd: FormData): Promise<TeamActionResult> {
  const orgSlug = str(fd, "orgSlug");
  const c = await managerContext(orgSlug);
  if (!c) return { error: "Only owners and admins manage teams." };
  const res = await removeTeamMember({ organizationId: c.org.id, teamId: str(fd, "teamId"), userId: str(fd, "userId") });
  if (res.error !== undefined) return { error: res.error };
  revalidatePath(`/${orgSlug}/teams`);
  return { message: "Removed from the team" };
}
