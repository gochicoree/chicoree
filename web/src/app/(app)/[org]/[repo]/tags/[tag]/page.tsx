import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { ArrowLeft, GitCompareArrows, Layers } from "lucide-react";
import { db } from "@/db";
import { ciIdentitiesTrusted, organizationProxies, serviceAccounts, tags, user as userTable, vulnerabilityScans } from "@/db/schema";
import { getOrgContext, getSession } from "@/lib/session";
import { getManifestWithScan, getRepoByPath, listUserOrgs } from "@/lib/data";
import { env } from "@/lib/env";
import { fetchBlobJson } from "@/lib/registry-client";
import { formatBytes, formatDate, relativeTime } from "@/lib/format";
import { EntityLogo } from "@/components/entity-logo";
import { logoVersionOf, userLogoVersion } from "@/lib/logo";
import { logoRef, type LogoRef } from "@/lib/logo-shared";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
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
import { attestationContents, buildkitAttestationsFor, indexMemberships, manifestDeleteBlocker } from "@/lib/manifests";
import { looksLikeArtifact } from "@/lib/signatures-shared";
import { RescanButton } from "./rescan-button";
import { effectiveTagRules, tagFlags } from "@/lib/tag-rules";
import { RuleBadges } from "@/components/tag-rules-manager";
import { DeleteManifestButton } from "../../tag-actions";
import { MoveImageButton, type MoveDestinationOrg } from "./move-image";
import { redirectMovedRepository } from "@/lib/redirects";
import { layersWithInstructions } from "@/lib/compare-shared";
import { memberOrgIds, sharedLayerRefs, type SharedLayerInfo } from "@/lib/shared-layers";
import { SharedLayerBadge } from "@/components/shared-layers";
import { ShieldBan, ShieldCheck } from "lucide-react";
import { organizationSettings } from "@/db/schema";
import { effectiveSignaturePolicy } from "@/lib/pull-policy-shared";
import { getAttestationView, isSignatureBlockReason } from "@/lib/signatures";
import { AttestationsPanel } from "@/components/attestations-panel";
import { Badge } from "@/components/ui/badge";
import { WRITER_ROLES } from "@/lib/org-roles";
import { scanInProgress } from "@/lib/scanner-shared";
import { getInstanceSettings } from "@/lib/instance-settings";
import { showArtifactsFor } from "@/lib/artifact-visibility";
import { imagePath } from "@/lib/library-shared";

interface Descriptor {
  mediaType?: string;
  digest?: string;
  size?: number;
  platform?: { os?: string; architecture?: string; variant?: string };
  annotations?: Record<string, string>;
}

interface ImageConfig {
  architecture?: string;
  os?: string;
  created?: string;
  config?: { Entrypoint?: string[]; Cmd?: string[]; ExposedPorts?: Record<string, unknown> };
  history?: { created_by?: string; empty_layer?: boolean; created?: string }[];
}

interface PushActor {
  label: string;
  /** The pusher's avatar, when a real user pushed and has one. */
  logo: LogoRef | null;
  /** True for a signed-in user (not "system", a service account or a cache). */
  isUser: boolean;
}

async function resolveActor(pushedBy: string | null): Promise<PushActor | null> {
  if (!pushedBy) return null;
  const [kind, id] = pushedBy.split(":");
  if (kind === "user" && id) {
    if (id === "system") return { label: "system", logo: null, isUser: false };
    const u = await db.query.user.findFirst({ where: eq(userTable.id, id) });
    const gravatar = (await getInstanceSettings()).branding.gravatar;
    return u ? { label: u.name, logo: logoRef("user", u.id, userLogoVersion(u, gravatar)), isUser: true } : null;
  }
  if (kind === "sa" && id === "ci") {
    // "sa:ci:<identity id>": a workflow that authenticated with its OIDC token.
    const identityId = pushedBy.slice("sa:ci:".length);
    const identity = await db.query.ciIdentitiesTrusted.findFirst({ where: eq(ciIdentitiesTrusted.id, identityId), columns: { name: true } });
    return { label: identity ? `${identity.name} (CI)` : "a CI workflow", logo: null, isUser: false };
  }
  if (kind === "sa" && id) {
    const sa = await db.query.serviceAccounts.findFirst({ where: eq(serviceAccounts.id, id) });
    return sa ? { label: `${sa.name} (service account)`, logo: null, isUser: false } : null;
  }
  if (kind === "proxy") return { label: "the proxy cache", logo: null, isUser: false };
  if (kind === "mirror") return { label: "a mirror", logo: null, isUser: false };
  return null;
}

/**
 * Organizations the caller may push an image into: the ones they can write
 * to (every organization for instance admins), never a proxy cache.
 */
