import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { listAdminOrganizations } from "@/lib/admin-data";
import { formatBytes, relativeTime } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";
import { AdminNav } from "../admin-nav";

export const metadata: Metadata = { title: "Organizations" };

function limitText(used: number, limit: number | null) {
  return limit === null ? String(used) : `${used} / ${limit}`;
}

export default async function AdminOrganizationsPage() {
  await requireAdmin();
  const orgs = await listAdminOrganizations();

  return (
    <>
      <PageHeader eyebrow="Instance" title="Administration" />
      <AdminNav />
      <Card>
        <CardHeader
          eyebrow="Namespaces"
          title={`Organizations (${orgs.length})`}
          description="Usage against limits. Open an organization to manage members, repositories and limits."
          action={
            <Link href="/admin/organizations/move" className={buttonClasses("secondary", "sm")}>
              Move repositories…
            </Link>
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-5">Organization</th>
                <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 md:table-cell">Members</th>
                <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell">Public repos</th>
                <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell">Private repos</th>
                <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-2">Storage</th>
                <th className="hidden px-4 py-2.5 text-right text-xs font-medium text-ink-2 md:table-cell">Created</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => {
                const overStorage = o.maxStorageBytes !== null && o.storageBytes >= o.maxStorageBytes;
                return (
                  <tr key={o.id} className="border-b border-line last:border-0 hover:bg-card-2">
                    <td className="px-4 py-3 sm:px-5">
                      <Link href={`/admin/organizations/${o.id}`} className="text-sm font-medium hover:underline">
                        {o.name}
                      </Link>
                      <div className="font-mono text-xs text-ink-2">{o.slug}/</div>
                    </td>
                    <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 md:table-cell">{o.memberCount}</td>
                    <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 sm:table-cell">
                      {limitText(o.publicRepos, o.maxPublicRepos)}
                    </td>
                    <td className="hidden px-4 py-3 text-right font-mono text-[13px] tabular-nums text-ink-2 sm:table-cell">
                      {limitText(o.privateRepos, o.maxPrivateRepos)}
                    </td>
                    <td className={`px-4 py-3 text-right font-mono text-[13px] tabular-nums ${overStorage ? "text-danger" : "text-ink-2"}`}>
                      {formatBytes(o.storageBytes)}
                      {o.maxStorageBytes !== null && <span className="text-ink-3"> / {formatBytes(o.maxStorageBytes)}</span>}
                    </td>
                    <td className="hidden px-4 py-3 text-right text-[13px] text-ink-2 md:table-cell">{relativeTime(o.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
