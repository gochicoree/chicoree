"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { ExternalLink, ShieldCheck, Search } from "lucide-react";
import { acceptRiskAction, type ExceptionResult } from "@/app/actions/security";
import { SEVERITIES } from "@/components/severity";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";
import { FINDINGS_PAGE_SIZES, PAGE_SIZES, pageSlice } from "@/lib/paginate-shared";
import { EMPTY_FILTER, filterFindings, type ExceptionRule, type Finding, type FindingFilter, type Severity } from "@/lib/scanner-shared";

export interface FindingRow {
  finding: Finding;
  exception: ExceptionRule | null;
}

function SeverityDot({ severity, className }: { severity: string; className?: string }) {
  const sev = SEVERITIES.find((s) => s.key === severity) ?? SEVERITIES[5];
  return <span aria-hidden title={severity} className={clsx("inline-block size-2 rounded-full", className)} style={{ background: `var(${sev.varName})` }} />;
}

/**
 * Findings of one image with severity / fixed-only / search filters, each
 * row linked to its advisory. Managers get an Accept risk button that opens
 * the exception dialog; accepted findings are struck through with the
 * justification.
 */
export function FindingsTable({
  rows,
  canManage,
  organizationId,
  repositoryId,
}: {
  rows: FindingRow[];
  canManage: boolean;
  organizationId: string;
  repositoryId: string;
}) {
  const [filter, setFilter] = useState<FindingFilter>(EMPTY_FILTER);
  const [accepting, setAccepting] = useState<Finding | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES.findings);
  const visible = useMemo(() => filterFindings(rows, filter), [rows, filter]);
  const present = SEVERITIES.filter((s) => rows.some((r) => r.finding.severity === s.key));
  // Filtering happens in the browser, so the pager lives here: any change to
  // the severity chips, the checkboxes or the search box starts over at page 1.
  useEffect(() => {
    setPage(1);
  }, [filter, rows]);
  const { rows: pageRows, state } = pageSlice(visible, page, pageSize);

  function toggleSeverity(key: Severity) {
    setFilter((f) => ({
      ...f,
      severities: f.severities.includes(key) ? f.severities.filter((s) => s !== key) : [...f.severities, key],
    }));
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by severity">
          {present.map((s) => {
            const active = filter.severities.includes(s.key);
            const n = rows.filter((r) => r.finding.severity === s.key).length;
            return (
              <button
                key={s.key}
                type="button"
                aria-pressed={active}
                onClick={() => toggleSeverity(s.key)}
                className={clsx(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs transition-colors cursor-pointer",
                  active ? "border-ink-3 bg-card-2 text-ink" : "border-line text-ink-2 hover:bg-card-2 hover:text-ink",
                )}
              >
                <SeverityDot severity={s.key} />
                {s.key === "Unknown" ? "unrated" : s.key} {n}
              </button>
            );
          })}
        </div>
        <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
          <input type="checkbox" className="size-3.5 accent-[var(--action)]" checked={filter.fixedOnly} onChange={(e) => setFilter((f) => ({ ...f, fixedOnly: e.target.checked }))} />
          fix available
        </label>
        {rows.some((r) => r.exception) && (
          <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
            <input type="checkbox" className="size-3.5 accent-[var(--action)]" checked={filter.hideAccepted} onChange={(e) => setFilter((f) => ({ ...f, hideAccepted: e.target.checked }))} />
            hide accepted
          </label>
        )}
        <div className="relative ml-auto w-full sm:w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" />
          <Input
            aria-label="Search findings"
            placeholder="CVE id, package, title…"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            className="h-8 pl-8 text-[13px] sm:text-[13px]"
          />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="hidden px-4 py-2.5 text-xs font-medium text-ink-2 sm:table-cell">Severity</th>
              <th className="px-4 py-2.5 text-xs font-medium text-ink-2 sm:px-3">Vulnerability</th>
              <th className="px-3 py-2.5 text-xs font-medium text-ink-2">Package</th>
              <th className="hidden px-3 py-2.5 text-xs font-medium text-ink-2 md:table-cell">Fixed in</th>
              <th className="hidden px-3 py-2.5 text-xs font-medium text-ink-2 lg:table-cell">Type</th>
              {canManage && <th className="w-10 px-2 py-2.5" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={canManage ? 6 : 5} className="px-4 py-6 text-center text-sm text-ink-3">
                  No findings match the filter.
                </td>
              </tr>
            )}
            {pageRows.map(({ finding: f, exception }) => {
              const link = f.links[0] ?? null;
              const accepted = !!exception;
              return (
                <tr key={`${f.package}-${f.version}-${f.id}`} className={clsx("border-b border-line last:border-0", accepted && "bg-card-2/40")}>
                  <td className="hidden px-4 py-2.5 sm:table-cell">
                    <span className={clsx("inline-flex items-center gap-1.5 font-mono text-xs", accepted && "text-ink-3")}>
                      <SeverityDot severity={f.severity} />
                      {f.severity === "Unknown" ? "unrated" : f.severity}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[13px] sm:px-3">
                    <SeverityDot severity={f.severity} className="mr-1.5 align-middle sm:hidden" />
                    <span className={clsx(accepted && "line-through decoration-ink-3 text-ink-3")}>
                      {link ? (
                        <a href={link} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-ink hover:underline">
                          {f.id}
                          <ExternalLink className="size-3 text-ink-3" />
                        </a>
                      ) : (
                        f.id
                      )}
                    </span>
                    {f.title && <span className="block max-w-md truncate font-sans text-xs text-ink-3" title={f.title}>{f.title}</span>}
                    {accepted && (
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 font-sans text-xs text-ink-2">
                        <Badge tone="ok" title={exception.justification}>
                          <ShieldCheck className="size-3" /> accepted{exception.repositoryId ? "" : " (organization)"}
                        </Badge>
                        <span className="max-w-xs truncate" title={exception.justification}>
                          {exception.justification}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className={clsx("px-3 py-2.5 font-mono text-[13px] text-ink-2", accepted && "text-ink-3")}>
                    {f.package}
                    {f.version && <span className="block text-ink-3 sm:inline"> {f.version}</span>}
                    {f.ecosystem && <span className="ml-1 hidden font-sans text-[11px] text-ink-3 sm:inline">{f.ecosystem}</span>}
                    <span className="block text-xs md:hidden">
                      {f.fixedIn ? <span className="text-ok">fixed in {f.fixedIn}</span> : <span className="text-ink-3">no fix yet</span>}
                    </span>
                  </td>
                  <td className="hidden px-3 py-2.5 font-mono text-[13px] md:table-cell">
                    {f.fixedIn ? <span className="text-ok">{f.fixedIn}</span> : <span className="text-ink-3">no fix yet</span>}
                  </td>
                  <td className="hidden px-3 py-2.5 text-xs text-ink-3 lg:table-cell">{f.type}</td>
                  {canManage && (
                    <td className="px-2 py-2 text-right">
                      {!accepted && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => setAccepting(f)} title="Accept this risk: keep the finding but take it out of the pull policy">
                          Accept
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line px-3 py-2.5 sm:px-4">
        <Pagination
          state={state}
          noun="findings"
          onPage={setPage}
          pageSizeOptions={FINDINGS_PAGE_SIZES}
          onPageSize={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          label="Finding pages"
          always
        />
      </div>

      {canManage && (
        <AcceptRiskModal finding={accepting} onClose={() => setAccepting(null)} organizationId={organizationId} repositoryId={repositoryId} />
      )}
    </div>
  );
}

const EXPIRY_OPTIONS = [
  { value: "0", label: "Never", description: "Until revoked" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
];

function AcceptRiskModal({
  finding,
  onClose,
  organizationId,
  repositoryId,
}: {
  finding: Finding | null;
  onClose: () => void;
  organizationId: string;
  repositoryId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [state, action, pending] = useActionState<ExceptionResult | null, FormData>(acceptRiskAction, null);
  const [scope, setScope] = useState("repository");
  const [onlyPackage, setOnlyPackage] = useState(true);
  const [expiry, setExpiry] = useState("90");

  useEffect(() => {
    if (state?.saved) {
      toast({ title: "Risk accepted", description: "The finding no longer counts against the pull policy.", tone: "success" });
      onClose();
      router.refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!finding) return null;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Accept ${finding.id}`}
      description={`${finding.package}${finding.version ? ` ${finding.version}` : ""} · ${finding.severity === "Unknown" ? "unrated" : finding.severity}${finding.fixedIn ? ` · fixed in ${finding.fixedIn}` : ""}`}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form="accept-risk-form" disabled={pending}>
            <ShieldCheck className="size-4" /> {pending ? "Saving…" : "Accept risk"}
          </Button>
        </>
      }
    >
      <form id="accept-risk-form" action={action} className="space-y-4">
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="repositoryId" value={repositoryId} />
        <input type="hidden" name="vulnerabilityId" value={finding.id} />
        <input type="hidden" name="package" value={onlyPackage ? finding.package : ""} />
        <input type="hidden" name="expiresInDays" value={expiry} />
        <Field label="Scope" htmlFor="accept-scope" hint="Organization-wide exceptions cover every repository of the organization.">
          <Select
            id="accept-scope"
            name="scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: "repository", label: "This repository", description: "Only images in this repository" },
              { value: "organization", label: "Whole organization", description: "Every repository of the organization" },
            ]}
          />
        </Field>
        <label className="flex items-start gap-2 text-sm text-ink-2">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--action)]" checked={onlyPackage} onChange={(e) => setOnlyPackage(e.target.checked)} />
          <span>
            Only in package <span className="font-mono text-[13px] text-ink">{finding.package}</span>
            <span className="block text-xs text-ink-3">Unchecked: the vulnerability is accepted in any package.</span>
          </span>
        </label>
        <Field label="Justification" htmlFor="accept-justification" hint="Why the risk is acceptable — not reachable, mitigated elsewhere, false positive… Shown next to the finding and recorded in the audit log.">
          <Textarea id="accept-justification" name="justification" required rows={3} placeholder="The vulnerable code path is not used by this image." />
        </Field>
        <Field label="Expires" htmlFor="accept-expiry" hint="The finding counts again once the exception expires.">
          <Select id="accept-expiry" value={expiry} onChange={setExpiry} options={EXPIRY_OPTIONS} />
        </Field>
        {state?.error && <p className="text-sm text-danger">{state.error}</p>}
      </form>
    </Modal>
  );
}
