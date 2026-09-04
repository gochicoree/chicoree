import type { Metadata } from "next";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireAdmin } from "@/lib/session";
import { getInstanceSettings } from "@/lib/instance-settings";
import { recentScans, scanCounts } from "@/lib/scan";
import { relativeTime } from "@/lib/format";
import { repoHref } from "@/lib/proxy-shared";
import { PageHeader, StatTile } from "@/components/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SeverityChips } from "@/components/severity";
import { AdminNav } from "../admin-nav";
import { ScannerForm } from "./scanner-form";
import { RescanButton } from "./rescan-button";

export const metadata: Metadata = { title: "Scanning" };
export const dynamic = "force-dynamic";

const th = "px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-3 first:pl-5 last:pr-5";
const td = "border-t border-line px-4 py-2 align-top first:pl-5 last:pr-5";
const STATUS_TONE: Record<string, "ok" | "danger" | "neutral" | "info"> = { scanned: "ok", failed: "danger", indexing: "info", pending: "neutral" };

export default async function AdminScanningPage() {
  await requireAdmin();
  const [settings, scans, counts, tagged] = await Promise.all([
    getInstanceSettings(),
    recentScans(10),
    scanCounts(),
    db.execute(sql`
      SELECT count(DISTINCT t.manifest_digest)::int AS n FROM tags t
      JOIN manifests m ON m.repository_id = t.repository_id AND m.digest = t.manifest_digest
      WHERE m.media_type NOT LIKE '%index%' AND m.media_type NOT LIKE '%list%'`),
  ]);
  const images = Number(tagged.rows[0]?.n ?? 0);
  const off = settings.scanner.backend === "off";

  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Vulnerability scanner backend, its health, and the state of the scan queue."
        action={<RescanButton images={images} disabled={off} />}
      />
      <AdminNav />

      <div className="space-y-6">
        <ScannerForm values={settings.scanner} source={settings.sources.scanner} />

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Scanned" value={counts.scanned} detail="manifests with a result" />
          <StatTile label="In progress" value={counts.pending + counts.indexing} detail={`${counts.pending} pending · ${counts.indexing} running`} />
          <StatTile label="Failed" value={counts.failed} detail={counts.failed ? "re-scan from the image page or scan-stale" : undefined} />
          <StatTile
            label="Legacy rows"
            value={counts.legacy}
            detail={counts.legacy ? "raw reports; run scan-normalize" : "every scan is normalised"}
          />
        </div>

        <Card>
          <CardHeader
            eyebrow="Queue"
            title="Last 10 scans"
            description="Most recently updated scan records, whichever backend produced them."
            action={
              <Link href="/admin/jobs" className="text-sm text-[var(--action)] hover:underline">
                Jobs (scan-stale, scan-normalize)
              </Link>
            }
          />
          {scans.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-3">No scan has run yet. Push an image, or use Re-scan everything.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={th}>Image</th>
                    <th className={th}>Status</th>
                    <th className={th}>Scanner</th>
                    <th className={th}>Findings</th>
                    <th className={`${th} text-right`}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {scans.map((s) => (
                    <tr key={s.digest}>
                      <td className={`${td} min-w-0 font-mono text-[13px]`}>
                        {s.orgSlug && s.repoName ? (
                          <Link href={`${repoHref(s.orgSlug, s.repoName)}/tags/${encodeURIComponent(s.tags[0] ?? s.digest)}`} className="hover:underline">
                            {s.orgSlug}/{s.repoName}
                            {s.tags.length ? `:${s.tags[0]}` : `@${s.digest.slice(7, 19)}`}
                          </Link>
                        ) : (
                          <span className="text-ink-3">{s.digest.slice(0, 19)}</span>
                        )}
                      </td>
                      <td className={td}>
                        <Badge tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</Badge>
                        {s.error && <span className="mt-1 block max-w-xs truncate text-xs text-danger" title={s.error}>{s.error}</span>}
                      </td>
                      <td className={`${td} text-xs text-ink-2`}>
                        {s.scanner ?? "—"}
                        {s.scannerVersion && <span className="ml-1 font-mono text-ink-3">{s.scannerVersion}</span>}
                      </td>
                      <td className={td}>
                        <SeverityChips summary={s.summary} status={s.status} />
                      </td>
                      <td className={`${td} whitespace-nowrap text-right text-xs text-ink-3`}>{relativeTime(s.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
