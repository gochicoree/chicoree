import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getOrgContext } from "@/lib/session";
import { blockedImages, listExceptions, securityTotals, worstRepositories } from "@/lib/security";
import { scannerLabel } from "@/lib/scanners";
import { SecurityOverview } from "@/components/security/security-overview";
import { ExceptionsTable } from "@/components/security/exceptions-table";

export const metadata: Metadata = { title: "Security" };

/** Organization-wide vulnerability posture for members; managers can revoke exceptions. */
export default async function OrgSecurityPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx || !ctx.role) notFound();
  const canManage = ctx.role === "owner" || ctx.role === "admin";
  const [totals, worst, blocked, exceptions, scanner] = await Promise.all([
    securityTotals(ctx.org.id),
    worstRepositories(ctx.org.id, 10),
    blockedImages(ctx.org.id, 50),
    listExceptions(ctx.org.id),
    scannerLabel(),
  ]);

  return (
    <div className="space-y-6">
      {scanner === "off" && (
        <div className="rounded-xl border border-line bg-card px-4 py-3 text-sm text-ink-2">
          Vulnerability scanning is switched off on this instance; the numbers below come from earlier scans.
        </div>
      )}
      <SecurityOverview totals={totals} worst={worst} blocked={blocked} showOrganization={false} />
      <ExceptionsTable
        rows={exceptions.map((e) => ({ ...e, expiresAt: e.expiresAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString() }))}
        canManage={canManage}
        showOrganization={false}
      />
    </div>
  );
}
