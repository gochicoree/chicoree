// GET /api/artifacts/<repository id>/<artifact manifest digest>[?raw=1]
//
// Downloads the document an attached artifact carries: the SBOM / provenance
// predicate out of a DSSE envelope or Sigstore bundle, or — with ?raw=1, and
// for plain artifacts such as `cosign attach sbom` tags — the first layer
// blob byte for byte. Auth follows repository read access: public
// repositories are open, private ones need a membership (instance admins
// included).
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { organization, repositories } from "@/db/schema";
import { getOrgRole } from "@/lib/session";
import { fetchBlobBytes, openBlobStream } from "@/lib/registry-client";
import { extractPredicate, resolveArtifactDownload } from "@/lib/signatures";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ repo: string; digest: string }> }) {
  const { repo: repositoryId, digest } = await params;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return NextResponse.json({ error: "invalid digest" }, { status: 400 });
  const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, repositoryId) });
  if (!repo) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (repo.visibility !== "public") {
    const role = await getOrgRole(repo.organizationId);
    if (!role) return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const org = await db.query.organization.findFirst({ where: eq(organization.id, repo.organizationId) });
  if (!org) return NextResponse.json({ error: "not found" }, { status: 404 });

  const blob = req.nextUrl.searchParams.get("blob");
  if (blob && !/^sha256:[a-f0-9]{64}$/.test(blob)) return NextResponse.json({ error: "invalid blob digest" }, { status: 400 });
  // A named layer is always served byte for byte.
  const raw = req.nextUrl.searchParams.get("raw") === "1" || !!blob;
  const download = await resolveArtifactDownload(repo, org.slug, digest, raw, blob);
  if (!download) return NextResponse.json({ error: "artifact not found" }, { status: 404 });
  const headers: Record<string, string> = {
    "content-type": download.mediaType,
    "content-disposition": `attachment; filename="${download.filename}"`,
    "cache-control": "private, no-store",
  };

  if (download.decode) {
    const blob = await fetchBlobBytes(download.repositoryPath, download.layerDigest, 64 * 1024 * 1024);
    if (!blob) return NextResponse.json({ error: "artifact blob unavailable" }, { status: 404 });
    const predicate = extractPredicate(blob.bytes);
    if (predicate === null) return NextResponse.json({ error: "the envelope carries no in-toto predicate" }, { status: 422 });
    return new NextResponse(predicate, { headers });
  }
  const upstream = await openBlobStream(download.repositoryPath, download.layerDigest);
  if (!upstream) return NextResponse.json({ error: "artifact blob unavailable" }, { status: 502 });
  const length = upstream.headers.get("content-length");
  if (length) headers["content-length"] = length;
  return new NextResponse(upstream.body, { headers });
}
