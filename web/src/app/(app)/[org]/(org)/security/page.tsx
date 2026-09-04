import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { blockedImages, listExceptions, securityTotals, worstRepositories } from "@/lib/security";
import { scannerLabel } from "@/lib/scanners";
import { PAGE_SIZES, pageParam } from "@/lib/paginate-shared";
import { SecurityOverview } from "@/components/security/security-overview";
import { ExceptionsTable } from "@/components/security/exceptions-table";

export const metadata: Metadata = { title: "Security" };

/** Organization-wide vulnerability posture for members; managers can revoke exceptions. */
export default async function OrgSecurityPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx || !ctx.role) notFound();
  const canManage = ctx.role === "owner" || ctx.role === "admin";
  const query = await searchParams;
  const [totals, worst, blocked, exceptions, scanner] = await Promise.all([
    securityTotals(ctx.org.id),
    worstRepositories(ctx.org.id, 10),
    blockedImages(ctx.org.id, pageParam(query, "blocked"), PAGE_SIZES.blockedImages),
    listExceptions(ctx.org.id, { page: pageParam(query, "exc"), pageSize: PAGE_SIZES.exceptions }),
    scannerLabel(),
  ]);
  const basePath = `/${slug}/security`;

  return (
    <div className="space-y-6">
      {scanner === "off" && (
        <div className="rounded-xl border border-line bg-card px-4 py-3 text-sm text-ink-2">
          Vulnerability scanning is switched off on this instance; the numbers below come from earlier scans.
        </div>
      )}
      <SecurityOverview
        totals={totals}
        worst={worst}
        blocked={blocked.rows}
        blockedState={blocked.state}
        basePath={basePath}
        params={query}
        showOrganization={false}
      />
      <ExceptionsTable
        rows={exceptions.rows.map((e) => ({ ...e, expiresAt: e.expiresAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString() }))}
        state={exceptions.state}
        basePath={basePath}
        params={query}
        canManage={canManage}
        showOrganization={false}
      />
    </div>
  );
}
