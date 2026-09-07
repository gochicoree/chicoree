"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail, Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ASSIGNABLE_ROLES, type OrgRole } from "@/lib/org-roles";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm";
import { EntityLogo } from "@/components/entity-logo";
import type { LogoRef } from "@/lib/logo-shared";

interface MemberRow {
  id: string;
  role: string;
  userId: string;
  name: string;
  email: string;
  /** The member's avatar, when they have one. */
  logo?: LogoRef | null;
}

interface InvitationRow {
  id: string;
  email: string;
  role: string;
}

export function MembersManager({
  organizationId,
  canManage,
  selfUserId,
  members,
  invitations,
  memberLimit = null,
  seatsUsed = 0,
}: {
  organizationId: string;
  canManage: boolean;
  selfUserId: string;
  members: MemberRow[];
  invitations: InvitationRow[];
  /** Administrator-set cap on members; open invitations hold a seat. null = none. */
  memberLimit?: number | null;
  seatsUsed?: number;
}) {
  const full = memberLimit !== null && seatsUsed >= memberLimit;
  const router = useRouter();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await authClient.organization.inviteMember({ email, role, organizationId });
    setBusy(false);
    if (res.error) setError(res.error.message ?? "Could not send the invitation");
    else {
      toast({ title: `Invitation sent to ${email}` });
      setEmail("");
      router.refresh();
    }
  }

  async function changeRole(memberId: string, newRole: string) {
    setError(null);
    const res = await authClient.organization.updateMemberRole({
      memberId,
      role: newRole as OrgRole,
      organizationId,
    });
    if (res.error) setError(res.error.message ?? "Could not change the role");
    else toast({ title: `Role changed to ${newRole}` });
    router.refresh();
  }

  async function remove(memberId: string) {
    setError(null);
    const res = await authClient.organization.removeMember({
      memberIdOrEmail: memberId,
      organizationId,
    });
    if (res.error) setError(res.error.message ?? "Could not remove the member");
    else toast({ title: "Member removed" });
    router.refresh();
  }

  async function cancelInvitation(invitationId: string) {
    await authClient.organization.cancelInvitation({ invitationId });
    toast({ title: "Invitation cancelled" });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      {canManage && (
        <Card>
          <CardHeader
            eyebrow="Access"
            title="Invite a member"
            description="Viewers pull. Members also push. Admins also manage the organization."
            action={
              memberLimit !== null ? (
                <Badge tone={full ? "danger" : "neutral"}>
                  {seatsUsed} of {memberLimit} members
                </Badge>
              ) : undefined
            }
          />
          <CardBody>
            {full && (
              <p className="mb-3 text-sm text-ink-2">
                The member limit is reached. Remove a member or cancel an invitation to invite someone else.
              </p>
            )}
            <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
              <Input
                type="email"
                required
                placeholder="teammate@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-w-52 flex-1"
              />
              <Select
                value={role}
                onChange={(v) => setRole(v as OrgRole)}
                className="w-36"
                aria-label="Role"
                options={ASSIGNABLE_ROLES.map((r) => ({ value: r.value, label: r.label, description: r.description }))}
              />
              <Button type="submit" disabled={busy || full}>
                <Mail className="size-4" /> Invite
              </Button>
            </form>
            {error && (
              <p className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader eyebrow="People" title={`Members (${members.length})`} />
        <div>
          {members.map((m) => (
            <div
              key={m.id}
              className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5"
            >
              <EntityLogo kind="user" name={m.name} logo={m.logo} size={32} />
              <div className="min-w-0 flex-1 basis-40">
                <div className="truncate text-sm font-medium">
                  {m.name}
                  {m.userId === selfUserId && <span className="ml-1.5 text-xs text-ink-3">(you)</span>}
                </div>
                <div className="truncate text-xs text-ink-2">{m.email}</div>
              </div>
              <div className="ml-auto flex items-center gap-2">
              {canManage && m.role !== "owner" ? (
                <Select
                  value={m.role}
                  onChange={(v) => changeRole(m.id, v)}
                  className="w-32"
                  size="sm"
                  align="end"
                  aria-label={`Role of ${m.name}`}
                  options={ASSIGNABLE_ROLES.map((r) => ({ value: r.value, label: r.label, description: r.description }))}
                />
              ) : (
                <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{m.role}</Badge>
              )}
              {canManage && m.role !== "owner" && m.userId !== selfUserId && (
                <button
                  onClick={() =>
                    confirm(
                      {
                        title: `Remove ${m.name}?`,
                        description: "They lose access to this organization's repositories right away. You can invite them again later.",
                        confirmLabel: "Remove member",
                        tone: "danger",
                      },
                      () => remove(m.id),
                    )
                  }
                  aria-label={`Remove ${m.name}`}
                  className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {invitations.length > 0 && (
        <Card>
          <CardHeader eyebrow="Pending" title={`Invitations (${invitations.length})`} />
          <div>
            {invitations.map((inv) => (
              <div
                key={inv.id}
                className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5"
              >
                <Mail className="size-4 shrink-0 text-ink-3" />
                <div className="min-w-0 flex-1 basis-40 truncate text-sm">{inv.email}</div>
                <div className="ml-auto flex items-center gap-2">
                <Badge>invited as {inv.role}</Badge>
                {canManage && (
                  <button
                    onClick={() =>
                      confirm(
                        {
                          title: `Cancel the invitation for ${inv.email}?`,
                          description: "The invitation link stops working. You can send a new one any time.",
                          confirmLabel: "Cancel invitation",
                          tone: "danger",
                        },
                        () => cancelInvitation(inv.id),
                      )
                    }
                    aria-label={`Cancel invitation for ${inv.email}`}
                    className="rounded-md p-1.5 text-ink-3 hover:bg-danger-soft hover:text-danger cursor-pointer"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {dialog}
    </div>
  );
}
