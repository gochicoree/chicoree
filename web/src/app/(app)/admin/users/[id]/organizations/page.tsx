import Link from "next/link";
import { notFound } from "next/navigation";
import { getAdminUserDetail } from "@/lib/admin-data";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EntityLogo } from "@/components/entity-logo";
import { logoRef } from "@/lib/logo-shared";

export default async function AdminUserOrganizations({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getAdminUserDetail(id);
  if (!detail) notFound();
  const { memberships } = detail;

  return (
    <Card>
      <CardHeader eyebrow="Memberships" title={`Organizations (${memberships.length})`} />
      {memberships.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-3">Not a member of any organization.</p>
      ) : (
        <div>
          {memberships.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 sm:px-5">
              <EntityLogo kind="organization" name={m.name} logo={logoRef("organization", m.id, m.logoVersion)} size={20} />
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
  );
}
