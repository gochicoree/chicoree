import type { Metadata } from "next";
import { requireAdmin } from "@/lib/session";
import { blockedImages, listExceptions, searchFindings, securityTotals, worstRepositories } from "@/lib/security";
import { scannerLabel } from "@/lib/scanners";
import { PAGE_SIZES, pageParam } from "@/lib/paginate-shared";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { SecurityOverview } from "@/components/security/security-overview";
import { ExceptionsTable } from "@/components/security/exceptions-table";
import { CveSearch } from "@/components/security/cve-search";
import { AdminNav } from "../admin-nav";

export const metadata: Metadata = { title: "Security" };
export const dynamic = "force-dynamic";

const BASE = "/admin/security";

export default async function AdminSecurityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const params = await searchParams;
  const query = String((Array.isArray(params.q) ? params.q[0] : params.q) ?? "").trim().slice(0, 120);
  const [totals, worst, blocked, exceptions, hits, scanner] = await Promise.all([
    securityTotals(null),
    worstRepositories(null, 10),
    blockedImages(null, pageParam(params, "blocked"), PAGE_SIZES.blockedImages),
    listExceptions(null, { page: pageParam(params, "exc"), pageSize: PAGE_SIZES.exceptions }),
    searchFindings(query, null, pageParam(params, "page"), PAGE_SIZES.cveSearch),
    scannerLabel(),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Vulnerability posture of every tagged image on the instance, images the pull policy blocks, accepted risks, and a search by CVE id or package."
        action={<Badge tone={scanner === "off" ? "neutral" : "ok"}>{scanner === "off" ? "scanning off" : `scanning with ${scanner}`}</Badge>}
      />
      <AdminNav />
      <div className="space-y-6">
        <CveSearch query={query} hits={hits.rows} state={hits.state} basePath={BASE} params={params} />
        <SecurityOverview
          totals={totals}
          worst={worst}
          blocked={blocked.rows}
          blockedState={blocked.state}
          basePath={BASE}
          params={params}
          showOrganization
        />
        <ExceptionsTable
          rows={exceptions.rows.map((e) => ({ ...e, expiresAt: e.expiresAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString() }))}
          state={exceptions.state}
          basePath={BASE}
          params={params}
          canManage
          showOrganization
        />
      </div>
    </>
  );
}
