import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { Trash2 } from "lucide-react";
import { db } from "@/db";
import { organization } from "@/db/schema";
import { listMembersWithUsers } from "@/lib/data";
import { adminRemoveMember } from "@/app/actions/admin-orgs";
import { Card, CardHeader } from "@/components/ui/card";
import { EntityLogo } from "@/components/entity-logo";
import { logoRef } from "@/lib/logo-shared";
import { MemberRoleSelect } from "../org-controls";

export default async function AdminOrganizationMembers({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = await db.query.organization.findFirst({ where: eq(organization.id, id) });
  if (!org) notFound();
  const members = await listMembersWithUsers(org.id);

  return (
    <Card>
      <CardHeader eyebrow="People" title={`Members (${members.length})`} />
      <div>
        {members.map((m) => (
          <div key={m.id} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-0 sm:px-5">
            <EntityLogo kind="user" name={m.userName} logo={logoRef("user", m.userId, m.userLogoVersion)} size={32} />
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
  );
}
