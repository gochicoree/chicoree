import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization, organizationProxies } from "@/db/schema";
import { getSession } from "@/lib/session";
import { listUserOrgs } from "@/lib/data";
import { env } from "@/lib/env";
import { MANAGER_ROLES } from "@/lib/org-roles";
import { listRepositoryRedirects } from "@/lib/redirects";
import { RepoDangerForm } from "../repo-settings-form";
import { RepoRenameForm, RepoTransferForm, type TransferTarget } from "../repo-tools-forms";
import { repoSettingsContext } from "../context";

/** Organizations the caller may move the repository into: managed by them (all of them for instance admins), not the current one, not a proxy cache. */
async function transferTargets(userId: string, isAdmin: boolean, currentOrgId: string): Promise<TransferTarget[]> {
  const proxies = new Set((await db.query.organizationProxies.findMany({ columns: { organizationId: true } })).map((p) => p.organizationId));
  if (isAdmin) {
    const all = await db.query.organization.findMany({ columns: { id: true, name: true, slug: true }, orderBy: (o, { asc }) => [asc(o.name)] });
    return all.filter((o) => o.id !== currentOrgId && !proxies.has(o.id));
  }
  const mine = await listUserOrgs(userId);
  return mine.filter((o) => o.id !== currentOrgId && !proxies.has(o.id) && (MANAGER_ROLES as string[]).includes(o.role)).map((o) => ({ id: o.id, name: o.name, slug: o.slug }));
}

export default async function RepoDangerPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo, orgSlug } = await repoSettingsContext(params);
  const session = await getSession();
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  const proxy = !!(await db.query.organizationProxies.findFirst({ where: eq(organizationProxies.organizationId, repo.organizationId), columns: { organizationId: true } }));
  const [targets, former] = await Promise.all([
    session ? transferTargets(session.user.id, session.user.role === "admin", repo.organizationId) : Promise.resolve([]),
    listRepositoryRedirects(repo.id),
  ]);
  return (
    <div className="space-y-6">
      <RepoRenameForm
        repositoryId={repo.id}
        orgSlug={orgSlug}
        name={repo.name}
        registryHost={env.registryHost}
        proxy={proxy}
        formerNames={former.map((f) => `${f.orgSlug}/${f.name}`)}
      />
      <RepoTransferForm
        repositoryId={repo.id}
        orgSlug={orgSlug}
        orgName={org?.name ?? orgSlug}
        name={repo.name}
        registryHost={env.registryHost}
        targets={targets}
        proxy={proxy}
      />
      <RepoDangerForm repositoryId={repo.id} name={repo.name} />
    </div>
  );
}
