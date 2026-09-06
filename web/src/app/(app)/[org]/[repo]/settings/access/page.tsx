import { listMembersWithUsers } from "@/lib/data";
import { logoRef } from "@/lib/logo-shared";
import { listRepoGrants, listTeams } from "@/lib/repo-access";
import { repoSettingsContext } from "../context";
import { AccessManager } from "./access-manager";

export default async function RepoAccessPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { orgSlug, repoName, repo, org } = await repoSettingsContext(params);
  const [grants, members, teams] = await Promise.all([listRepoGrants(repo.id), listMembersWithUsers(org.id), listTeams(org.id)]);
  return (
    <AccessManager
      orgSlug={orgSlug}
      repoName={repoName}
      grants={grants.map((g) => ({ ...g, createdAt: g.createdAt.toISOString(), logo: g.subjectType === "user" ? logoRef("user", g.subjectId, g.logoVersion) : null }))}
      members={members.map((m) => ({ userId: m.userId, name: m.userName, email: m.userEmail, role: m.role }))}
      teams={teams.map((t) => ({ id: t.id, slug: t.slug, name: t.name, memberCount: t.memberCount }))}
    />
  );
}
