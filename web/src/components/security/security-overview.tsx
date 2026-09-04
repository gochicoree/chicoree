import Link from "next/link";
import { ShieldBan } from "lucide-react";
import type { BlockedImage, SecurityTotals, WorstRepository } from "@/lib/security";
import { formatCount, relativeTime } from "@/lib/format";
import { repoHref } from "@/lib/proxy-shared";
import { StatTile } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { SeverityBar, SeverityChips, totalFindings } from "@/components/severity";

const th = "px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-3 first:pl-5 last:pr-5";
const td = "border-t border-line px-4 py-2 first:pl-5 last:pr-5";
const num = `${td} text-right font-mono tabular-nums`;

/** Severity totals, the worst repositories and the blocked images of one organization or the instance. */
export function SecurityOverview({
  totals,
  worst,
  blocked,
  showOrganization,
}: {
  totals: SecurityTotals;
  worst: WorstRepository[];
  blocked: BlockedImage[];
  showOrganization: boolean;
}) {
  const total = totalFindings(totals.summary);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Critical" value={formatCount(totals.summary.Critical)} detail="in tagged images" />
        <StatTile label="High" value={formatCount(totals.summary.High)} />
        <StatTile label="Medium" value={formatCount(totals.summary.Medium)} />
        <StatTile label="Low / negligible" value={formatCount(totals.summary.Low + totals.summary.Negligible)} detail={`${formatCount(totals.summary.Unknown)} unrated`} />
        <StatTile label="Accepted risks" value={formatCount(totals.accepted)} detail="findings under exceptions" />
        <StatTile label="Pulls blocked" value={formatCount(totals.blocked)} detail="images refusing pulls" />
      </div>

      <Card>
        <CardHeader
          eyebrow="Findings"
          title={`${formatCount(total)} open ${total === 1 ? "finding" : "findings"}`}
          description={`Across ${formatCount(totals.images.scanned)} scanned tagged ${totals.images.scanned === 1 ? "image" : "images"} (multi-arch variants counted separately, identical images once)${totals.images.unscanned ? ` · ${formatCount(totals.images.unscanned)} waiting for a scan` : ""}${totals.images.failed ? ` · ${formatCount(totals.images.failed)} failed` : ""}. Accepted risks are not counted.`}
        />
        <CardBody>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
            <span>By severity</span>
            <SeverityChips summary={totals.summary} status="scanned" />
          </div>
          <SeverityBar summary={totals.summary} />
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader eyebrow="Repositories" title="Most affected" description="Open findings in tagged images, most severe first." />
          {worst.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-3">No open findings in any tagged image.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={th}>Repository</th>
                    <th className={`${th} text-right`}>Images</th>
                    <th className={th}>Findings</th>
                  </tr>
                </thead>
                <tbody>
                  {worst.map((r) => (
                    <tr key={r.id}>
                      <td className={`${td} min-w-0`}>
                        <span className="flex flex-wrap items-center gap-2">
                          <Link href={repoHref(r.orgSlug, r.name)} className="font-mono text-[13px] hover:underline">
                            {showOrganization ? `${r.orgSlug}/${r.name}` : r.name}
                          </Link>
                          <VisibilityBadge visibility={r.visibility} />
                        </span>
                      </td>
                      <td className={num}>{r.images}</td>
                      <td className={td}>
                        <SeverityChips summary={r.summary} status="scanned" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader eyebrow="Pull policy" title="Blocked images" description="Manifests the registry refuses to serve until a re-scan, an exception or a policy change clears them." />
          {blocked.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-3">No image is blocked right now.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={th}>Image</th>
                    <th className={th}>Reason</th>
                    <th className={`${th} text-right`}>Since</th>
                  </tr>
                </thead>
                <tbody>
                  {blocked.map((b) => {
                    const ref = b.tags[0] ?? b.digest;
                    return (
                      <tr key={`${b.repositoryId}-${b.digest}`}>
                        <td className={`${td} min-w-0`}>
                          <Link href={`${repoHref(b.orgSlug, b.repoName)}/tags/${encodeURIComponent(ref)}`} className="inline-flex items-center gap-1.5 font-mono text-[13px] hover:underline">
                            <ShieldBan className="size-3.5 text-danger" />
                            {showOrganization ? `${b.orgSlug}/` : ""}
                            {b.repoName}
                            {b.tags.length ? `:${b.tags.join(",")}` : `@${b.digest.slice(7, 19)}`}
                          </Link>
                        </td>
                        <td className={`${td} max-w-sm text-xs text-ink-2`}>{b.reason}</td>
                        <td className={`${td} whitespace-nowrap text-right text-xs text-ink-3`}>{relativeTime(b.createdAt)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {totals.images.scanned === 0 && totals.images.unscanned > 0 && (
        <p className="text-xs text-ink-3">
          <Badge>waiting</Badge> Images are scanned in the background after each push; totals appear once the first scans finish.
        </p>
      )}
    </div>
  );
}
