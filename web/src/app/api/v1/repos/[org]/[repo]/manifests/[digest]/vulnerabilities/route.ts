// GET /api/v1/repos/{org}/{repo}/manifests/{digest}/vulnerabilities — the
// normalised findings of the last scan, with the accepted risks applied.
import { loadRepo } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { badRequest, boolParam, iso, json, notFound, paged, pageParams, requireDigest } from "@/lib/api/respond";
import { scanJson } from "@/lib/api/serialize";
import { toCycloneDxVex, toSarif, type ExportSubject } from "@/lib/api/exports";
import { tagsForDigest } from "@/lib/manifests";
import { env } from "@/lib/env";
import { imageReference } from "@/lib/library";
import { getManifestWithScan } from "@/lib/data";
import { pageSlice, paginate } from "@/lib/paginate-shared";
import { decodeRepoParam } from "@/lib/proxy-shared";
import { loadExceptionRules } from "@/lib/pull-policy";
import { ensureFindings } from "@/lib/scan";
import { applyExceptions, effectiveSummary, filterFindings, SEVERITY_ORDER, sortFindings, type Severity } from "@/lib/scanner-shared";

export const dynamic = "force-dynamic";

export const GET = route<{ org: string; repo: string; digest: string }>(async (_req, { caller, params, url }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const digest = requireDigest(params.digest);
  const { page, pageSize } = pageParams(url);
  const result = await getManifestWithScan(a.repo.id, digest);
  if (!result) throw notFound("No such image in this repository.");
  const { manifest, scan } = result;

  const empty = (note: string | null) => json({ digest, scan: null, note, ...paged([], paginate(0, 1, pageSize)) });
  if (/index|list/.test(manifest.mediaType)) return empty("Indexes are not scanned; query one of the platform variants.");
  if (!scan) return empty("This image has not been scanned.");

  const severities: Severity[] = [];
  for (const raw of (url.searchParams.get("severity") ?? "").split(",")) {
    const s = raw.trim();
    if (!s) continue;
    const match = SEVERITY_ORDER.find((k) => k.toLowerCase() === s.toLowerCase());
    if (!match) throw badRequest(`Unknown severity "${s}"; use ${SEVERITY_ORDER.join(", ")}.`);
    severities.push(match);
  }

  const [findings, rules] = await Promise.all([ensureFindings(scan), loadExceptionRules(a.org.id, a.repo.id)]);
  const assessed = applyExceptions(findings, rules, a.repo.id);

  // Whole-image exports for other tools (no paging, no filters).
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  if (format === "sarif" || format === "vex" || format === "cyclonedx-vex") {
    const subject: ExportSubject = {
      reference: imageReference(env.registryHost, a.org.slug, a.repo.name),
      organization: a.org.slug,
      repository: a.repo.name,
      digest,
      tags: await tagsForDigest(a.repo.id, digest),
      scanner: scan.scanner,
      scannerVersion: scan.scannerVersion,
      scannedAt: iso(scan.updatedAt),
    };
    const doc = format === "sarif" ? toSarif(subject, assessed) : toCycloneDxVex(subject, assessed);
    const type = format === "sarif" ? "application/sarif+json" : "application/vnd.cyclonedx+json";
    return json(doc, { headers: { "Content-Type": type, "Content-Disposition": `inline; filename="${a.repo.name}-${digest.slice(7, 19)}.${format === "sarif" ? "sarif" : "vex.json"}"` } });
  }
  if (format !== "json") throw badRequest('"format" must be json, sarif or vex.');
  const filtered = filterFindings(assessed, {
    severities,
    fixedOnly: boolParam(url, "fixed", false),
    query: (url.searchParams.get("q") ?? "").slice(0, 120),
    hideAccepted: !boolParam(url, "include_accepted", true),
  });
  const items = sortFindings(
    filtered.map(({ finding, exception }) => ({
      ...finding,
      accepted: exception
        ? {
            id: exception.id,
            justification: exception.justification,
            package: exception.package,
            scope: exception.repositoryId ? "repository" : "organization",
            expiresAt: iso(exception.expiresAt),
          }
        : null,
    })),
  );
  const { rows, state } = pageSlice(items, page, pageSize);
  return json({ digest, scan: scanJson(scan, effectiveSummary(findings, rules, a.repo.id)), note: null, ...paged(rows, state) });
});
