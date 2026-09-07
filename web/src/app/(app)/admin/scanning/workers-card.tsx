import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { relativeTime } from "@/lib/format";
import type { ScanWorkerStats } from "@/lib/scan-tasks";

const th = "px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-3 first:pl-5 last:pr-5";
const td = "border-t border-line px-4 py-2 align-top first:pl-5 last:pr-5";

/** Administration → Scanning: who is taking scans off this host, and what waits for them. */
export function WorkersCard({ stats, enabled, tokenSet }: { stats: ScanWorkerStats; enabled: boolean; tokenSet: boolean }) {
  const online = stats.workers.filter((w) => w.online).length;
  const state = !tokenSet ? "no SCAN_WORKER_TOKEN" : !enabled ? "off" : online === 0 ? "no worker online; scans run here" : `${online} online`;
  return (
    <Card>
      <CardHeader
        eyebrow="Workers"
        title="Scan workers"
        description="Scan workers on other machines take Trivy scans off this host. Without one online for two minutes, queued scans run here."
        action={<Badge tone={enabled && tokenSet && online > 0 ? "ok" : enabled && tokenSet ? "accent" : "neutral"}>{state}</Badge>}
      />
      <CardBody className="space-y-3">
        <dl className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-xs text-ink-3">Queued</dt>
            <dd className="font-mono tabular-nums">{stats.queued}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Running</dt>
            <dd className="font-mono tabular-nums">{stats.leased}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Failed after 3 attempts</dt>
            <dd className="font-mono tabular-nums">{stats.failed}</dd>
          </div>
        </dl>
        {stats.workers.length === 0 ? (
          <p className="text-sm text-ink-3">
            No worker has reported in yet.{" "}
            {tokenSet ? "Start a worker with CHICOREE_URL pointing at this instance and the same SCAN_WORKER_TOKEN." : "Set SCAN_WORKER_TOKEN in the environment first."}
          </p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={th}>Worker</th>
                  <th className={th}>Trivy</th>
                  <th className={th}>Running</th>
                  <th className={th}>Completed</th>
                  <th className={th}>Failed</th>
                  <th className={`${th} text-right`}>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {stats.workers.map((w) => (
                  <tr key={w.name}>
                    <td className={td}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{w.name}</span>
                        <Badge tone={w.online ? "ok" : "neutral"}>{w.online ? "online" : "offline"}</Badge>
                      </div>
                      {w.hostname && w.hostname !== w.name && <div className="text-xs text-ink-3">{w.hostname}</div>}
                      {w.lastError && (
                        <div className="mt-0.5 max-w-md truncate text-xs text-danger" title={w.lastError}>
                          {w.lastError}
                        </div>
                      )}
                    </td>
                    <td className={`${td} font-mono text-xs text-ink-2`}>{w.scannerVersion ?? "—"}</td>
                    <td className={`${td} font-mono tabular-nums`}>{w.running}</td>
                    <td className={`${td} font-mono tabular-nums`}>{w.completed}</td>
                    <td className={`${td} font-mono tabular-nums`}>{w.failed}</td>
                    <td className={`${td} text-right text-xs text-ink-2`}>{relativeTime(w.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
