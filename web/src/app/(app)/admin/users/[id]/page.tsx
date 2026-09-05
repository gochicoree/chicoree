import { notFound } from "next/navigation";
import { KeyRound, Trash2 } from "lucide-react";
import { requireAdmin } from "@/lib/session";
import { getAdminUserDetail } from "@/lib/admin-data";
import { loadUserTokens } from "@/lib/credentials-data";
import { relativeTime } from "@/lib/format";
import { describeRestriction, expiryState, lastUsedText } from "@/lib/token-policy-shared";
import { adminRevokeAccessToken } from "@/app/actions/credentials";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { UsageMeter } from "@/components/admin/usage-meter";
import { ExpiryBadge } from "@/app/(app)/settings/tokens/token-manager";
import { LogoUploadCard } from "@/components/logo-upload";
import { adminSaveUserAvatar } from "@/app/actions/logos";
import { UserControls } from "./user-controls";
import { AccountControls } from "./account-controls";

export default async function AdminUserOverview({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin();
  const { id } = await params;
  const [detail, tokens] = await Promise.all([getAdminUserDetail(id), loadUserTokens(id)]);
  if (!detail) notFound();
  const { user, usage, limits, counts } = detail;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader eyebrow="Account" title="Role and access" />
        <CardBody>
          <UserControls userId={user.id} isSelf={user.id === session.user.id} role={user.role ?? "user"} banned={!!user.banned} sessions={counts.sessions} />
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

      <AccountControls
        user={{
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: !!user.emailVerified,
          twoFactorEnabled: !!user.twoFactorEnabled,
          passkeys: counts.passkeys,
          createdAt: user.createdAt.toISOString(),
          isSelf: user.id === session.user.id,
        }}
      />

      <LogoUploadCard
        action={adminSaveUserAvatar}
        kind="user"
        name={user.name}
        fields={{ userId: user.id }}
        initial={user.image}
        eyebrow="Identity"
        title="Avatar"
        description="Set or clear this account's avatar; the user can also change it themselves under Settings → Profile."
        submitLabel="Save avatar"
        removeLabel="Remove avatar"
      />

      <div>
        <div className="eyebrow mb-2">Usage across owned organizations</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <UsageMeter label="Organizations owned" used={usage.organizations} limit={limits.maxOrganizations} />
          <UsageMeter label="Public repositories" used={usage.publicRepos} limit={limits.maxPublicRepos} />
          <UsageMeter label="Private repositories" used={usage.privateRepos} limit={limits.maxPrivateRepos} />
          <UsageMeter label="Storage" used={usage.storageBytes} limit={limits.maxStorageBytes} bytes />
        </div>
      </div>

      <Card>
        <CardHeader
          eyebrow="Credentials"
          title={`Access tokens (${tokens.length})`}
          description="Personal access tokens this user created for docker login and the jobs API. Revoking one takes effect within the five-minute registry token lifetime."
        />
        {tokens.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-3">No access tokens.</p>
          </CardBody>
        ) : (
          <div>
            {tokens.map((t) => {
              const expired = expiryState(t.expiresAt).state === "expired";
              return (
                <div key={t.id} data-admin-token-row={t.name} className={`flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5 ${expired ? "opacity-60" : ""}`}>
                  <KeyRound className="size-4 shrink-0 text-ink-3" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{t.name}</span>
                      <Badge>{t.scope === "read" ? "read only" : "read & write"}</Badge>
                      <ExpiryBadge expiresAt={t.expiresAt} />
                    </div>
                    <div className="mt-0.5 text-xs text-ink-2">
                      <span className="font-mono">{t.tokenPrefix}</span> · created {relativeTime(t.createdAt)} · {lastUsedText(t.lastUsedAt, t.lastUsedIp)} ·{" "}
                      {describeRestriction(t.organization?.name ?? null, t.repositories)}
                    </div>
                    {t.description && <div className="mt-0.5 text-xs text-ink-3">{t.description}</div>}
                  </div>
                  <form action={adminRevokeAccessToken}>
                    <input type="hidden" name="id" value={t.id} />
                    <button
                      type="submit"
                      aria-label={`Revoke ${t.name}`}
                      className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </form>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