async function moveDestinations(userId: string, isAdmin: boolean): Promise<MoveDestinationOrg[]> {
  const proxies = new Set(
    (await db.query.organizationProxies.findMany({ columns: { organizationId: true } })).map((p) => p.organizationId),
  );
  if (isAdmin) {
    const all = await db.query.organization.findMany({
      columns: { id: true, name: true, slug: true },
      orderBy: (o, { asc }) => [asc(o.name)],
    });
    return all.filter((o) => !proxies.has(o.id));
  }
  const mine = await listUserOrgs(userId);
  return mine
    .filter((o) => !proxies.has(o.id) && (WRITER_ROLES as string[]).includes(o.role))
    .map((o) => ({ id: o.id, name: o.name, slug: o.slug }));
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
    subject?: Descriptor;
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
  // A scan already running: the button waits rather than queueing a second one.
  const rescanRunning = scanInProgress(scan);
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
  // Index children get an explanation of what they are and who holds them
  // (the delete button alone only says "no").
  const memberships = isIndex ? [] : await indexMemberships(found.repo.id, digest);
  const membership = memberships[0] ?? null;
  const isAttestation = !!membership?.attestation;
  // Signatures, SBOMs, attestations: no filesystem, so no scan — the button says so instead of doing nothing.
  const isArtifact =
    !isIndex &&
    looksLikeArtifact({
      hasSubject: !!payload.subject,
      tags: isDigestRef ? [] : [reference],
      layerMediaTypes: layers.map((l) => l.mediaType ?? ""),
      configMediaType: payload.config?.mediaType ?? null,
    });
  const attestationItems = isAttestation ? attestationContents(payload) : [];
  // Attestation entries stay out of the variants table unless the viewer (Settings → Display) or the instance wants them.
  const showArtifacts = await showArtifactsFor(session?.user.id ?? null);
  const isAttestationChild = (c: Descriptor) => c.annotations?.["vnd.docker.reference.type"] === "attestation-manifest";
  const hiddenVariants = showArtifacts ? 0 : children.filter(isAttestationChild).length;
  const visibleChildren = showArtifacts ? children : children.filter((c) => !isAttestationChild(c));
  // Provenance / SBOM BuildKit stored next to this image inside the index.
  const buildkit = !isIndex && !isArtifact ? await buildkitAttestationsFor(found.repo.id, digest) : [];
  // Findings (legacy Clair rows are normalised on first read) and the exceptions that may accept them.
  const findings = scan?.status === "scanned" ? await ensureFindings(scan) : [];
  const exceptionRules = scanning
    ? (await loadExceptionRules(found.repo.organizationId, found.repo.id)).map((r) => ({
        ...r,
        expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      }))
    : [];
  // Signatures, SBOMs and provenance attached to the image (and to the variants of an index).
  const attestations = await getAttestationView(found.repo, orgSlug, digest, payload);
  const orgSettingsRow = await db.query.organizationSettings.findFirst({
    where: eq(organizationSettings.organizationId, found.repo.organizationId),
  });
  const signaturesRequired = effectiveSignaturePolicy(orgSettingsRow, found.repo);
  const signedByTrustedKey = attestations.signatures.some((s) => s.sig?.status === "verified");
  const canReverify = !!role && WRITER_ROLES.includes(role);
  // "Move or copy": writers only, and never out of a proxy cache (its images belong to the upstream).
  const sourceIsProxy = !!(await db.query.organizationProxies.findFirst({
    where: eq(organizationProxies.organizationId, found.repo.organizationId),
    columns: { organizationId: true },
  }));
  const moveTargets =
    canReverify && !sourceIsProxy && session ? await moveDestinations(session.user.id, session.user.role === "admin") : [];
  const digestReference = imageReference(env.registryHost, orgSlug, repoName, digest);
  const attestationsPanel = (
    <AttestationsPanel
      view={attestations}
      repositoryId={found.repo.id}
      digest={digest}
      digestReference={digestReference}
      policyHref={`${base}/settings/policy`}
      canReverify={canReverify}
      canPush={canReverify && !sourceIsProxy}
      signaturesRequired={signaturesRequired}
    />
  );
  const blockedBySignature = isSignatureBlockReason(blocked);
  const blockedByScan = !!blocked && /finding/.test(blocked);

  const metaItems: [string, React.ReactNode][] = [
    ["Digest", <Digest key="d" digest={digest} length={20} />],
    ["Media type", <span key="mt" className="break-all font-mono text-[13px]">{manifest.mediaType}</span>],
    ...(isAttestation
      ? ([["Platform", "none — attestation entry (unknown/unknown)"]] as [string, React.ReactNode][])
      : config?.os
        ? ([["Platform", `${config.os}/${config.architecture ?? "?"}`]] as [string, React.ReactNode][])
        : []),
    ...(isIndex ? ([["Variants", String(children.length)]] as [string, React.ReactNode][]) : []),
    ...(buildkit.length > 0
      ? ([
          [
            "Build attestations",
            <span key="bk" className="inline-flex flex-wrap items-center gap-1.5">
              {buildkit.flatMap((b) =>
                (b.contents.length > 0 ? b.contents : [{ digest: "", size: 0, predicateType: null, subkind: null, label: "attestation" }]).map((c, i) => (
                  <Link
                    key={`${b.digest}-${i}`}
                    href={`${base}/tags/${encodeURIComponent(b.digest)}`}
                    className="underline hover:text-ink"
                    title={`Stored by docker buildx in the index entry ${b.digest.slice(7, 19)}`}
                  >
                    {c.label}
                  </Link>
                )),
              )}
            </span>,
          ],
        ] as [string, React.ReactNode][])
      : []),
    ...(!isIndex
      ? ([["Total size", formatBytes(totalSize)]] as [string, React.ReactNode][])
      : []),
    [
      "Pushed",
      <span key="pushed" className="inline-flex flex-wrap items-center gap-1.5">
        {formatDate(manifest.createdAt)}
        {actor && (
          <>
            <span className="text-ink-2">by</span>
            {actor.isUser && <EntityLogo kind="user" name={actor.label} logo={actor.logo} size={18} />}
            {actor.label}
          </>
        )}
      </span>,
    ],
  ];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={base}
          className="mb-3 inline-flex items-center gap-1.5 text-sm text-ink-2 hover:text-ink"
        >
          <ArrowLeft className="size-4" /> {imagePath(orgSlug, repoName)}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-all font-mono text-xl font-semibold tracking-tight">
              <span className="text-ink-2">{repoName}</span>
              <span className="text-ink-3">{isDigestRef ? "@" : ":"}</span>
              {isDigestRef ? digest.slice(7, 19) : reference}
            </h1>
            {signedByTrustedKey && (
              <Badge tone="ok" title="A cosign signature from a trusted key verifies this image">
                <ShieldCheck className="size-3" /> signed
              </Badge>
            )}
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
              <RescanButton
                repositoryId={found.repo.id}
                digest={digest}
                running={rescanRunning}
                disabledReason={
                  isArtifact
                    ? isAttestation
                      ? "Not scanned: an attestation entry carries no software, only provenance / SBOM documents."
                      : "Not scanned: this manifest carries no filesystem (a signature, SBOM or attestation)."
                    : null
                }
              />
            )}
            {moveTargets.length > 0 && (
              <MoveImageButton
                sourceRepositoryId={found.repo.id}
                sourceOrgId={found.repo.organizationId}
                sourceOrgSlug={orgSlug}
                sourceRepoName={repoName}
                reference={isDigestRef ? digest : reference}
                isDigestRef={isDigestRef}
                registryHost={env.registryHost}
                organizations={moveTargets}
                artifactCount={attestations.total}
              />
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

      {membership && (
        <div className="flex items-start gap-3 rounded-xl border border-line bg-card-2 px-4 py-3 text-sm text-ink-2">
          <Layers className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <div className="min-w-0 space-y-1.5">
            <div className="font-medium text-ink">
              {isAttestation
                ? "This is not an image: it is a BuildKit attestation entry of a multi-arch index."
                : `This is the ${membership.platform ?? "platform"} variant of a multi-arch index.`}
            </div>
            <p>
              {isAttestation ? (
                <>
                  <code className="font-mono">docker buildx</code> stores the attestations it generates as an extra entry of the index, with the
                  placeholder platform <span className="font-mono">unknown/unknown</span>
                  {membership.attestation?.referenceDigest && (
                    <>
                      , describing the variant{" "}
                      <Link href={`${base}/tags/${encodeURIComponent(membership.attestation.referenceDigest)}`} className="font-mono underline hover:text-ink">
                        {membership.attestation.referenceDigest.slice(7, 19)}
                      </Link>
                    </>
                  )}
                  . It appears whenever a build records provenance — on by default since Docker 24 / buildx 0.11 — or an SBOM (
                  <code className="font-mono">--sbom=true</code>); images built with plain <code className="font-mono">docker build</code> or with{" "}
                  <code className="font-mono">--provenance=false</code> have no such entry. <code className="font-mono">docker pull</code> never fetches
                  it by itself; <code className="font-mono">docker buildx imagetools inspect</code> and <code className="font-mono">docker sbom</code>{" "}
                  read it.
                </>
              ) : (
                <>
                  Pulling the index on a {membership.platform ?? "matching"} machine fetches exactly this image.
                </>
              )}
            </p>
            {isAttestation && (
              <p>
                <span className="font-medium text-ink">This entry contains:</span>{" "}
                {attestationItems.length === 0
                  ? "nothing readable (no in-toto statements)."
                  : attestationItems.map((c, i) => (
                      <span key={c.digest}>
                        {i > 0 && ", "}
                        <a
                          href={`/api/artifacts/${found.repo.id}/${encodeURIComponent(digest)}?blob=${encodeURIComponent(c.digest)}`}
                          className="underline hover:text-ink"
                          title={c.predicateType ?? undefined}
                        >
                          {c.label}
                        </a>{" "}
                        <span className="text-ink-3">({formatBytes(c.size)})</span>
                      </span>
                    ))}
                {attestationItems.length > 0 && !attestationItems.some((c) => c.subkind === "spdx" || c.subkind === "cyclonedx") && (
                  <span className="text-ink-3">
                    {" "}
                    — no SBOM: the build did not pass <code className="font-mono">--sbom=true</code>.
                  </span>
                )}
              </p>
            )}
            <p>
              It belongs to{" "}
              {memberships.map((m, i) => (
                <span key={m.parentDigest}>
                  {i > 0 && ", "}
                  {m.parentTags.length > 0 ? (
                    m.parentTags.map((t, j) => (
                      <span key={t}>
                        {j > 0 && ", "}
                        <Link href={`${base}/tags/${encodeURIComponent(t)}`} className="font-mono underline hover:text-ink">
                          {repoName}:{t}
                        </Link>
                      </span>
                    ))
                  ) : (
                    <Link href={`${base}/tags/${encodeURIComponent(m.parentDigest)}`} className="font-mono underline hover:text-ink">
                      {repoName}@{m.parentDigest.slice(7, 19)}
                    </Link>
                  )}
                </span>
              ))}
              {memberships.length === 1 && memberships[0].parentTags.length === 0 && " (an untagged index)"}, so it cannot be deleted on its own:
              removing it would break that index. Delete the {memberships.some((m) => m.parentTags.length > 0) ? "tag or the index" : "index"} and the
              next <em>prune untagged</em> run (or a retention policy) removes this entry; garbage collection reclaims its bytes.
            </p>
            {isAttestation && (
              <p className="text-ink-3">
                To build without attestation entries: <code className="font-mono">docker buildx build --provenance=false --sbom=false …</code>
              </p>
            )}
          </div>
        </div>
      )}

      {blocked && (
        <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
          <ShieldBan className="mt-0.5 size-4 shrink-0" />
          <div>
            <div className="font-medium">
              {`Pulls of this image are blocked by the ${
                blockedBySignature && blockedByScan
                  ? "vulnerability and signature policies"
                  : blockedBySignature
                    ? "signature policy"
                    : "vulnerability policy"
              }.`}
            </div>
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
                  {visibleChildren.map((child) => (
                    <tr key={child.digest} className="border-b border-line last:border-0">
                      <td className="py-2.5 pr-4 font-mono text-[13px]">
                        <Link
                          href={`${base}/tags/${encodeURIComponent(child.digest ?? "")}`}
                          className="font-medium text-ink hover:underline"
                        >
                          {child.annotations?.["vnd.docker.reference.type"] === "attestation-manifest"
                            ? `attestations for ${child.annotations["vnd.docker.reference.digest"]?.slice(7, 19) ?? "a variant"}`
                            : child.platform
                              ? `${child.platform.os}/${child.platform.architecture}${child.platform.variant ? `/${child.platform.variant}` : ""}`
                              : "unknown"}
                        </Link>
                        {child.annotations?.["vnd.docker.reference.type"] === "attestation-manifest" && (
                          <span className="ml-2 font-sans text-xs text-ink-3" title="A BuildKit attestation entry (provenance / SBOM), not an image">
                            not an image
                          </span>
                        )}
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
            {hiddenVariants > 0 && (
              <p className="pt-2 text-xs text-ink-3">
                {hiddenVariants} attestation {hiddenVariants === 1 ? "entry" : "entries"} (provenance / SBOM, not images) hidden — see the
                Attestations tab, or{" "}
                {session ? (
                  <Link href="/settings#display" className="underline hover:text-ink">
                    show them
                  </Link>
                ) : (
                  "sign in to show them"
                )}
                .
              </p>
            )}
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
              label: "Attestations",
              badge: attestations.total || undefined,
              content: attestationsPanel,
            },
            {
              label: "Manifest",
              content: (
                <pre className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded-xl border border-line bg-card p-3 font-mono text-xs leading-relaxed text-ink-2 sm:p-4">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              ),
            },
          ]}
        />
      )}

      {isIndex && (
        <Card>
          <CardHeader
            eyebrow="Attestations"
            title="Signatures & SBOMs"
            description="Attached to the image and to each platform variant."
          />
          <CardBody>{attestationsPanel}</CardBody>
        </Card>
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
    <div className="overflow-x-auto rounded-xl border border-line bg-card">
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
