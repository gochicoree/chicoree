import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/session";
import { getInstanceSettings } from "@/lib/instance-settings";
import { env } from "@/lib/env";
import {
  accountOverview,
  actorBreakdown,
  automationOverview,
  scanOverview,
  storageByOrganization,
  toBytesSeries,
  topRepositories,
  topRepositoriesByEgress,
  toSeries,
  trafficByOrganization,
  trafficBytesSeries,
  trafficSeries,
} from "@/lib/admin-stats";
import { formatBytes, formatCount } from "@/lib/format";
import { repoHref } from "@/lib/proxy-shared";
import { PageHeader, StatTile } from "@/components/page-header";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, VisibilityBadge } from "@/components/ui/badge";
import { PullsChart } from "@/components/pulls-chart";
import { SeverityBar, SeverityChips } from "@/components/severity";
import { AdminNav } from "../admin-nav";
import { MetricsForm } from "./metrics-form";

export const metadata: Metadata = { title: "Metrics" };

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function Table({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

const th = "px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-3 first:pl-5 last:pr-5";
const td = "border-t border-line px-4 py-2 first:pl-5 last:pr-5";
const num = `${td} text-right font-mono tabular-nums`;

export default async function AdminMetricsPage() {
  await requireAdmin();
  const [traffic, top, orgs, scans, accounts, automation, actors, settings, bytesSeries, topEgress, orgTraffic] = await Promise.all([
    trafficSeries(30),
    topRepositories(8),
    storageByOrganization(),
    scanOverview(),
    accountOverview(),
    automationOverview(),
    actorBreakdown(),
    getInstanceSettings(),
    trafficBytesSeries(30),
    topRepositoriesByEgress(8),
    trafficByOrganization(),
  ]);
  const last7 = traffic.slice(-7);
  const pulls30 = sum(traffic.map((d) => d.pulls));
  const pushes30 = sum(traffic.map((d) => d.pushes));
  const pulls7 = sum(last7.map((d) => d.pulls));
  const pushes7 = sum(last7.map((d) => d.pushes));
  const totalBytes = Math.max(sum(orgs.map((o) => o.bytes)), 1);
  const egress30 = sum(bytesSeries.map((d) => d.egress));
  const ingress30 = sum(bytesSeries.map((d) => d.ingress));
  const redirect30 = sum(bytesSeries.map((d) => d.redirect));
  const egress7 = sum(bytesSeries.slice(-7).map((d) => d.egress));
  const ingress7 = sum(bytesSeries.slice(-7).map((d) => d.ingress));
  const orgEgressTotal = Math.max(sum(orgTraffic.map((o) => o.egress30d + o.redirect30d)), 1);
  const actorLabel: Record<string, string> = { user: "Users", sa: "Service accounts", anonymous: "Anonymous" };

  return (
    <>
      <PageHeader
        eyebrow="Instance"
        title="Administration"
        description="Traffic, storage, scanning and account statistics, and the Prometheus endpoint for the rest."
      />
      <AdminNav />

      <section className="space-y-6">
        <div>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Pulls, 7 days" value={formatCount(pulls7)} detail={`${formatCount(pulls30)} in 30 days`} />
            <StatTile label="Pushes, 7 days" value={formatCount(pushes7)} detail={`${formatCount(pushes30)} in 30 days`} />
            <StatTile label="Busiest day" value={formatCount(Math.max(0, ...traffic.map((d) => d.pulls + d.pushes)))} detail="events, last 30 days" />
            <StatTile
              label="Pulls per push"
              value={pushes30 ? (pulls30 / pushes30).toFixed(1) : "–"}
              detail="30-day ratio"
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader eyebrow="Traffic" title="Pulls per day" description="Manifest pulls, last 30 days." />
              <CardBody>
                <PullsChart data={toSeries(traffic, "pulls")} />
              </CardBody>
            </Card>
            <Card>
              <CardHeader eyebrow="Traffic" title="Pushes per day" description="Manifests pushed or imported, last 30 days." />
              <CardBody>
                <PullsChart data={toSeries(traffic, "pushes")} />
              </CardBody>
            </Card>
          </div>
        </div>

        <div>
          <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Egress, 7 days" value={formatBytes(egress7)} detail={`${formatBytes(egress30)} in 30 days`} />
            <StatTile label="Ingress, 7 days" value={formatBytes(ingress7)} detail={`${formatBytes(ingress30)} in 30 days`} />
            <StatTile
              label="Redirected, 30 days"
              value={formatBytes(redirect30)}
              detail={redirect30 ? "served by the storage backend" : "no storage redirects"}
            />
            <StatTile
              label="Busiest day"
              value={formatBytes(Math.max(0, ...bytesSeries.map((d) => d.egress + d.ingress)))}
              detail="bytes moved, last 30 days"
            />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader eyebrow="Traffic" title="Egress per day" description="Bytes served by the registry (layers and manifests), last 30 days." />
              <CardBody>
                <PullsChart data={toBytesSeries(bytesSeries, "egress")} kind="bytes" />
              </CardBody>
            </Card>
            <Card>
              <CardHeader eyebrow="Traffic" title="Ingress per day" description="Bytes received from pushes and imports, last 30 days." />
              <CardBody>
                <PullsChart data={toBytesSeries(bytesSeries, "ingress")} kind="bytes" />
              </CardBody>
            </Card>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader eyebrow="Repositories" title="Most egress" description="Bytes served per repository in the last 30 days; redirected bytes left the storage backend directly." />
            {topEgress.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-3">No traffic recorded yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Repository</th>
                    <th className={`${th} text-right`}>Egress</th>
                    <th className={`${th} text-right`}>Redirected</th>
                    <th className={`${th} text-right`}>Blob pulls</th>
                  </tr>
                </thead>
                <tbody>
                  {topEgress.map((r) => (
                    <tr key={r.id}>
                      <td className={`${td} min-w-0`}>
                        <Link href={`/${r.org}/${r.name}`} className="font-mono text-[13px] hover:underline">
                          {r.org}/{r.name}
                        </Link>
                      </td>
                      <td className={num}>{formatBytes(r.egress30d)}</td>
                      <td className={num}>{r.redirect30d ? formatBytes(r.redirect30d) : "–"}</td>
                      <td className={num}>{formatCount(r.blobPulls30d)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader eyebrow="Organizations" title="Traffic by organization" description="Egress and ingress per organization, last 30 days." />
            <Table>
              <thead>
                <tr>
                  <th className={th}>Organization</th>
                  <th className={`${th} text-right`}>Egress</th>
                  <th className={`${th} text-right`}>Ingress</th>
                  <th className={`${th} w-32`}>Share</th>
                </tr>
              </thead>
              <tbody>
                {orgTraffic.map((o) => (
                  <tr key={o.id}>
                    <td className={`${td} min-w-0`}>
                      <Link href={`/admin/organizations/${o.id}`} className="font-medium hover:underline">
                        {o.name}
                      </Link>
                      <span className="ml-2 font-mono text-xs text-ink-3">{o.slug}</span>
                    </td>
                    <td className={num} title={o.redirect30d ? `${formatBytes(o.redirect30d)} of it redirected to storage` : undefined}>
                      {formatBytes(o.egress30d + o.redirect30d)}
                    </td>
                    <td className={num}>{formatBytes(o.ingress30d)}</td>
                    <td className={td}>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                          <div
                            className="h-full rounded-full bg-[var(--brand)]"
                            style={{ width: `${Math.round(((o.egress30d + o.redirect30d) / orgEgressTotal) * 100)}%` }}
                          />
                        </div>
                        <span className="w-9 text-right font-mono text-xs tabular-nums text-ink-3">
                          {Math.round(((o.egress30d + o.redirect30d) / orgEgressTotal) * 100)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader eyebrow="Repositories" title="Most pulled" description="Pulls in the last 30 days, with the all-time count." />
            {top.byPulls.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-3">No repositories yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Repository</th>
                    <th className={`${th} text-right`}>30 days</th>
                    <th className={`${th} text-right`}>All time</th>
                  </tr>
                </thead>
                <tbody>
                  {top.byPulls.map((r) => (
                    <tr key={r.id}>
                      <td className={`${td} min-w-0`}>
                        <Link href={repoHref(r.org, r.name)} className="font-mono text-[13px] hover:underline">
                          {r.org}/{r.name}
                        </Link>
                      </td>
                      <td className={num}>{formatCount(r.pulls30d)}</td>
                      <td className={num}>{formatCount(r.pullsTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader eyebrow="Repositories" title="Largest" description="Logical size: every blob the repository references, counted once per repository." />
            {top.bySize.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-3">No repositories yet.</p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <th className={th}>Repository</th>
                    <th className={`${th} text-right`}>Tags</th>
                    <th className={`${th} text-right`}>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {top.bySize.map((r) => (
                    <tr key={r.id}>
                      <td className={`${td} min-w-0`}>
                        <span className="flex items-center gap-2">
                          <Link href={repoHref(r.org, r.name)} className="font-mono text-[13px] hover:underline">
                            {r.org}/{r.name}
                          </Link>
                          <VisibilityBadge visibility={r.visibility} />
                        </span>
                      </td>
                      <td className={num}>{r.tags}</td>
                      <td className={num}>{formatBytes(r.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader eyebrow="Storage" title="By organization" description="Logical bytes per organization and their share of the instance." />
          <Table>
            <thead>
              <tr>
                <th className={th}>Organization</th>
                <th className={`${th} text-right`}>Members</th>
                <th className={`${th} text-right`}>Repositories</th>
                <th className={`${th} text-right`}>Manifests</th>
                <th className={`${th} text-right`}>Size</th>
                <th className={`${th} w-40`}>Share</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td className={td}>
                    <Link href={`/admin/organizations/${o.id}`} className="font-medium hover:underline">
                      {o.name}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-ink-3">{o.slug}</span>
                  </td>
                  <td className={num}>{o.members}</td>
                  <td className={num}>{o.repos}</td>
                  <td className={num}>{o.manifests}</td>
                  <td className={num}>{formatBytes(o.bytes)}</td>
                  <td className={td}>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${Math.round((o.bytes / totalBytes) * 100)}%` }} />
                      </div>
                      <span className="w-9 text-right font-mono text-xs tabular-nums text-ink-3">
                        {Math.round((o.bytes / totalBytes) * 100)}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader
              eyebrow="Security"
              title="Vulnerability scanning"
              description={env.clairEnabled ? "Scan records are shared per manifest digest across repositories." : "Scanning is disabled on this instance."}
            />
            <CardBody className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatTile label="Scanned" value={formatCount(scans.scanned)} />
                <StatTile label="Waiting" value={formatCount(scans.pending)} detail="pending or indexing" />
                <StatTile label="Failed" value={formatCount(scans.failed)} />
                <StatTile label="With critical findings" value={formatCount(scans.withCritical)} />
                <StatTile label="With high findings" value={formatCount(scans.withHigh)} />
                <StatTile label="Blocked by policy" value={formatCount(scans.blocked)} detail="manifests refusing pulls" />
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-ink-3">
                  <span>Findings across all scanned images</span>
                  <SeverityChips summary={scans.findings} />
                </div>
                <SeverityBar summary={scans.findings} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader eyebrow="People" title="Accounts and access" description="Who can reach the registry and how." />
            <CardBody>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatTile label="Users" value={formatCount(accounts.users)} detail={`${accounts.admins} admin${accounts.admins === 1 ? "" : "s"}`} />
                <StatTile label="Active, 7 days" value={formatCount(accounts.active7d)} detail="signed-in users" />
                <StatTile label="New, 30 days" value={formatCount(accounts.new30d)} />
                <StatTile label="Two-factor" value={formatCount(accounts.twoFactor)} detail={`${accounts.passkeys} with passkeys`} />
                <StatTile label="Open sessions" value={formatCount(accounts.sessions)} detail={accounts.banned ? `${accounts.banned} banned` : undefined} />
                <StatTile label="Access tokens" value={formatCount(accounts.tokens)} detail={`${accounts.tokensUsed7d} used this week`} />
                <StatTile label="Service accounts" value={formatCount(accounts.serviceAccounts)} detail={`${accounts.serviceAccountsUsed7d} used this week`} />
                {actors.map((a) => (
                  <StatTile
                    key={a.actor}
                    label={`${actorLabel[a.actor] ?? a.actor}, 30 days`}
                    value={formatCount(a.pulls + a.pushes)}
                    detail={`${formatCount(a.pulls)} pulls · ${formatCount(a.pushes)} pushes`}
                  />
                ))}
              </div>
            </CardBody>
          </Card>
        </div>

        <Card>
          <CardHeader
            eyebrow="Automation"
            title="Mirrors, webhooks and jobs"
            description="Outcomes over the last 7 days."
            action={
              <Link href="/admin/jobs" className="text-sm text-[var(--action)] hover:underline">
                Jobs
              </Link>
            }
          />
          <CardBody>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile label="Mirrors" value={formatCount(automation.mirrors)} detail={`${automation.mirrorsEnabled} enabled`} />
              <StatTile
                label="Mirror runs"
                value={formatCount(automation.mirrorOk7d + automation.mirrorFailed7d)}
                detail={automation.mirrorFailed7d ? `${automation.mirrorFailed7d} failed` : "none failed"}
              />
              <StatTile label="Webhooks" value={formatCount(automation.webhooks)} />
              <StatTile
                label="Deliveries"
                value={formatCount(automation.deliveriesOk7d + automation.deliveriesFailed7d)}
                detail={automation.deliveriesFailed7d ? `${automation.deliveriesFailed7d} failed` : "none failed"}
              />
              <StatTile
                label="Job runs"
                value={formatCount(automation.jobsOk7d + automation.jobsFailed7d)}
                detail={automation.jobsFailed7d ? `${automation.jobsFailed7d} failed` : "none failed"}
              />
              <div className="flex items-center justify-center rounded-xl border border-dashed border-line px-3 py-3 text-center text-xs text-ink-3">
                {automation.mirrorFailed7d + automation.deliveriesFailed7d + automation.jobsFailed7d === 0 ? (
                  <Badge tone="ok">all healthy</Badge>
                ) : (
                  <Badge tone="danger">failures this week</Badge>
                )}
              </div>
            </div>
          </CardBody>
        </Card>

        <MetricsForm
          enabled={settings.metrics.enabled}
          token={settings.metrics.token}
          scrapeUrl={`${env.appUrl}/api/metrics`}
          source={settings.sources.metrics}
        />
      </section>
    </>
  );
}
