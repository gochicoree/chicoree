import Link from "next/link";
import { Download, FileBox, GitCommitHorizontal, KeyRound, Link2, ShieldAlert, ShieldCheck, ShieldQuestion, Tag as TagIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SbomPackages } from "@/components/sbom-packages";
import { buttonClasses } from "@/components/ui/button";
import { CommandLine, Digest } from "@/components/ui/copy";
import { ReverifyButton } from "@/components/reverify-button";
import { formatBytes, formatDate, relativeTime } from "@/lib/format";
import { predicateLabel, signatureFormatLabel, type SignatureStatus } from "@/lib/signatures-shared";
import type { AttestationView, SignatureStatusView } from "@/lib/signatures";

const STATUS: Record<SignatureStatus, { tone: "ok" | "neutral" | "danger" | "info"; Icon: typeof ShieldCheck; label: string }> = {
  verified: { tone: "ok", Icon: ShieldCheck, label: "verified" },
  untrusted: { tone: "neutral", Icon: ShieldQuestion, label: "unverified" },
  invalid: { tone: "danger", Icon: ShieldAlert, label: "invalid" },
  keyless: { tone: "info", Icon: KeyRound, label: "keyless" },
};

export function SignatureStatusBadge({ sig }: { sig: SignatureStatusView | null }) {
  if (!sig) {
    return (
      <Badge tone="neutral" title="Not checked yet">
        <ShieldQuestion className="size-3" /> unchecked
      </Badge>
    );
  }
  const s = STATUS[sig.status];
  return (
    <Badge tone={s.tone} title={sig.description}>
      <s.Icon className="size-3" /> {s.label}
    </Badge>
  );
}

/** The description without the word the badge next to it already shows. */
function statusDetail(sig: SignatureStatusView): string {
  const label = STATUS[sig.status].label;
  const d = sig.description;
  if (d.toLowerCase().startsWith(`${label}: `)) return d.slice(label.length + 2);
  if (d.toLowerCase().startsWith(`${label} `)) return d.slice(label.length + 1);
  return d;
}

function StatusLine({ sig }: { sig: SignatureStatusView | null }) {
  if (!sig) return <span className="text-xs text-ink-3">not checked yet</span>;
  return (
    <span className="text-xs text-ink-2">
      {statusDetail(sig)}
      {sig.keyFingerprint && (
        <span className="font-mono text-ink-3" title={`sha256:${sig.keyFingerprint}`}>
          {" "}
          ({sig.keyFingerprint.slice(0, 16)})
        </span>
      )}
      {sig.status === "keyless" && sig.issuer && <span className="text-ink-3"> · issuer {sig.issuer}</span>}
      <span className="text-ink-3"> · checked {relativeTime(sig.checkedAt)}</span>
    </span>
  );
}

function SourceBadge({ source, tag }: { source: "referrer" | "tag"; tag: string | null }) {
  return source === "referrer" ? (
    <Badge tone="neutral" title="Attached through the OCI referrers API (subject)">
      <Link2 className="size-3" /> referrer
    </Badge>
  ) : (
    <Badge tone="neutral" title={tag ?? "cosign tag convention"}>
      <TagIcon className="size-3" /> tag
    </Badge>
  );
}

function SubjectNote({ view, subjectDigest }: { view: AttestationView; subjectDigest: string }) {
  if (view.subjects.length < 2) return null;
  const s = view.subjects.find((x) => x.digest === subjectDigest);
  return (
    <span className="text-xs text-ink-3">
      {`for ${s?.label ?? "variant"} `}
      <span className="font-mono">{subjectDigest.slice(7, 19)}</span>
    </span>
  );
}

function DownloadLink({ href, label = "Download" }: { href: string; label?: string }) {
  return (
    <a href={href} className={buttonClasses("secondary", "sm")}>
      <Download className="size-3.5" /> {label}
    </a>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section>
      <div className="eyebrow mb-2">
        {title} <span className="font-mono text-ink-3">({count})</span>
      </div>
      {children}
    </section>
  );
}

