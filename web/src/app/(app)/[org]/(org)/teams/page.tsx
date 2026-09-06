import { notFound, redirect } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { listMembersWithUsers } from "@/lib/data";
import { listTeamMembers, listTeams } from "@/lib/repo-access";
import { logoRef } from "@/lib/logo-shared";
import { TeamsManager } from "./teams-manager";

export default async function TeamsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  if (!ctx.role) redirect(`/${slug}`);
  const [teams, members] = await Promise.all([listTeams(ctx.org.id), listMembersWithUsers(ctx.org.id)]);
  const withMembers = await Promise.all(
    teams.map(async (t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
      members: (await listTeamMembers(t.id)).map((m) => ({ userId: m.userId, name: m.name, email: m.email, role: m.role, logo: logoRef("user", m.userId, m.logoVersion) })),
    })),
  );
  return (
    <TeamsManager
      orgSlug={slug}
      canManage={ctx.role === "owner" || ctx.role === "admin"}
      teams={withMembers}
      members={members.map((m) => ({ userId: m.userId, name: m.userName, email: m.userEmail, role: m.role }))}
    />
  );
}
