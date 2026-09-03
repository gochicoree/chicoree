import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/session";
import { getAdminUserDetail } from "@/lib/admin-data";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { UsageMeter } from "@/components/admin/usage-meter";
import { UserControls } from "./user-controls";

export default async function AdminUserOverview({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  const { id } = await params;
  const detail = await getAdminUserDetail(id);
  if (!detail) notFound();
  const { user, usage, limits, counts } = detail;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader eyebrow="Account" title="Role and access" />
        <CardBody>
          <UserControls userId={user.id} isSelf={user.id === session.user.id} role={user.role ?? "user"} banned={!!user.banned} />
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
    </div>
  );
}
