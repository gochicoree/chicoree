// GET /api/admin/audit.csv?q=&action=&org=&from=&to= — the audit log as CSV
// (newest first, capped at AUDIT_EXPORT_MAX rows). Instance admins may export
// anything; organization owners/admins may export their organization (`org`).
import { NextRequest, NextResponse } from "next/server";
import { getOrgRole, getSession } from "@/lib/session";
import { exportAudit } from "@/lib/audit-query";
import { auditFilterFromParams, auditRowsToCsv } from "@/lib/audit-shared";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const filter = auditFilterFromParams(req.nextUrl.searchParams);
  if (session.user.role !== "admin") {
    if (!filter.organizationId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const role = await getOrgRole(filter.organizationId);
    if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await exportAudit({ filter });
  await recordAudit({
    action: "audit.export",
    organizationId: filter.organizationId || null,
    details: { rows: rows.length, q: filter.q || undefined, action: filter.action || undefined, from: filter.from || undefined, to: filter.to || undefined },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(auditRowsToCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
