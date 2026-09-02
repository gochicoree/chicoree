import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/session";
import { getAdminUserDetail } from "@/lib/admin-data";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UsageMeter } from "@/components/admin/usage-meter";
import { LimitsForm } from "@/components/admin/limits-form";
import { AdminNav } from "../../admin-nav";
import { UserControls } from "./user-controls";

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  const { id } = await params;
  const detail = await getAdminUserDetail(id);
  if (!detail) notFound();
  const { user, usage, limits, counts, memberships } = detail;
  const limitsNote = await noteFor(id);

  return (
    <>
      <PageHeader eyebrow="Instance" title="Administration" />
      <AdminNav />
      <Link href="/admin/users" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
        <ArrowLeft className="size-4" /> All users
      </Link>

      <div className="space-y-6">
        <Card>
          <CardHeader
            eyebrow="User"
            title={user.name}
            description={`${user.email} · joined ${formatDate(user.createdAt)}`}
            action={
              <div className="flex items-center gap-2">
                <Badge tone={user.role === "admin" ? "accent" : "neutral"}>{user.role ?? "user"}</Badge>
                {user.banned && <Badge tone="danger">banned</Badge>}
                {user.twoFactorEnabled && <Badge tone="ok">2FA</Badge>}
              </div>
            }
          />
          <CardBody>
            <UserControls
              userId={user.id}
              isSelf={user.id === session.user.id}
              role={user.role ?? "user"}
              banned={!!user.banned}
            />
            <dl className="mt-4 grid gap-3 border-t border-line pt-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="eyebrow mb-0.5">Access tokens</dt>
                <dd className="font-mono">{counts.tokens}</dd>
              </div>
              <div>
                <dt className="eyebrow mb-0.5">Passkeys</dt>
                <dd className="font-mono">{counts.passkeys}</dd>
              </div>
              <div>
                <dt className="eyebrow mb-0.5">Active sessions</dt>
                <dd className="font-mono">{counts.sessions}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <div>
          <div className="eyebrow mb-2">Usage across owned organizations</div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <UsageMeter label="Organizations owned" used={usage.organizations} limit={limits.maxOrganizations} />
            <UsageMeter label="Public repositories" used={usage.publicRepos} limit={limits.maxPublicRepos} />
            <UsageMeter label="Private repositories" used={usage.privateRepos} limit={limits.maxPrivateRepos} />
            <UsageMeter label="Storage" used={usage.storageBytes} limit={limits.maxStorageBytes} bytes />
          </div>
        </div>

        <LimitsForm scope="user" targetId={user.id} limits={limits} note={limitsNote} />

        <Card>
          <CardHeader eyebrow="Memberships" title={`Organizations (${memberships.length})`} />
          {memberships.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-3">Not a member of any organization.</p>
          ) : (
            <div>
              {memberships.map((m) => (
                <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 sm:px-5">
                  <Link href={`/admin/organizations/${m.id}`} className="font-medium hover:underline">
                    {m.name}
                  </Link>
                  <span className="font-mono text-xs text-ink-3">{m.slug}/</span>
                  <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
                  <span className="ml-auto text-xs text-ink-2">{m.repoCount} repositories</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

async function noteFor(userId: string): Promise<string> {
  const { db } = await import("@/db");
  const { userLimits } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const row = await db.query.userLimits.findFirst({ where: eq(userLimits.userId, userId) });
  return row?.note ?? "";
}
