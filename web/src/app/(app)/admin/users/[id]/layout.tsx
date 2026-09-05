import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { user as userTable } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { NavTabs } from "@/components/ui/nav-tabs";
import { EntityLogo } from "@/components/entity-logo";
import { logoVersionOf, userLogoVersion } from "@/lib/logo";
import { logoRef } from "@/lib/logo-shared";
import { AdminNav } from "../../admin-nav";
import { getInstanceSettings } from "@/lib/instance-settings";

export default async function AdminUserLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const user = await db.query.user.findFirst({ where: eq(userTable.id, id) });
  const gravatar = (await getInstanceSettings()).branding.gravatar;
  if (!user) notFound();
  const base = `/admin/users/${user.id}`;

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
            icon={<EntityLogo kind="user" name={user.name} logo={logoRef("user", user.id, userLogoVersion(user, gravatar))} size={36} />}
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
        </Card>
        <NavTabs
          variant="pills"
          items={[
            { href: base, label: "Overview", exact: true },
            { href: `${base}/limits`, label: "Limits" },
            { href: `${base}/organizations`, label: "Organizations" },
          ]}
        />
        {children}
      </div>
    </>
  );
}
