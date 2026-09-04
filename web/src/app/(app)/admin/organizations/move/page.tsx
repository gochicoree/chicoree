import type { Metadata } from "next";
import { db } from "@/db";
import { organizationProxies } from "@/db/schema";
import { requireAdmin } from "@/lib/session";
import { listAllRepositories } from "@/lib/repo-move";
import { listAdminOrganizations } from "@/lib/admin-data";
import { env } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { AdminNav } from "../../admin-nav";
import { BulkMoveForm } from "./bulk-move-form";

export const metadata: Metadata = { title: "Move repositories" };
export const dynamic = "force-dynamic";

export default async function AdminMoveRepositoriesPage() {
  await requireAdmin();
  const [orgs, repos, proxyRows] = await Promise.all([
    listAdminOrganizations(),
    listAllRepositories(),
    db.query.organizationProxies.findMany({ columns: { organizationId: true } }),
  ]);
  const proxies = new Set(proxyRows.map((p) => p.organizationId));

  return (
    <>
      <PageHeader eyebrow="Instance" title="Administration" />
      <AdminNav />
      <BulkMoveForm
        registryHost={env.registryHost}
        organizations={orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, proxy: proxies.has(o.id) }))}
        repositories={repos}
      />
    </>
  );
}