function shortCommit(c: string | null): string | null {
  return c ? c.slice(0, 12) : null;
}

/**
 * The Attestations tab of a tag page: cosign signatures with their
 * verification status, SBOM cards, SLSA provenance and everything else
 * attached to the image.
 */
export function AttestationsPanel({
  view,
  repositoryId,
  digest,
  digestReference,
  policyHref,
  canReverify,
  signaturesRequired,
}: {
  view: AttestationView;
  repositoryId: string;
  digest: string;
  /** registry/org/name@sha256:… — what cosign commands take. */
  digestReference: string;
  policyHref: string;
  canReverify: boolean;
  signaturesRequired: boolean;
}) {
  // An attestation carries a signature too: counting only the plain ones read
  // as "0 verified signatures" next to a card that said it was verified.
  const signed = [...view.signatures, ...view.sboms, ...view.provenance, ...view.others];
  const verified = signed.filter((s) => s.sig?.status === "verified").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">
          {view.total === 0
            ? "Nothing is attached to this image."
            : `${view.total} artifact${view.total === 1 ? "" : "s"} attached · ${verified} verified signature${verified === 1 ? "" : "s"} · ${view.trustedKeys} trusted key${view.trustedKeys === 1 ? "" : "s"}${view.memberKeys > 0 ? ` + ${view.memberKeys} member key${view.memberKeys === 1 ? "" : "s"}` : ""} in scope`}
          {signaturesRequired && (
            <span className="text-ink-3"> · signatures are required by the pull policy</span>
          )}
        </p>
        {canReverify && view.total > 0 && <ReverifyButton repositoryId={repositoryId} digest={digest} />}
      </div>

      {view.trustedKeys === 0 && view.memberKeys === 0 && signed.some((s) => s.sig) && (
        <div className="rounded-xl border border-line bg-card-2 px-4 py-3 text-sm text-ink-2">
          No signing key is in scope for this repository, so signatures show as unverified. Owners and admins can add the signer&apos;s{" "}
          <code className="font-mono">cosign.pub</code> under{" "}
          <Link href={policyHref} className="underline hover:text-ink">
            Settings → Policies
          </Link>
          , or members who may push register their own key under{" "}
          <Link href="/settings/signing-keys" className="underline hover:text-ink">
            Settings → Signing keys
          </Link>
          .
        </div>
      )}

      {view.total === 0 && (
        <div className="space-y-3 rounded-xl border border-line bg-card p-4 text-sm text-ink-2">
          <p>
            Sign the image or attach an SBOM with cosign or oras and it shows up here.
            {view.trustedKeys === 0 && view.memberKeys === 0 && " Register your public key under Settings → Signing keys so signatures verify."}
          </p>
          <CommandLine command={`cosign sign --key cosign.key ${digestReference}`} />
          <CommandLine command={`cosign attest --key cosign.key --type spdxjson --predicate sbom.spdx.json ${digestReference}`} />
          <CommandLine command={`oras attach --artifact-type application/spdx+json ${digestReference} sbom.spdx.json:application/spdx+json`} />
          <p className="text-xs text-ink-3">
            Add <code className="font-mono">--allow-http-registry</code> for a registry without TLS. cosign v2 signatures and{" "}
            <code className="font-mono">cosign attach sbom</code> work too.
          </p>
        </div>
      )}

      {view.signatures.length > 0 && (
        <Section title="Signatures" count={view.signatures.length}>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-card">
            {view.signatures.map((s) => (
              <li key={s.digest} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <SignatureStatusBadge sig={s.sig} />
                  <span className="text-sm font-medium">{signatureFormatLabel(s.format)}</span>
                  <SourceBadge source={s.source} tag={s.tag} />
                  <SubjectNote view={view} subjectDigest={s.subjectDigest} />
                  <span className="ml-auto text-xs text-ink-3">{relativeTime(s.createdAt)}</span>
                </div>
                <StatusLine sig={s.sig} />
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
                  <span>
                    manifest <Digest digest={s.digest} />
                  </span>
                  {s.sig?.checks[0]?.signedReference && <span className="break-all">reference {s.sig.checks[0].signedReference}</span>}
                  {s.sig?.checks[0]?.payloadDigest && (
                    <span>
                      payload <Digest digest={s.sig.checks[0].payloadDigest} />
                    </span>
                  )}
                  {s.signatures > 1 && <span>{s.signatures} signatures</span>}
                  {s.sig?.status === "keyless" && (
                    <span>
                      identity {s.sig.identity ?? "unknown"} — Fulcio certificate chain and Rekor log are not verified by this
                      registry
                    </span>
                  )}
                  <a href={`${s.downloadHref}?raw=1`} className="underline hover:text-ink">
                    raw payload
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {view.sboms.length > 0 && (
        <Section title="SBOMs" count={view.sboms.length}>
          <div className="grid gap-3 md:grid-cols-2">
            {view.sboms.map((s) => (
              <div key={s.digest} className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <FileBox className="size-4 text-ink-3" />
                  <span className="text-sm font-medium">
                    {s.sbom ? (s.sbom.format === "spdx" ? "SPDX" : "CycloneDX") : predicateLabel(s.predicateType, null)}
                    {s.sbom?.specVersion && <span className="text-ink-3"> · {s.sbom.specVersion}</span>}
                  </span>
                  <SourceBadge source={s.source} tag={s.tag} />
                  {s.attested && (
                    <Badge tone="info" title="Wrapped in an in-toto attestation (DSSE envelope)">
                      attested
                    </Badge>
                  )}
                  <SubjectNote view={view} subjectDigest={s.subjectDigest} />
                </div>
                {s.sbom ? (
                  <div>
                    <div className="text-sm text-ink-2">
                      <span className="font-display text-xl font-semibold tabular-nums text-ink">{s.sbom.packageCount}</span>{" "}
                      package{s.sbom.packageCount === 1 ? "" : "s"}
                    </div>
                    {/* Its own line: an image reference carries a 64-character digest. */}
                    {s.sbom.name && (
                      <div className="mt-1 font-mono text-xs text-ink-3 [overflow-wrap:anywhere]">in {s.sbom.name}</div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-ink-3">{s.error ?? "No summary available."}</p>
                )}
                {s.sbom && s.sbom.components.length > 0 && (
                  <SbomPackages
                    preview={s.sbom.components.filter((c) => c.name !== s.sbom?.name)}
                    packageCount={s.sbom.packageCount}
                    href={s.downloadHref}
                    label={s.sbom.name ?? ""}
                  />
                )}
                <div className="text-xs text-ink-3">
                  {s.sbom?.tool && <span>generated by {s.sbom.tool} · </span>}
                  {s.sbom?.createdAt && <span>{formatDate(s.sbom.createdAt)} · </span>}
                  <span>{formatBytes(s.sizeBytes)}</span>
                </div>
                {s.attested && (
                  <div className="flex flex-wrap items-center gap-2">
                    <SignatureStatusBadge sig={s.sig} />
                    <StatusLine sig={s.sig} />
                  </div>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-2">
                  <DownloadLink href={s.downloadHref} label={s.attested ? "Download SBOM" : "Download"} />
                  {s.attested && (
                    <a href={`${s.downloadHref}?raw=1`} className="text-xs text-ink-3 underline hover:text-ink">
                      raw envelope
                    </a>
                  )}
                  <span className="ml-auto text-xs text-ink-3">{relativeTime(s.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {view.provenance.length > 0 && (
        <Section title="Provenance" count={view.provenance.length}>
          <div className="grid gap-3">
            {view.provenance.map((p) => (
              <div key={p.digest} className="flex flex-col gap-3 rounded-xl border border-line bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <GitCommitHorizontal className="size-4 text-ink-3" />
                  <span className="text-sm font-medium">{p.provenance?.version ?? predicateLabel(p.predicateType, "provenance")}</span>
                  <SourceBadge source={p.source} tag={p.tag} />
                  <SubjectNote view={view} subjectDigest={p.subjectDigest} />
                  <span className="ml-auto text-xs text-ink-3">{relativeTime(p.createdAt)}</span>
                </div>
                {p.provenance ? (
                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <Item label="Builder">{p.provenance.builderId}</Item>
                    <Item label="Build type">{p.provenance.buildType}</Item>
                    <Item label="Source">
                      {p.provenance.sourceUri}
                      {p.provenance.sourceCommit && (
                        <span className="font-mono text-ink-2"> @ {shortCommit(p.provenance.sourceCommit)}</span>
                      )}
                    </Item>
                    <Item label="Entry point">{p.provenance.entryPoint}</Item>
                    <Item label="Invocation">
                      {p.provenance.invocationId && /^https?:\/\//.test(p.provenance.invocationId) ? (
                        <a href={p.provenance.invocationId} className="underline hover:text-ink" rel="noreferrer">
                          {p.provenance.invocationId}
                        </a>
                      ) : (
                        p.provenance.invocationId
                      )}
                    </Item>
                    <Item label="Build time">
                      {p.provenance.startedOn
                        ? `${formatDate(p.provenance.startedOn)}${p.provenance.finishedOn ? ` → ${new Date(p.provenance.finishedOn).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : ""}`
                        : null}
                    </Item>
                    <Item label="Dependencies">{String(p.provenance.dependencies)}</Item>
                    {p.provenance.parameters && (
                      <Item label="Parameters">
                        <span className="font-mono text-xs">
                          {Object.entries(p.provenance.parameters)
                            .map(([k, v]) => `${k}=${String(v)}`)
                            .join("  ")}
                        </span>
                      </Item>
                    )}
                  </dl>
                ) : (
                  <p className="text-sm text-ink-3">{p.error ?? "The predicate could not be summarised."}</p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <SignatureStatusBadge sig={p.sig} />
                  <StatusLine sig={p.sig} />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <DownloadLink href={p.downloadHref} label="Download predicate" />
                  <a href={`${p.downloadHref}?raw=1`} className="text-xs text-ink-3 underline hover:text-ink">
                    raw envelope
                  </a>
                  <span className="ml-auto font-mono text-xs text-ink-3">{p.predicateType}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {view.others.length > 0 && (
        <Section title="Other referrers" count={view.others.length}>
          <div className="overflow-x-auto rounded-xl border border-line bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-2 text-xs font-medium text-ink-2">Type</th>
                  <th className="px-4 py-2 text-xs font-medium text-ink-2">Media type</th>
                  <th className="hidden px-4 py-2 text-xs font-medium text-ink-2 sm:table-cell">Digest</th>
                  <th className="px-4 py-2 text-xs font-medium text-ink-2">Signature</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-ink-2">Size</th>
                  <th className="w-10 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {view.others.map((o) => (
                  <tr key={o.digest} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span>{o.kind === "attestation" ? predicateLabel(o.predicateType, o.subkind) : (o.artifactType ?? "artifact")}</span>
                        <SourceBadge source={o.source} tag={o.tag} />
                        <SubjectNote view={view} subjectDigest={o.subjectDigest} />
                      </div>
                    </td>
                    <td className="break-all px-4 py-2.5 font-mono text-xs text-ink-2">{o.artifactType ?? o.mediaType}</td>
                    <td className="hidden px-4 py-2.5 sm:table-cell">
                      <Digest digest={o.digest} />
                    </td>
                    <td className="px-4 py-2.5">
                      {o.format === "raw" || o.format === "unknown" ? <span className="text-xs text-ink-3">—</span> : <SignatureStatusBadge sig={o.sig} />}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-[13px] tabular-nums text-ink-2">{formatBytes(o.sizeBytes)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <a href={o.downloadHref} className="inline-flex rounded-md p-1.5 text-ink-3 hover:bg-card-2 hover:text-ink" aria-label="Download">
                        <Download className="size-4" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="min-w-0">
      <dt className="eyebrow mb-0.5">{label}</dt>
      <dd className="break-all text-sm">{children}</dd>
    </div>
  );
}
