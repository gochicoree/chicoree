import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { organization } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { formatDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { NavTabs } from "@/components/ui/nav-tabs";
import { AdminNav } from "../../admin-nav";

export default async function AdminOrganizationLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const org = await db.query.organization.findFirst({ where: eq(organization.id, id) });
  if (!org) notFound();
  const base = `/admin/organizations/${org.id}`;

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
        <NavTabs
          variant="pills"
          items={[
            { href: base, label: "Overview", exact: true },
            { href: `${base}/members`, label: "Members" },
            { href: `${base}/repositories`, label: "Repositories" },
            { href: `${base}/danger`, label: "Danger zone" },
          ]}
        />
        {children}
      </div>
    </>
  );
}
