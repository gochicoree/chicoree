import Link from "next/link";
import { ExternalLink, X } from "lucide-react";
import { clsx } from "clsx";
import type { AdminChecklist, ChecklistStatus } from "@/lib/admin-checklist";
import { dismissAdminChecklist } from "@/app/actions/onboarding";
import { Card, CardHeader } from "@/components/ui/card";
import { buttonClasses } from "@/components/ui/button";

const DOT: Record<ChecklistStatus, string> = { ok: "bg-ok", warn: "bg-accent", error: "bg-danger", info: "bg-ink-3" };
const LABEL: Record<ChecklistStatus, string> = { ok: "done", warn: "recommended", error: "missing", info: "reminder" };

/** Setup checklist on /admin: what a fresh instance usually still needs. */
export function SetupChecklist({ checklist }: { checklist: AdminChecklist }) {
  const { rows, open } = checklist;
  return (
    <Card className={clsx("mb-6", open > 0 && "border-accent/30")}>
      <CardHeader
        eyebrow="Setup"
        title={open === 0 ? "Setup checklist: all done" : `Setup checklist: ${open} item${open === 1 ? "" : "s"} to look at`}
        description="What a production instance needs. Each row links to where it is configured; close the card when you are done with it."
        action={
          <form action={dismissAdminChecklist}>
            <button type="submit" aria-label="Dismiss setup checklist" data-checklist-dismiss className={buttonClasses("ghost", "sm")}>
              <X className="size-3.5" /> Dismiss
            </button>
          </form>
        }
      />
      <ul data-admin-checklist data-open={open}>
        {rows.map((row) => (
          <li
            key={row.key}
            data-check={row.key}
            data-status={row.status}
            className="flex flex-wrap items-start gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0 sm:px-5"
          >
            <span className={clsx("mt-1.5 size-2.5 shrink-0 rounded-full", DOT[row.status])} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{row.title}</span>
                <span className="text-xs text-ink-3">{LABEL[row.status]}</span>
              </div>
              <p className="mt-0.5 text-[13px] text-ink-2">{row.summary}</p>
            </div>
            {row.external ? (
              <a href={row.href} target="_blank" rel="noopener" className={buttonClasses("ghost", "sm", "shrink-0")}>
                {row.linkLabel} <ExternalLink className="size-3.5" />
              </a>
            ) : (
              <Link href={row.href} className={buttonClasses("ghost", "sm", "shrink-0")}>
                {row.linkLabel}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
