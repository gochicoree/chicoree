import Link from "next/link";
import { UserCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { PaginationFooter } from "@/components/ui/pagination";
import { AUDIT_PAGE_SIZE, auditActionTone, auditFilterParams, type AuditFilter, type AuditRow } from "@/lib/audit-shared";
import { paginate, type PageState } from "@/lib/paginate-shared";
import { relativeTime } from "@/lib/format";

function when(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/**
 * Audit entries as expandable rows (native <details>, no client JS): the
 * summary line shows who / what / target, the body the recorded details.
 */
export function AuditTable({
  rows,
  total,
  filter,
  basePath,
  state,
  showOrganization = true,
  title = "Entries",
}: {
  rows: AuditRow[];
  total: number;
  filter: AuditFilter;
  basePath: string;
  /** Page state from queryAudit; derived from the total when not given. */
  state?: PageState;
  showOrganization?: boolean;
  title?: string;
}) {
  const pageState = state ?? paginate(total, filter.page, AUDIT_PAGE_SIZE);

  return (
    <Card>
      <CardHeader
        eyebrow="Audit log"
        title={`${title} (${total.toLocaleString("en-US")})`}
        description={
          total === 0
            ? "Nothing matches this filter yet."
            : `Showing ${pageState.first}–${pageState.last}. Click a row for details.`
        }
      />
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-3">No audit entries.</p>
      ) : (
        <div>
          {rows.map((r) => (
            <details key={r.id} className="group border-b border-line last:border-0" data-audit-id={r.id}>
              <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm hover:bg-card-2 sm:grid-cols-[7rem_minmax(8rem,1.2fr)_auto_minmax(8rem,1.4fr)] sm:px-5 lg:grid-cols-[7rem_minmax(8rem,1.2fr)_auto_minmax(8rem,1.4fr)_8rem_7rem] [&::-webkit-details-marker]:hidden">
                <span className="text-xs text-ink-3 max-sm:col-span-2" title={when(r.createdAt)}>
                  {relativeTime(r.createdAt)}
                </span>
                <span className="min-w-0 truncate">
                  <span className="font-medium">{r.actorLabel || (r.actorType === "system" ? "system" : "—")}</span>
                  {r.actorType !== "user" && r.actorType !== "system" && (
                    <span className="ml-1 text-xs text-ink-3">{r.actorType}</span>
                  )}
                  {r.impersonatorId && (
                    <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-accent-ink" title={`Via impersonation by ${r.impersonatorId}`}>
                      <UserCog className="size-3" /> impersonated
                    </span>
                  )}
                </span>
                <Badge tone={auditActionTone(r.action)} className="justify-self-start font-mono">
                  {r.action}
                </Badge>
                <span className="min-w-0 truncate text-ink-2 max-sm:col-span-2">
                  {r.targetLabel ? (
                    <>
                      {r.targetType && <span className="text-xs text-ink-3">{r.targetType} </span>}
                      <span className="font-mono text-[13px] text-ink">{r.targetLabel}</span>
                    </>
                  ) : r.targetId ? (
                    <span className="font-mono text-xs text-ink-3">{r.targetType ?? ""} {r.targetId.slice(0, 12)}</span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </span>
                <span className="hidden truncate font-mono text-xs text-ink-2 lg:block">
                  {showOrganization && r.organizationSlug ? (
                    <Link href={`/${r.organizationSlug}`} className="hover:underline">
                      {r.organizationSlug}
                    </Link>
                  ) : (
                    ""
                  )}
                </span>
                <span className="hidden truncate font-mono text-xs text-ink-3 lg:block">{r.ip ?? ""}</span>
              </summary>
              <div className="grid gap-3 border-t border-line bg-card-2 px-4 py-3 text-xs sm:grid-cols-[1fr_1fr] sm:px-5">
                <dl className="grid grid-cols-[6rem_1fr] gap-y-1">
                  <dt className="text-ink-3">When</dt>
                  <dd className="font-mono">{when(r.createdAt)}</dd>
                  <dt className="text-ink-3">Actor</dt>
                  <dd className="break-all font-mono">
                    {r.actorType}
                    {r.actorId ? ` · ${r.actorId}` : ""}
                  </dd>
                  {r.impersonatorId && (
                    <>
                      <dt className="text-ink-3">Impersonator</dt>
                      <dd className="break-all font-mono">{r.impersonatorId}</dd>
                    </>
                  )}
                  {r.targetId && (
                    <>
                      <dt className="text-ink-3">Target</dt>
                      <dd className="break-all font-mono">
                        {r.targetType ?? ""} · {r.targetId}
                      </dd>
                    </>
                  )}
                  {r.organizationId && (
                    <>
                      <dt className="text-ink-3">Organization</dt>
                      <dd className="break-all font-mono">{r.organizationSlug ? `${r.organizationSlug} · ` : ""}{r.organizationId}</dd>
                    </>
                  )}
                  <dt className="text-ink-3">IP</dt>
                  <dd className="font-mono">{r.ip ?? "—"}</dd>
                  <dt className="text-ink-3">User agent</dt>
                  <dd className="break-all">{r.userAgent ?? "—"}</dd>
                </dl>
                <div className="min-w-0">
                  <div className="mb-1 text-ink-3">Details</div>
                  <pre className="max-h-64 overflow-auto rounded-md border border-line bg-card px-3 py-2 font-mono text-[11px] leading-relaxed">
                    {r.details ? JSON.stringify(r.details, null, 2) : "{}"}
                  </pre>
                </div>
              </div>
            </details>
          ))}
        </div>
      )}
      <PaginationFooter
        state={pageState}
        noun="entries"
        basePath={basePath}
        params={auditFilterParams(filter)}
        label="Audit log pages"
      />
    </Card>
  );
}
