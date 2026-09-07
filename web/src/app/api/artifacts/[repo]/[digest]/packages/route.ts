// GET /api/artifacts/<repository id>/<artifact manifest digest>/packages?q=&page=&per_page=
//
// One page of the packages an SBOM artifact lists, for the tag page's
// package dialog. Auth follows repository read access like the download
// route next door; the same library serves the public API.
import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { organization, repositories } from "@/db/schema";
import { paged, pageParams } from "@/lib/api/respond";
import { loadSbomPackages, pageSbomPackages } from "@/lib/sbom-packages";
import { getOrgRole } from "@/lib/session";

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
  const list = await loadSbomPackages(repo, org.slug, digest, blob);
  if (!list) return NextResponse.json({ error: "no SBOM document" }, { status: 404 });
  const { page, pageSize } = pageParams(req.nextUrl, { defaultSize: 100, max: 500 });
  const { items, state } = pageSbomPackages(list, req.nextUrl.searchParams.get("q") ?? "", page, pageSize);
  return NextResponse.json(paged(items, state), { headers: { "cache-control": "private, no-store" } });
}
