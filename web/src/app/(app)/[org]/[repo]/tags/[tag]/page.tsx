import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { ArrowLeft, GitCompareArrows, RotateCw } from "lucide-react";
import { db } from "@/db";
import { serviceAccounts, tags, user as userTable, vulnerabilityScans } from "@/db/schema";
import { getOrgContext, getSession } from "@/lib/session";
import { getManifestWithScan, getRepoByPath } from "@/lib/data";
import { env } from "@/lib/env";
import { fetchBlobJson } from "@/lib/registry-client";
import { formatBytes, formatDate, relativeTime } from "@/lib/format";
import { requestRescan } from "@/app/actions/repositories";
import { Card, CardBody } from "@/components/ui/card";
import { CommandLine, Digest } from "@/components/ui/copy";
import { Tabs } from "@/components/ui/tabs";
import { StrataBar } from "@/components/strata-bar";
import { SeverityChips, totalFindings, type SeveritySummary } from "@/components/severity";
import { Button, buttonClasses } from "@/components/ui/button";
import { VulnerabilityPanel } from "./vulnerability-panel";
import { imageReference } from "@/lib/library";
import { decodeRepoParam, repoHref } from "@/lib/proxy-shared";
import { loadExceptionRules, manifestBlockReason } from "@/lib/pull-policy";
import { getScanner } from "@/lib/scanners";
import { ensureFindings } from "@/lib/scan";
import { reportKind } from "@/lib/scanners/normalize";
import { manifestDeleteBlocker } from "@/lib/manifests";
import { effectiveTagRules, tagFlags } from "@/lib/tag-rules";
import { RuleBadges } from "@/components/tag-rules-manager";
import { DeleteManifestButton } from "../../tag-actions";
import { ShieldBan } from "lucide-react";
import { redirectMovedRepository } from "@/lib/redirects";
import { layersWithInstructions } from "@/lib/compare-shared";
import { memberOrgIds, sharedLayerRefs, type SharedLayerInfo } from "@/lib/shared-layers";
import { SharedLayerBadge } from "@/components/shared-layers";

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
  platform?: { os?: string; architecture?: string; variant?: string };
}

interface ImageConfig {
  architecture?: string;
  os?: string;
  created?: string;
  config?: { Entrypoint?: string[]; Cmd?: string[]; ExposedPorts?: Record<string, unknown> };
  history?: { created_by?: string; empty_layer?: boolean; created?: string }[];
}

async function resolveActor(pushedBy: string | null): Promise<string | null> {
  if (!pushedBy) return null;
  const [kind, id] = pushedBy.split(":");
  if (kind === "user" && id) {
    if (id === "system") return "system";
    const u = await db.query.user.findFirst({ where: eq(userTable.id, id) });
    return u?.name ?? null;
  }
  if (kind === "sa" && id) {
    const sa = await db.query.serviceAccounts.findFirst({ where: eq(serviceAccounts.id, id) });
    return sa ? `${sa.name} (service account)` : null;
  }
  if (kind === "proxy") return "the proxy cache";
  if (kind === "mirror") return "a mirror";
  return null;
}

