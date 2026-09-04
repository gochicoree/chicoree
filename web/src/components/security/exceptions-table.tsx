"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShieldCheck, Trash2 } from "lucide-react";
import { revokeExceptionAction, type ExceptionResult } from "@/app/actions/security";
import type { ExceptionView } from "@/lib/security";
import { formatDate, relativeTime } from "@/lib/format";
import { repoHref } from "@/lib/proxy-shared";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmModal } from "@/components/ui/modal";
import { PaginationFooter } from "@/components/ui/pagination";
import type { PageState, QueryLike } from "@/lib/paginate-shared";
import { useActionToast } from "@/components/ui/toast";

type Row = Omit<ExceptionView, "expiresAt" | "createdAt"> & { expiresAt: string | null; createdAt: string };

const th = "px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-3 first:pl-5 last:pr-5";
const td = "border-t border-line px-4 py-2 align-top first:pl-5 last:pr-5";

/** Accepted risks with a revoke button for organization managers. */
export function ExceptionsTable({
  rows,
  state: pageState,
  basePath,
  params,
  canManage,
  showOrganization,
}: {
  rows: Row[];
  state: PageState;
  /** Path the pager links to. */
  basePath: string;
  /** The page's other search parameters, kept across page changes. */
  params?: QueryLike;
  canManage: boolean;
  showOrganization: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ExceptionResult | null, FormData>(revokeExceptionAction, null);
  const [revoking, setRevoking] = useState<Row | null>(null);
  useActionToast(state, "Exception revoked", (s) => {
    if (!s.error && s.saved) {
      setRevoking(null);
      router.refresh();
      return true;
    }
    return false;
  });

  return (
    <Card>
      <CardHeader
        eyebrow="Accepted risks"
        title={`Exceptions (${pageState.total.toLocaleString("en-US")})`}
        description="Vulnerabilities taken out of the pull policy with a justification. Findings stay visible in the reports, struck through."
      />
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink-3">
          No exceptions. Managers can accept a finding from the Vulnerabilities tab of any image.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className={th}>Vulnerability</th>
                <th className={th}>Scope</th>
                <th className={th}>Justification</th>
                <th className={th}>Expires</th>
                <th className={`${th} text-right`}>Covers</th>
                {canManage && <th className={`${th} w-10`} aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.expired ? "opacity-60" : undefined}>
                  <td className={`${td} font-mono text-[13px]`}>
                    <span className="inline-flex items-center gap-1.5">
                      <ShieldCheck className="size-3.5 text-ok" />
                      {e.vulnerabilityId}
                    </span>
                    {e.package && <span className="block text-xs text-ink-3">in {e.package}</span>}
                  </td>
                  <td className={`${td} text-xs`}>
                    {e.repoName ? (
                      <Link href={repoHref(e.orgSlug, e.repoName)} className="font-mono text-[13px] hover:underline">
                        {showOrganization ? `${e.orgSlug}/` : ""}
                        {e.repoName}
                      </Link>
                    ) : (
                      <span>
                        <Badge tone="info">organization</Badge>
                        {showOrganization && <span className="ml-1.5 font-mono text-[13px]">{e.orgSlug}</span>}
                      </span>
                    )}
                  </td>
                  <td className={`${td} max-w-md text-xs text-ink-2`}>
                    <span className="line-clamp-2" title={e.justification}>
                      {e.justification}
                    </span>
                    <span className="block text-ink-3">
                      {e.createdByLabel ? `${e.createdByLabel} · ` : ""}
                      {relativeTime(e.createdAt)}
                    </span>
                  </td>
                  <td className={`${td} whitespace-nowrap text-xs`}>
                    {e.expiresAt ? (
                      e.expired ? (
                        <Badge tone="danger">expired {relativeTime(e.expiresAt)}</Badge>
                      ) : (
                        <span title={formatDate(e.expiresAt)}>{relativeTime(e.expiresAt)}</span>
                      )
                    ) : (
                      <span className="text-ink-3">never</span>
                    )}
                  </td>
                  <td className={`${td} text-right font-mono text-[13px] tabular-nums`} title="Findings in tagged images this exception applies to">
                    {e.covers}
                  </td>
                  {canManage && (
                    <td className={`${td} text-right`}>
                      <Button type="button" variant="ghost" size="sm" aria-label="Revoke exception" onClick={() => setRevoking(e)}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <PaginationFooter
        state={pageState}
        noun="exceptions"
        basePath={basePath}
        params={params}
        paramKey="exc"
        label="Exception pages"
      />
      {canManage && (
        <ConfirmModal
          open={!!revoking}
          onClose={() => setRevoking(null)}
          onConfirm={() => {
            if (!revoking) return;
            const fd = new FormData();
            fd.set("id", revoking.id);
            action(fd);
          }}
          title={`Revoke ${revoking?.vulnerabilityId ?? ""}?`}
          description="The finding counts against the pull policy again; images over the threshold are blocked within seconds."
          confirmLabel={pending ? "Revoking…" : "Revoke"}
          tone="danger"
          busy={pending}
        >
          {state?.error && <p className="text-sm text-danger">{state.error}</p>}
        </ConfirmModal>
      )}
    </Card>
  );
}
