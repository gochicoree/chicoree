// GET /api/v1/repos/{org}/{repo}/manifests/{digest}/artifacts — signatures,
// SBOMs and provenance attached to the image, with their verification state.
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { manifests } from "@/db/schema";
import { loadRepo } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json, notFound, requireDigest } from "@/lib/api/respond";
import { absolute } from "@/lib/api/serialize";
import { decodeRepoParam } from "@/lib/proxy-shared";
import { getAttestationView, type SignatureStatusView } from "@/lib/signatures";

export const dynamic = "force-dynamic";

/** Rename the UI-facing fields: the download link becomes absolute, `sig` becomes `verification`. */
function artifact<T extends { downloadHref: string; sig: SignatureStatusView | null }>({ downloadHref, sig, ...rest }: T) {
  return { ...rest, download: absolute(downloadHref), verification: sig };
}

export const GET = route<{ org: string; repo: string; digest: string }>(async (_req, { caller, params }) => {
  const a = await loadRepo(caller, params.org, decodeRepoParam(params.repo));
  const digest = requireDigest(params.digest);
  const m = await db.query.manifests.findFirst({
    where: and(eq(manifests.repositoryId, a.repo.id), eq(manifests.digest, digest)),
    columns: { payload: true },
  });
  if (!m) throw notFound("No such image in this repository.");
  let payload: { manifests?: { digest?: string; platform?: { os?: string; architecture?: string; variant?: string } }[] } = {};
  try {
    payload = JSON.parse(m.payload);
  } catch {
    // described without variants
  }
  const view = await getAttestationView(a.repo, a.org.slug, digest, payload);
  return json({
    subjects: view.subjects,
    signatures: view.signatures.map(artifact),
    sboms: view.sboms.map(artifact),
    provenance: view.provenance.map(artifact),
    others: view.others.map(artifact),
    trustedKeys: view.trustedKeys,
    memberKeys: view.memberKeys,
    trustedIdentities: view.trustedIdentities,
    total: view.total,
  });
});
