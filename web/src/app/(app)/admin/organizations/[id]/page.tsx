import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { AlertTriangle, Globe } from "lucide-react";
import { db } from "@/db";
import { organizationLimits } from "@/db/schema";
import { getAdminOrgDetail } from "@/lib/admin-data";
import { getOrgProxy } from "@/lib/proxy";
import { displayHost } from "@/lib/proxy-shared";
import { formatDate, relativeTime } from "@/lib/format";
import { UsageMeter } from "@/components/admin/usage-meter";
import { LimitsForm } from "@/components/admin/limits-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";

export default async function AdminOrganizationOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getAdminOrgDetail(id);
  if (!detail) notFound();
  const { org, usage, limits } = detail;
  const [limitsRow, proxy] = await Promise.all([
    db.query.organizationLimits.findFirst({ where: eq(organizationLimits.organizationId, org.id) }),
    getOrgProxy(org.id),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <UsageMeter label="Public repositories" used={usage.publicRepos} limit={limits.maxPublicRepos} />
        <UsageMeter label="Private repositories" used={usage.privateRepos} limit={limits.maxPrivateRepos} />
        <UsageMeter label="Storage" used={usage.storageBytes} limit={limits.maxStorageBytes} bytes />
      </div>
      {proxy && (
        <Card className={proxy.lastError ? "border-danger/30" : undefined}>
          <CardHeader
            eyebrow="Proxy cache"
            title={`Proxy cache of ${displayHost(proxy.upstreamUrl)}`}
            description={`Images pulled as ${org.slug}/<image> are fetched from ${proxy.upstreamUrl} on demand and cached here.`}
            action={
              <span className="flex items-center gap-2">
                <Badge tone={proxy.enabled ? "ok" : "neutral"}>
                  <Globe className="size-3" /> {proxy.enabled ? "enabled" : "paused"}
                </Badge>
                <Link href={`/${org.slug}/settings/proxy`} className="text-sm text-ink-2 hover:text-ink hover:underline">
                  Settings →
                </Link>
              </span>
            }
          />
          <CardBody>
            <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="eyebrow mb-0.5">Credentials</dt>
                <dd>{proxy.auth ? "configured" : "anonymous"}</dd>
              </div>
              <div>
                <dt className="eyebrow mb-0.5">Allowed images</dt>
                <dd className="font-mono text-[13px]">{proxy.allowedPatterns || "everything"}</dd>
              </div>
              <div>
                <dt className="eyebrow mb-0.5">Tag freshness</dt>
                <dd className="font-mono text-[13px]">{proxy.tagTtlSeconds} s</dd>
              </div>
              <div>
                <dt className="eyebrow mb-0.5">Last upstream contact</dt>
                <dd>{proxy.lastCheckedAt ? relativeTime(proxy.lastCheckedAt) : "never"}</dd>
              </div>
              <div>
                <dt className="eyebrow mb-0.5">Configured</dt>
                <dd>{formatDate(proxy.createdAt)}</dd>
              </div>
              <div>
                <dt className="eyebrow mb-0.5">Status</dt>
                <dd className={proxy.lastError ? "text-danger" : "text-ok"}>
                  {proxy.lastError ? (
                    <span className="flex items-start gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      <span className="[overflow-wrap:anywhere]">{proxy.lastError}</span>
                    </span>
                  ) : (
                    "healthy"
                  )}
                </dd>
              </div>
            </dl>
          </CardBody>
        </Card>
      )}
      <LimitsForm scope="organization" targetId={org.id} limits={limits} note={limitsRow?.note ?? ""} />
    </div>
  );
}
