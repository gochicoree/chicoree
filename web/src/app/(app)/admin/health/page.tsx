import type { Metadata } from "next";
import { clsx } from "clsx";
import { requireAdmin } from "@/lib/session";
import { runHealthChecks, type HealthStatus } from "@/lib/health";
import { env } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CommandLine } from "@/components/ui/copy";
import { AdminNav } from "../admin-nav";
import { RefreshButton } from "./refresh-button";

export const metadata: Metadata = { title: "Health" };
export const dynamic = "force-dynamic";

const DOT: Record<HealthStatus, string> = {
  ok: "bg-ok",
  warn: "bg-accent",
  error: "bg-danger",
  none: "bg-ink-3",
};
const LABEL: Record<HealthStatus, string> = { ok: "healthy", warn: "attention", error: "failing", none: "not configured" };
const TONE: Record<HealthStatus, "ok" | "accent" | "danger" | "neutral"> = { ok: "ok", warn: "accent", error: "danger", none: "neutral" };

export default async function AdminHealthPage() {
  await requireAdmin();
  const checks = await runHealthChecks();
  const worst: HealthStatus = checks.some((c) => c.status === "error") ? "error" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  const checkedAt = new Date();

  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Live checks against the registry, the database, the vulnerability scanner, the token keys and the background machinery. Each probe times out after 3 seconds."
        action={
          <>
            <Badge tone={TONE[worst]}>{worst === "ok" ? "all systems healthy" : worst === "warn" ? "needs attention" : "problems found"}</Badge>
            <RefreshButton />
          </>
        }
      />
      <AdminNav />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-health-checked-at={checkedAt.toISOString()}>
        {checks.map((c) => (
          <Card key={c.key} className="flex flex-col" >
            <CardHeader
              title={c.title}
              description={c.summary}
              action={
                <span className="inline-flex items-center gap-1.5 text-xs text-ink-2" data-health={c.key} data-status={c.status}>
                  <span className={clsx("size-2.5 rounded-full", DOT[c.status])} aria-hidden />
                  {LABEL[c.status]}
                  {c.latencyMs !== undefined && <span className="font-mono text-ink-3">· {c.latencyMs} ms</span>}
                </span>
              }
            />
            {c.details.length > 0 && (
              <CardBody className="flex-1">
                <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-[13px]">
                  {c.details.map((d) => (
                    <div key={d.label} className="contents">
                      <dt className="truncate text-ink-3">{d.label}</dt>
                      <dd className="min-w-0 break-all font-mono text-xs leading-relaxed text-ink">{d.value}</dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            )}
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader
          eyebrow="Monitoring"
          title="Uptime endpoint"
          description="GET /api/health needs no credentials, pings the database and the registry, and answers 200 or 503 with a small JSON body — point your uptime monitor at it."
        />
        <CardBody className="space-y-2">
          <CommandLine command={`curl -fsS ${env.appUrl}/api/health`} />
          <p className="text-xs text-ink-3">
            Checked {checkedAt.toISOString()}. The cards above re-run on every load; use Refresh after fixing something.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
