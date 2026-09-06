// Database rows → the documents the REST API returns. Field names here are
// part of the API contract (lib/api/catalog.ts shows them as examples):
// rename with a changelog entry, never silently.
import { env } from "@/lib/env";
import { imagePath, imageReference } from "@/lib/library";
import { repoHref } from "@/lib/proxy-shared";
import type { RepoListItem, TagListItem } from "@/lib/data";
import type { UntaggedManifest } from "@/lib/manifests";
import type { AuditRow } from "@/lib/audit-shared";
import type { SeveritySummary } from "@/components/severity";
import { iso } from "./respond";
import { helmReference } from "@/lib/helm-shared";

/** Absolute URL into the web app. */
export function absolute(path: string): string {
  return env.appUrl.replace(/\/$/, "") + path;
}

export function repoJson(r: RepoListItem, orgSlug: string = r.orgSlug ?? "") {
  return {
    id: r.id,
    organization: orgSlug,
    name: r.name,
    path: imagePath(orgSlug, r.name),
    reference: imageReference(env.registryHost, orgSlug, r.name),
    description: r.description,
    visibility: r.visibility,
    pullCount: r.pullCount,
    starCount: r.starCount,
    tagCount: r.tagCount,
    sizeBytes: r.sizeBytes,
    lastPushedAt: iso(r.lastPushedAt),
    updatedAt: iso(r.updatedAt),
    proxy: r.proxy,
    lastCheckedAt: iso(r.lastCheckedAt),
    kind: r.kind,
    helmReference: r.kind === "chart" ? helmReference(env.registryHost, imagePath(orgSlug, r.name)) : null,
    url: absolute(repoHref(orgSlug, r.name)),
  };
}
export type RepoJson = ReturnType<typeof repoJson>;

export function tagJson(t: TagListItem, orgSlug: string, repoName: string) {
  return {
    name: t.name,
    digest: t.manifestDigest,
    mediaType: t.mediaType,
    isIndex: t.isIndex,
    sizeBytes: t.sizeBytes,
    layerCount: t.isIndex ? null : t.layerCount,
    pushedAt: iso(t.updatedAt),
    signed: t.signed,
    blocked: t.blocked,
    scan: t.scanStatus ? { status: t.scanStatus, summary: compactSummary(t.scanSummary) } : null,
    proxyCheckedAt: iso(t.proxyCheckedAt),
    chart: t.chart,
    helmReference: t.chart ? helmReference(env.registryHost, imagePath(orgSlug, repoName)) : null,
    reference: imageReference(env.registryHost, orgSlug, repoName, t.name),
    url: absolute(`${repoHref(orgSlug, repoName)}/tags/${encodeURIComponent(t.name)}`),
  };
}

/** Severity counts without the zero entries. */
export function compactSummary(s: SeveritySummary | Record<string, number> | null | undefined): Record<string, number> | null {
  if (!s) return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(s)) if (Number(v) > 0) out[k] = Number(v);
  return out;
}

export function untaggedJson(m: UntaggedManifest) {
  return {
    digest: m.digest,
    mediaType: m.mediaType,
    artifactType: m.artifactType,
    isIndex: m.isIndex,
    sizeBytes: m.size,
    contentBytes: m.contentBytes,
    platform: m.platform,
    pushedAt: iso(m.pushedAt),
    pushedBy: m.pushedBy,
    indexMember: m.isChild,
    parentTags: m.parentTags,
    attestation: m.isAttestation,
    referrer: m.isReferrer,
    subjectDigest: m.subjectDigest,
    referrerCount: m.referrerCount,
  };
}

export function auditJson(a: AuditRow) {
  return {
    id: a.id,
    createdAt: iso(a.createdAt),
    actor: { type: a.actorType, id: a.actorId, label: a.actorLabel, impersonatorId: a.impersonatorId },
    action: a.action,
    organization: a.organizationSlug,
    target: { type: a.targetType, id: a.targetId, label: a.targetLabel },
    details: a.details,
    ip: a.ip,
    userAgent: a.userAgent,
  };
}

export interface ScanLike {
  status: string;
  scanner: string | null;
  scannerVersion: string | null;
  updatedAt: Date;
  summary: unknown;
  error: string | null;
}

export function scanJson(scan: ScanLike, effectiveSummary: SeveritySummary | Record<string, number> | null) {
  return {
    status: scan.status,
    scanner: scan.scanner,
    scannerVersion: scan.scannerVersion,
    updatedAt: iso(scan.updatedAt),
    summary: compactSummary(scan.summary as SeveritySummary | null),
    effectiveSummary: compactSummary(effectiveSummary),
    error: scan.error,
  };
}
