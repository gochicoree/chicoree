import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Minus, Plus } from "lucide-react";
import { getOrgContext } from "@/lib/session";
import { getRepoByPath, repoTagOverview } from "@/lib/data";
import { env } from "@/lib/env";
import { scanningEnabled } from "@/lib/scanners";
import { formatBytes, formatDate, relativeTime } from "@/lib/format";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";
import { redirectMovedRepository } from "@/lib/redirects";
import { loadCompareSide, type CompareSide } from "@/lib/compare";
import {
  commonPlatforms,
  diffAnnotations,
  diffConfig,
  diffFindings,
  diffLayers,
  signedDelta,
  type ConfigDiffRow,
  type Finding,
} from "@/lib/compare-shared";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Digest } from "@/components/ui/copy";
import { Tabs } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { SEVERITIES, SeverityChips, totalFindings } from "@/components/severity";
import { CompareBar } from "./compare-bar";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string; repo: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org: orgSlug, repo: rawRepo } = await params;
  const sp = await searchParams;
  const repoName = decodeRepoParam(rawRepo);
  const fromParam = first(sp.from)?.trim() || null;
  const toParam = first(sp.to)?.trim() || null;
  const platformParam = first(sp.platform)?.trim() || null;

  const found = await getRepoByPath(orgSlug, repoName);
  if (!found) {
    const q = new URLSearchParams();
    if (fromParam) q.set("from", fromParam);
    if (toParam) q.set("to", toParam);
    if (platformParam) q.set("platform", platformParam);
    const qs = q.toString();
    await redirectMovedRepository(orgSlug, repoName, `/compare${qs ? `?${qs}` : ""}`);
  }
  const ctx = await getOrgContext(orgSlug);
  const role = ctx?.role ?? null;
  if (found!.repo.visibility === "private" && !role) notFound();
  const repo = found!.repo;
  const base = repoHref(orgSlug, repoName);
  const { names: tagNames } = await repoTagOverview(repo.id);
  // Defaults: the newest two tags (the newer one on the right).
  const fromRef = fromParam ?? tagNames[1] ?? null;
  const toRef = toParam ?? tagNames[0] ?? null;
  const scanning = await scanningEnabled();

  const repoInfo = { id: repo.id, orgSlug, name: repoName };
  let a: CompareSide | null = null;
  let b: CompareSide | null = null;
  let error: string | null = null;
  let platforms: string[] = [];
  let disjoint = false;
  let platform = platformParam;
  if (fromRef && toRef) {
    const [ra, rb] = await Promise.all([loadCompareSide(repoInfo, fromRef, platform), loadCompareSide(repoInfo, toRef, platform)]);
    if ("error" in ra) error = ra.error;
    else if ("error" in rb) error = rb.error;
    else {
      a = ra;
      b = rb;
      if (a.platforms.length || b.platforms.length) {
        const c = commonPlatforms(a.platforms.length ? a.platforms : [a.platform ?? ""], b.platforms.length ? b.platforms : [b.platform ?? ""]);
        platforms = c.common.filter(Boolean);
        disjoint = c.disjoint;
        // No platform asked for: settle on the first common one and reload
        // whichever side picked a different child by default.
        if (!platform && !disjoint) platform = platforms[0] ?? null;
        if (platform) {
          if (a.indexDigest && a.platform !== platform && a.platforms.includes(platform)) {
            const r = await loadCompareSide(repoInfo, fromRef, platform);
            if (!("error" in r)) a = r;
          }
          if (b.indexDigest && b.platform !== platform && b.platforms.includes(platform)) {
            const r = await loadCompareSide(repoInfo, toRef, platform);
            if (!("error" in r)) b = r;
          }
        }
      }
    }
  }

  const layerDiff = a && b ? diffLayers(a.layers, b.layers) : null;
  const configRows = a && b ? diffConfig(a.config, b.config) : [];
  const annotationRows = a && b ? diffAnnotations(a.annotations, b.annotations) : [];
  const configChanged = configRows.filter((r) => r.changed).length;
  const annotationsChanged = annotationRows.filter((r) => r.changed).length;
  const bothScanned = !!a?.scan && !!b?.scan && a.scan.status === "scanned" && b.scan.status === "scanned";
  const findings = a && b && bothScanned ? diffFindings(a.scan!.findings, b.scan!.findings) : null;

  return (
    <div className="space-y-6">
      <div>
        <Link href={base} className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink">
          <ArrowLeft className="size-4" /> {orgSlug}/{repoName}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow mb-1">Compare</div>
            <h1 className="break-all font-display text-xl font-bold tracking-tight">
              <span className="text-ink-2">{repoName}</span>
              {a && b && (
                <>
                  <span className="text-ink-3">:</span>
                  {label(a)} <span className="text-ink-3">→</span> {label(b)}
                </>
              )}
            </h1>
          </div>
          <CompareBar base={base} tags={tagNames} from={fromRef} to={toRef} platform={platform} platforms={platforms} />
        </div>
      </div>

      {tagNames.length < 2 && !fromRef && (
        <Notice>This repository needs at least two tags to compare.</Notice>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      {a && b && fromRef === toRef && <Notice>Pick two different references.</Notice>}
      {disjoint && a && b && (
        <Notice tone="danger">
          The two images share no platform ({a.platforms.join(", ") || a.platform} vs {b.platforms.join(", ") || b.platform}); comparing{" "}
          {a.platform ?? "?"} with {b.platform ?? "?"}.
        </Notice>
      )}

      {a && b && layerDiff && (
        <>
          <Card>
            <CardHeader eyebrow="Summary" title="What changed" description={platform ? `Platform ${platform}` : undefined} />
            <CardBody>
              <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-start">
                <SideSummary side={a} title="From" base={base} />
                <div className="flex flex-row flex-wrap gap-2 md:flex-col md:pt-6">
                  <DeltaChip label="size" value={signedDelta(b.totalSize - a.totalSize, formatBytes)} tone={b.totalSize === a.totalSize ? "neutral" : b.totalSize > a.totalSize ? "danger" : "ok"} />
                  <DeltaChip
                    label="layers"
                    value={layerDiff.added === 0 && layerDiff.removed === 0 ? "unchanged" : `+${layerDiff.added} −${layerDiff.removed}`}
                    tone={layerDiff.added === 0 && layerDiff.removed === 0 ? "neutral" : "info"}
                  />
                  <DeltaChip label="config" value={configChanged === 0 ? "unchanged" : `${configChanged} changed`} tone={configChanged === 0 ? "neutral" : "info"} />
                  {scanning && findings && (
                    <DeltaChip
                      label="findings"
                      value={findings.added.length === 0 && findings.fixed.length === 0 ? "unchanged" : `+${findings.added.length} −${findings.fixed.length}`}
                      tone={findings.added.length > 0 ? "danger" : findings.fixed.length > 0 ? "ok" : "neutral"}
                    />
                  )}
                </div>
                <SideSummary side={b} title="To" base={base} />
              </div>
            </CardBody>
          </Card>

          <Tabs
            tabs={[
              {
                label: "Layers",
                badge: layerDiff.added + layerDiff.removed > 0 ? `+${layerDiff.added} −${layerDiff.removed}` : layerDiff.unchanged,
                content: <LayerDiffTable diff={layerDiff} />,
              },
              {
                label: "Config",
                badge: configChanged || undefined,
                content: <RowsTable rows={configRows} from={label(a)} to={label(b)} grouped emptyText="Neither image carries a config." />,
              },
              ...(scanning
                ? [
                    {
                      label: "Vulnerabilities",
                      badge: findings ? (findings.added.length + findings.fixed.length > 0 ? `+${findings.added.length} −${findings.fixed.length}` : findings.unchanged.length) : undefined,
                      content: <FindingsDiffPanel a={a} b={b} findings={findings} />,
                    },
                  ]
                : []),
              {
                label: "Annotations",
                badge: annotationsChanged || undefined,
                content: <RowsTable rows={annotationRows} from={label(a)} to={label(b)} emptyText="Neither manifest carries annotations." />,
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

function label(side: CompareSide): string {
  return side.isTag ? side.ref : side.ref.slice(7, 19);
}

function Notice({ tone, children }: { tone?: "danger"; children: React.ReactNode }) {
  const cls = tone === "danger" ? "border-danger/30 bg-danger-soft text-danger" : "border-line bg-card text-ink-2";
  return <div className={`rounded-xl border px-4 py-4 text-sm ${cls}`}>{children}</div>;
}

function DeltaChip({ label, value, tone }: { label: string; value: string; tone: "neutral" | "ok" | "danger" | "info" }) {
  return (
    <Badge tone={tone} className="justify-center font-mono tabular-nums">
      <span className="text-ink-3">{label}</span> {value}
    </Badge>
  );
}

function SideSummary({ side, title, base }: { side: CompareSide; title: string; base: string }) {
  const items: [string, React.ReactNode][] = [
    ["Reference", <Link key="r" href={`${base}/tags/${encodeURIComponent(side.isTag ? side.ref : side.digest)}`} className="font-mono text-[13px] font-medium text-ink hover:underline">{label(side)}</Link>],
    ["Digest", <Digest key="d" digest={side.digest} length={16} />],
    ...(side.indexDigest ? ([["Index", <Digest key="i" digest={side.indexDigest} length={16} />]] as [string, React.ReactNode][]) : []),
    ["Platform", side.platform ?? "—"],
    ["Size", `${formatBytes(side.totalSize)} · ${side.layers.length} ${side.layers.length === 1 ? "layer" : "layers"}`],
    ["Pushed", `${formatDate(side.pushedAt)} (${relativeTime(side.pushedAt)})`],
    ["Created", side.created ? formatDate(side.created) : "—"],
  ];
  return (
    <div className="min-w-0 rounded-xl border border-line bg-card-2 p-3.5">
      <div className="eyebrow mb-2">{title}</div>
      <dl className="grid gap-x-3 gap-y-1.5 text-sm [grid-template-columns:auto_1fr]">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-xs text-ink-3">{k}</dt>
            <dd className="min-w-0 break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function LayerDiffTable({ diff }: { diff: ReturnType<typeof diffLayers> }) {
  if (diff.rows.length === 0) return <Notice>Neither image has layers.</Notice>;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1 text-ok"><Plus className="size-3" /> {diff.added} added ({formatBytes(diff.addedBytes)})</span>
        <span className="inline-flex items-center gap-1 text-danger"><Minus className="size-3" /> {diff.removed} removed ({formatBytes(diff.removedBytes)})</span>
        <span>{diff.unchanged} unchanged</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="w-8 px-3 py-2.5 text-xs font-medium text-ink-2" aria-label="Change" />
              <th className="hidden w-16 px-2 py-2.5 text-right text-xs font-medium text-ink-2 sm:table-cell" title="Position in from → to">#</th>
              <th className="w-full px-3 py-2.5 text-xs font-medium text-ink-2">Instruction</th>
              <th className="hidden px-3 py-2.5 text-xs font-medium text-ink-2 md:table-cell">Digest</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-2">Size</th>
            </tr>
          </thead>
          <tbody>
            {diff.rows.map((row, i) => {
              const cls = row.change === "added" ? "bg-ok-soft/60" : row.change === "removed" ? "bg-danger-soft/60" : "";
              return (
                <tr key={`${row.layer.digest}-${row.change}-${i}`} className={`border-b border-line last:border-0 ${cls}`}>
                  <td className="px-3 py-2.5 font-mono text-xs">
                    {row.change === "added" ? (
                      <span className="text-ok" title="Only in the new image">+</span>
                    ) : row.change === "removed" ? (
                      <span className="text-danger" title="Only in the old image">−</span>
                    ) : (
                      <span className="text-ink-3" title="In both images">=</span>
                    )}
                  </td>
                  <td className="hidden px-2 py-2.5 text-right font-mono text-xs text-ink-3 sm:table-cell">
                    {row.fromIndex ?? "·"}→{row.toIndex ?? "·"}
                  </td>
                  <td className="w-full max-w-0 px-3 py-2.5">
                    <code className={`block truncate font-mono text-xs ${row.change === "removed" ? "text-ink-3 line-through" : "text-ink-2"}`} title={row.layer.command ?? undefined}>
                      {row.layer.command ?? "—"}
                    </code>
                  </td>
                  <td className="hidden px-3 py-2.5 md:table-cell">
                    <Digest digest={row.layer.digest} />
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[13px] tabular-nums">{formatBytes(row.layer.size)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const SECTION_LABELS: Record<string, string> = {
  entrypoint: "Entrypoint",
  cmd: "Command",
  user: "User",
  workdir: "Working directory",
  ports: "Exposed ports",
  volumes: "Volumes",
  stopsignal: "Stop signal",
  platform: "Platform",
  env: "Environment",
  labels: "Labels",
  annotations: "Annotations",
};

function RowsTable({ rows, from, to, grouped = false, emptyText }: { rows: ConfigDiffRow[]; from: string; to: string; grouped?: boolean; emptyText: string }) {
  const present = rows.filter((r) => r.from !== null || r.to !== null);
  if (present.length === 0) return <Notice>{emptyText}</Notice>;
  const changed = present.filter((r) => r.changed).length;
  // Scalar sections first as single rows, then env and labels as groups.
  const scalars = present.filter((r) => !["env", "labels", "annotations"].includes(r.section));
  const groups = ["env", "labels", "annotations"].map((s) => ({ section: s, rows: present.filter((r) => r.section === s) })).filter((g) => g.rows.length > 0);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="border-b border-line px-4 py-2.5 text-xs text-ink-2">
        {changed === 0 ? "No differences." : `${changed} ${changed === 1 ? "difference" : "differences"} highlighted.`}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-ink-2">Key</th>
              <th className="w-[38%] px-3 py-2.5 text-xs font-medium text-ink-2">{from}</th>
              <th className="w-[38%] px-3 py-2.5 text-xs font-medium text-ink-2">{to}</th>
            </tr>
          </thead>
          <tbody>
            {grouped && scalars.map((r) => <RowLine key={`${r.section}-${r.key}`} row={r} />)}
            {!grouped && present.map((r) => <RowLine key={`${r.section}-${r.key}`} row={r} />)}
            {grouped &&
              groups.map((g) => (
                <GroupRows key={g.section} label={SECTION_LABELS[g.section] ?? g.section} rows={g.rows} />
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupRows({ label, rows }: { label: string; rows: ConfigDiffRow[] }) {
  return (
    <>
      <tr className="border-b border-line bg-card-2/60">
        <td colSpan={3} className="px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">
          {label} ({rows.filter((r) => r.changed).length} of {rows.length} changed)
        </td>
      </tr>
      {rows.map((r) => (
        <RowLine key={`${r.section}-${r.key}`} row={r} />
      ))}
    </>
  );
}

function RowLine({ row }: { row: ConfigDiffRow }) {
  const key = ["env", "labels", "annotations"].includes(row.section) ? row.key : (SECTION_LABELS[row.section] ?? row.key);
  return (
    <tr className={`border-b border-line last:border-0 ${row.changed ? "bg-accent-soft/50" : ""}`}>
      <td className="px-4 py-2 align-top font-mono text-xs text-ink-2 [overflow-wrap:anywhere]">{key}</td>
      <td className={`px-3 py-2 align-top font-mono text-xs [overflow-wrap:anywhere] ${row.changed ? (row.from === null ? "text-ink-3" : "text-danger") : "text-ink-2"}`}>
        {row.from === null ? <span className="italic">not set</span> : row.from || <span className="italic text-ink-3">empty</span>}
      </td>
      <td className={`px-3 py-2 align-top font-mono text-xs [overflow-wrap:anywhere] ${row.changed ? (row.to === null ? "text-ink-3" : "text-ok") : "text-ink-2"}`}>
        {row.to === null ? <span className="italic">not set</span> : row.to || <span className="italic text-ink-3">empty</span>}
      </td>
    </tr>
  );
}

function FindingsDiffPanel({ a, b, findings }: { a: CompareSide; b: CompareSide; findings: ReturnType<typeof diffFindings> | null }) {
  if (!findings) {
    const describe = (s: CompareSide) =>
      !s.scan ? "not scanned" : s.scan.status === "scanned" ? "scanned" : s.scan.status === "failed" ? "scan failed" : "scan in progress";
    return (
      <Notice>
        Both images need a finished scan: {label(a)} is {describe(a)}, {label(b)} is {describe(b)}.
      </Notice>
    );
  }
  const bySeverity = (counts: Record<string, number>) =>
    SEVERITIES.filter((s) => counts[s.key]).map((s) => `${counts[s.key]} ${s.key === "Unknown" ? "unrated" : s.key.toLowerCase()}`).join(", ");
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-card p-3.5">
          <div className="eyebrow mb-1">{label(a)}</div>
          <SeverityChips summary={a.scan!.summary} status="scanned" />
          <div className="mt-1 text-xs text-ink-3">{totalFindings(a.scan!.summary)} findings · scanned {relativeTime(a.scan!.updatedAt)}</div>
        </div>
        <div className="rounded-xl border border-line bg-card p-3.5">
          <div className="eyebrow mb-1">{label(b)}</div>
          <SeverityChips summary={b.scan!.summary} status="scanned" />
          <div className="mt-1 text-xs text-ink-3">{totalFindings(b.scan!.summary)} findings · scanned {relativeTime(b.scan!.updatedAt)}</div>
        </div>
      </div>
      <FindingsTable
        title={`New in ${label(b)}`}
        tone="danger"
        rows={findings.added}
        detail={findings.added.length ? bySeverity(findings.addedBySeverity) : "nothing new"}
      />
      <FindingsTable
        title={`Fixed since ${label(a)}`}
        tone="ok"
        rows={findings.fixed}
        detail={findings.fixed.length ? bySeverity(findings.fixedBySeverity) : "nothing fixed"}
      />
      <details className="rounded-xl border border-line bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          Unchanged <span className="ml-1 rounded-full bg-card-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{findings.unchanged.length}</span>
        </summary>
        <div className="border-t border-line">
          <FindingsRows rows={findings.unchanged} />
        </div>
      </details>
    </div>
  );
}

function FindingsTable({ title, tone, rows, detail }: { title: string; tone: "ok" | "danger"; rows: Finding[]; detail: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <span className={`text-sm font-medium ${tone === "danger" ? "text-danger" : "text-ok"}`}>
          {title} <span className="ml-1 rounded-full bg-card-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-2">{rows.length}</span>
        </span>
        <span className="text-xs text-ink-3">{detail}</span>
      </div>
      {rows.length > 0 ? <FindingsRows rows={rows} /> : <div className="px-4 py-3 text-sm text-ink-3">None.</div>}
    </div>
  );
}

const MAX_FINDING_ROWS = 300;

function FindingsRows({ rows }: { rows: Finding[] }) {
  if (rows.length === 0) return <div className="px-4 py-3 text-sm text-ink-3">None.</div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 sm:table-cell">Severity</th>
            <th className="px-4 py-2 text-xs font-medium text-ink-2 sm:px-3">Vulnerability</th>
            <th className="px-3 py-2 text-xs font-medium text-ink-2">Package</th>
            <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 md:table-cell">Fixed in</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, MAX_FINDING_ROWS).map((f) => {
            const sev = SEVERITIES.find((s) => s.key === f.severity) ?? SEVERITIES[5];
            return (
              <tr key={`${f.id}-${f.packageName}`} className="border-b border-line last:border-0">
                <td className="hidden px-4 py-2 sm:table-cell">
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                    <span aria-hidden className="size-2 rounded-full" style={{ background: `var(${sev.varName})` }} />
                    {f.severity === "Unknown" ? "unrated" : f.severity}
                  </span>
                </td>
                <td className="px-4 py-2 font-mono text-[13px] sm:px-3">
                  <span aria-hidden title={f.severity} className="mr-1.5 inline-block size-2 rounded-full align-middle sm:hidden" style={{ background: `var(${sev.varName})` }} />
                  {f.link ? (
                    <a href={f.link} target="_blank" rel="noreferrer noopener" className="text-ink hover:underline">
                      {f.name}
                    </a>
                  ) : (
                    f.name
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-[13px] text-ink-2">
                  {f.packageName}
                  {f.packageVersion && <span className="block text-ink-3 sm:inline"> {f.packageVersion}</span>}
                </td>
                <td className="hidden px-4 py-2 font-mono text-[13px] md:table-cell">
                  {f.fixedIn ? <span className="text-ok">{f.fixedIn}</span> : <span className="text-ink-3">no fix yet</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > MAX_FINDING_ROWS && (
        <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">Showing the {MAX_FINDING_ROWS} most severe of {rows.length}.</p>
      )}
    </div>
  );
}