export default async function TagDetailPage({
  params,
}: {
  params: Promise<{ org: string; repo: string; tag: string }>;
}) {
  const { org: orgSlug, repo: rawRepo, tag: rawTag } = await params;
  const repoName = decodeRepoParam(rawRepo);
  const reference = decodeURIComponent(rawTag);

  const found = await getRepoByPath(orgSlug, repoName);
  // Renamed / transferred repositories: 308 to the new address.
  if (!found) return redirectMovedRepository(orgSlug, repoName, `/tags/${rawTag}`);
  const ctx = await getOrgContext(orgSlug);
  const role = ctx?.role ?? null;
  if (found.repo.visibility === "private" && !role) notFound();

  // The reference may be a tag name or a raw digest (index children).
  const isDigestRef = reference.startsWith("sha256:");
  let digest = reference;
  if (!isDigestRef) {
    const tagRow = await db.query.tags.findFirst({
      where: and(eq(tags.repositoryId, found.repo.id), eq(tags.name, reference)),
    });
    if (!tagRow) notFound();
    digest = tagRow.manifestDigest;
  }

  const result = await getManifestWithScan(found.repo.id, digest);
  if (!result) notFound();
  const { manifest, scan } = result;

  let payload: {
    config?: Descriptor;
    layers?: Descriptor[];
    manifests?: Descriptor[];
    annotations?: Record<string, string>;
  };
  try {
    payload = JSON.parse(manifest.payload);
  } catch {
    payload = {};
  }
  const isIndex = Array.isArray(payload.manifests);
  const path = `${orgSlug}/${repoName}`;
  const base = repoHref(orgSlug, repoName);
  const pullRef = imageReference(env.registryHost, orgSlug, repoName, isDigestRef ? digest : reference);

  // Image config: prefer the cached copy, fall back to a live registry read.
  let config: ImageConfig | null = (manifest.config as ImageConfig) ?? null;
  if (!config && !isIndex && manifest.configDigest) {
    config = (await fetchBlobJson(path, manifest.configDigest)) as ImageConfig | null;
  }

  const layers = (payload.layers ?? []).map((l) => ({
    digest: l.digest ?? "",
    size: l.size ?? 0,
    mediaType: l.mediaType,
  }));
  // History entries without empty_layer align 1:1 with layers, in order
  // (lib/compare-shared.ts, shared with the compare page).
  const layersWithCommands = layersWithInstructions(layers, config);
  const totalSize = layers.reduce((sum, l) => sum + l.size, 0) + (payload.config?.size ?? 0);

  // Index children with their scan states.
  let children: (Descriptor & { scanStatus: string | null; scanSummary: SeveritySummary | null })[] = [];
  if (isIndex) {
    const digests = (payload.manifests ?? []).map((c) => c.digest!).filter(Boolean);
    const scans = digests.length
      ? await db.query.vulnerabilityScans.findMany({ where: inArray(vulnerabilityScans.digest, digests) })
      : [];
    const byDigest = new Map(scans.map((s) => [s.digest, s]));
    children = (payload.manifests ?? []).map((c) => ({
      ...c,
      scanStatus: byDigest.get(c.digest ?? "")?.status ?? null,
      scanSummary: (byDigest.get(c.digest ?? "")?.summary as SeveritySummary) ?? null,
    }));
  }

  const actor = await resolveActor(manifest.pushedBy);
  const blocked = await manifestBlockReason(found.repo.id, digest);
  const scanner = await getScanner();
  const scanning = !!scanner;
  const session = await getSession();
  const canRescan = session?.user.role === "admin" && !isIndex && scanning;
  // Which other images share each layer (one query), filtered to what the viewer may see.
  const shared: Record<string, SharedLayerInfo> = {};
  if (!isIndex && layers.length > 0) {
    const refs = await sharedLayerRefs(found.repo.id, digest, {
      isAdmin: session?.user.role === "admin",
      memberOrgIds: session ? await memberOrgIds(session.user.id) : [],
    });
    for (const [d, info] of refs) shared[d] = info;
  }
  // Tag rules: lock badges for a tag reference, and whether the image may be deleted by digest.
  const canManage = role === "owner" || role === "admin";
  const rules = await effectiveTagRules(found.repo.organizationId, found.repo.id);
  const flags = isDigestRef ? null : tagFlags(rules, reference);
  const deletion = canManage ? await manifestDeleteBlocker(found.repo, digest) : null;
  // Findings (legacy Clair rows are normalised on first read) and the exceptions that may accept them.
  const findings = scan?.status === "scanned" ? await ensureFindings(scan) : [];
  const exceptionRules = scanning
    ? (await loadExceptionRules(found.repo.organizationId, found.repo.id)).map((r) => ({
        ...r,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      }))
    : [];

  const metaItems: [string, React.ReactNode][] = [
    ["Digest", <Digest key="d" digest={digest} length={20} />],
    ["Media type", <span key="mt" className="break-all font-mono text-[13px]">{manifest.mediaType}</span>],
    ...(config?.os
      ? ([["Platform", `${config.os}/${config.architecture ?? "?"}`]] as [string, React.ReactNode][])
      : []),
    ...(isIndex ? ([["Variants", String(children.length)]] as [string, React.ReactNode][]) : []),
    ...(!isIndex
      ? ([["Total size", formatBytes(totalSize)]] as [string, React.ReactNode][])
      : []),
    ["Pushed", `${formatDate(manifest.createdAt)}${actor ? ` by ${actor}` : ""}`],
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={base}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft className="size-4" /> {path}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-all font-mono text-xl font-semibold tracking-tight">
              <span className="text-ink-2">{repoName}</span>
              <span className="text-ink-3">{isDigestRef ? "@" : ":"}</span>
              {isDigestRef ? digest.slice(7, 19) : reference}
            </h1>
            {flags && (flags.immutable || flags.protected) && (
              <span className="inline-flex gap-1">
                <RuleBadges
                  immutable={!!flags.immutable}
                  isProtected={!!flags.protected}
                  title={[
                    flags.immutable && `Immutable (rule "${flags.immutable.pattern}"): cannot be re-pointed at another image`,
                    flags.protected && `Protected (rule "${flags.protected.pattern}"): cannot be deleted`,
                  ]
                    .filter(Boolean)
                    .join("; ")}
                />
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`${base}/compare?from=${encodeURIComponent(isDigestRef ? digest : reference)}`}
              className={buttonClasses("secondary", "sm")}
              title="Compare this image with another tag"
            >
              <GitCompareArrows className="size-3.5" /> Compare
            </Link>
            {canRescan && (
              <form action={requestRescan}>
                <input type="hidden" name="repositoryId" value={found.repo.id} />
                <input type="hidden" name="digest" value={digest} />
                <Button type="submit" variant="secondary" size="sm">
                  <RotateCw className="size-3.5" /> Re-scan
                </Button>
              </form>
            )}
            {deletion && (
              <DeleteManifestButton
                repositoryId={found.repo.id}
                digest={digest}
                tags={deletion.tags}
                blocked={deletion.reason}
                variant="button"
                afterDelete={`/${path}`}
              />
            )}
          </div>
        </div>
      </div>

      {blocked && (
        <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          <ShieldBan className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-medium">Pulls of this image are blocked by the vulnerability policy.</div>
            <div className="mt-0.5 text-[13px] opacity-90">{blocked}</div>
          </div>
        </div>
      )}

      <CommandLine command={`docker pull ${pullRef}`} />

      <Card>
        <CardBody>
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {metaItems.map(([label, value]) => (
              <div key={label}>
                <dt className="eyebrow mb-0.5">{label}</dt>
                <dd className="text-sm">{value}</dd>
              </div>
            ))}
          </dl>
          {!isIndex && layersWithCommands.length > 0 && (
            <div className="mt-5 border-t border-line pt-4">
              <div className="eyebrow mb-2">Cargo plan</div>
              <StrataBar layers={layersWithCommands} />
            </div>
          )}
        </CardBody>
      </Card>

      {isIndex ? (
        <Card>
          <CardBody>
            <div className="eyebrow mb-3">Platform variants</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="py-2 pr-4 text-xs font-medium text-ink-2">Platform</th>
                    <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 sm:table-cell">Digest</th>
                    <th className="hidden px-4 py-2 text-right text-xs font-medium text-ink-2 md:table-cell">Manifest size</th>
                    {scanning && <th className="px-4 py-2 text-xs font-medium text-ink-2">Vulnerabilities</th>}
                  </tr>
                </thead>
                <tbody>
                  {children.map((child) => (
                    <tr key={child.digest} className="border-b border-line last:border-0">
                      <td className="py-2.5 pr-4 font-mono text-[13px]">
                        <Link
                          href={`${base}/tags/${encodeURIComponent(child.digest ?? "")}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {child.platform ? `${child.platform.os}/${child.platform.architecture}${child.platform.variant ? `/${child.platform.variant}` : ""}` : "unknown"}
                        </Link>
                      </td>
                      <td className="hidden px-4 py-2.5 sm:table-cell">
                        <Digest digest={child.digest ?? ""} />
                      </td>
                      <td className="hidden px-4 py-2.5 text-right font-mono text-[13px] text-ink-2 md:table-cell">
                        {formatBytes(child.size ?? 0)}
                      </td>
                      {scanning && (
                        <td className="px-4 py-2.5">
                          <SeverityChips summary={child.scanSummary} status={child.scanStatus} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Tabs
          tabs={[
            {
              label: "Layers",
              badge: layersWithCommands.length,
              content: <LayerTable layers={layersWithCommands} shared={shared} />,
            },
            ...(scanning
              ? [
                  {
                    label: "Vulnerabilities",
                    badge: scan?.status === "scanned" ? totalFindings(scan.summary as SeveritySummary) : undefined,
                    content: (
                      <VulnerabilityPanel
                        scan={
                          scan
                            ? {
                                status: scan.status,
                                summary: (scan.summary as SeveritySummary) ?? null,
                                error: scan.error,
                                updatedAt: scan.updatedAt.toISOString(),
                                // Legacy rows get their label from the report shape until the write-back lands.
                                scanner: scan.scanner ?? reportKind(scan.report),
                                scannerVersion: scan.scannerVersion,
                              }
                            : null
                        }
                        findings={findings}
                        rules={exceptionRules}
                        scannerLabel={scanner?.label ?? null}
                        canManage={canManage}
                        organizationId={found.repo.organizationId}
                        repositoryId={found.repo.id}
                      />
                    ),
                  },
                ]
              : []),
            {
              label: "Manifest",
              content: (
                <pre className="overflow-x-auto rounded-xl border border-line bg-card p-3 font-mono text-xs leading-relaxed text-ink-2 sm:p-4">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}

function LayerTable({
  layers,
  shared,
}: {
  layers: { digest: string; size: number; mediaType?: string; command: string | null }[];
  /** Other images referencing each layer, by digest. */
  shared: Record<string, SharedLayerInfo>;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="w-10 px-4 py-2.5 text-right text-xs font-medium text-ink-2">#</th>
            <th className="w-full px-3 py-2.5 text-xs font-medium text-ink-2">Instruction</th>
            <th className="hidden px-3 py-2.5 text-xs font-medium text-ink-2 sm:table-cell">Digest</th>
            <th className="px-3 py-2.5 text-right text-xs font-medium text-ink-2" title="Other images that use this layer">Shared</th>
            <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-2">Size</th>
          </tr>
        </thead>
        <tbody>
          {layers.map((layer, i) => (
            <tr key={`${layer.digest}-${i}`} className="border-b border-line last:border-0 hover:bg-card-2">
              <td className="px-4 py-2.5 text-right font-mono text-xs text-ink-3">{i + 1}</td>
              <td className="w-full max-w-0 px-3 py-2.5">
                <code
                  className="block truncate font-mono text-xs text-ink-2"
                  title={layer.command ?? undefined}
                >
                  {layer.command ?? "—"}
                </code>
              </td>
              <td className="hidden px-3 py-2.5 sm:table-cell">
                <Digest digest={layer.digest} />
              </td>
              <td className="px-3 py-2.5 text-right">
                <SharedLayerBadge info={shared[layer.digest]} />
              </td>
              <td className="px-4 py-2.5 text-right font-mono text-[13px] tabular-nums">
                {formatBytes(layer.size)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
