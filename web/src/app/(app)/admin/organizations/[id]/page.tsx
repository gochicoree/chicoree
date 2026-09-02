import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowLeft, Trash2 } from "lucide-react";
import { db } from "@/db";
import { organizationLimits } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { getAdminOrgDetail } from "@/lib/admin-data";
import { listMembersWithUsers, listOrgRepos } from "@/lib/data";
import { formatBytes, formatDate, relativeTime } from "@/lib/format";
import { adminDeleteRepository, adminRemoveMember } from "@/app/actions/admin-orgs";
import { PageHeader } from "@/components/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { UsageMeter } from "@/components/admin/usage-meter";
import { LimitsForm } from "@/components/admin/limits-form";
import { AdminNav } from "../../admin-nav";
import { MemberRoleSelect, DeleteOrganization } from "./org-controls";

export default async function AdminOrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const detail = await getAdminOrgDetail(id);
  if (!detail) notFound();
  const { org, usage, limits } = detail;
  const [members, repos, limitsRow] = await Promise.all([
    listMembersWithUsers(org.id),
    listOrgRepos(org.id, true),
    db.query.organizationLimits.findFirst({ where: eq(organizationLimits.organizationId, org.id) }),
  ]);

  return (
    <>
      <PageHeader eyebrow="Instance" title="Administration" />
      <AdminNav />
      <Link href="/admin/organizations" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> All organizations
      </Link>

      <div className="space-y-6">
        <Card>
          <CardHeader
            eyebrow="Organization"
            title={org.name}
            description={`${org.slug}/ · created ${formatDate(org.createdAt)}`}
            action={
              <Link href={`/${org.slug}`} className="text-sm text-ink-2 hover:text-ink hover:underline">
                Open as user →
              </Link>
            }
          />
        </Card>

        <div className="grid gap-3 sm:grid-cols-3">
          <UsageMeter label="Public repositories" used={usage.publicRepos} limit={limits.maxPublicRepos} />
          <UsageMeter label="Private repositories" used={usage.privateRepos} limit={limits.maxPrivateRepos} />
          <UsageMeter label="Storage" used={usage.storageBytes} limit={limits.maxStorageBytes} bytes />
        </div>

        <LimitsForm scope="organization" targetId={org.id} limits={limits} note={limitsRow?.note ?? ""} />

        <Card>
          <CardHeader eyebrow="People" title={`Members (${members.length})`} />
          <div>
            {members.map((m) => (
              <div key={m.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5">
                <div className="min-w-0 flex-1">
                  <Link href={`/admin/users/${m.userId}`} className="text-sm font-medium hover:underline">
                    {m.userName}
                  </Link>
                  <div className="truncate text-xs text-ink-2">{m.userEmail}</div>
                </div>
                <MemberRoleSelect memberId={m.id} organizationId={org.id} role={m.role} />
                <form action={adminRemoveMember}>
                  <input type="hidden" name="memberId" value={m.id} />
                  <input type="hidden" name="organizationId" value={org.id} />
                  <button
                    type="submit"
                    aria-label={`Remove ${m.userName}`}
                    className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </form>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader eyebrow="Content" title={`Repositories (${repos.length})`} />
          {repos.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-3">No repositories.</p>
          ) : (
            <div>
              {repos.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 sm:px-5">
                  <Link href={`/${org.slug}/${r.name}`} className="break-all font-medium hover:underline">
                    {r.name}
                  </Link>
                  <VisibilityBadge visibility={r.visibility} />
                  <span className="font-mono text-xs text-ink-2">
                    {r.tagCount} tags · {formatBytes(r.sizeBytes)}
                  </span>
                  <span className="ml-auto text-xs text-ink-3">
                    {r.lastPushedAt ? `pushed ${relativeTime(r.lastPushedAt)}` : "empty"}
                  </span>
                  <form action={adminDeleteRepository}>
                    <input type="hidden" name="repositoryId" value={r.id} />
                    <input type="hidden" name="organizationId" value={org.id} />
                    <button
                      type="submit"
                      aria-label={`Delete ${r.name}`}
                      className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </form>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="border-danger/30">
          <CardHeader
            eyebrow="Danger"
            title="Delete this organization"
            description="Removes members, repositories, images and service accounts. Blob content is reclaimed by the next garbage collection."
            action={<Badge tone="danger">irreversible</Badge>}
          />
          <DeleteOrganization organizationId={org.id} slug={org.slug} />
        </Card>
      </div>
    </>
  );
}
