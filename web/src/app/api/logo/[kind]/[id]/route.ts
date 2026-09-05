// GET /api/logo/<kind>/<id>?v=<version>
//
// Serves an organization's, repository's or user's picture. The bytes are
// stored as a data: URL in one column (organization.logo, repositories.logo,
// user.image); inlining a 64 KB data URL into every row of a listing would
// bloat the HTML, so pages carry only the id and a version and the browser
// fetches the picture from here.
//
// Caching: the response carries a strong ETag (the MD5 of the stored data
// URL) and `max-age=31536000, immutable`. The `v` parameter is the first
// eight digits of that same MD5, so replacing a picture changes the URL — no
// revalidation round-trip, and no stale picture either. `v` is not checked:
// it exists purely to key the cache.
//
// Access: organization and user pictures are readable by any signed-in user;
// a repository's picture follows the repository — public ones are open,
// private ones need a membership (instance admins included), and a private
// repository's picture is marked `private` so shared caches never keep it.
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db";
import { organization, repositories, user as userTable } from "@/db/schema";
import { getOrgRole, getSession } from "@/lib/session";
import { decodeLogo, etagMatches, gravatarUrl } from "@/lib/logo";
import { isLogoKind } from "@/lib/logo-shared";
import { getInstanceSettings } from "@/lib/instance-settings";

export const dynamic = "force-dynamic";

const ONE_YEAR = 31_536_000;

function notFound() {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  if (!isLogoKind(kind) || !id) return notFound();

  let dataUrl: string | null = null;
  let shared = true;

  if (kind === "repository") {
    const repo = await db.query.repositories.findFirst({ where: eq(repositories.id, id) });
    if (!repo) return notFound();
    if (repo.visibility !== "public") {
      // Same read access as the repository itself.
      const role = await getOrgRole(repo.organizationId);
      if (!role) return notFound();
      shared = false;
    }
    dataUrl = repo.logo;
  } else {
    // An organization's picture is public: it appears next to public
    // repositories. A user's avatar needs a session.
    if (kind === "user" && !(await getSession())) return notFound();
    if (kind === "organization") {
      const org = await db.query.organization.findFirst({ where: eq(organization.id, id) });
      dataUrl = org?.logo ?? null;
    } else {
      const u = await db.query.user.findFirst({ where: eq(userTable.id, id) });
      dataUrl = u?.image ?? null;
      if (!dataUrl && u?.email && (await getInstanceSettings()).branding.gravatar) {
        // Nothing uploaded and the instance falls back to Gravatar. d=404 in
        // the URL means an address without one lands on the initials.
        return NextResponse.redirect(gravatarUrl(u.email), {
          status: 307,
          headers: { "cache-control": "private, max-age=86400" },
        });
      }
    }
  }

  if (!dataUrl) return notFound();
  // A provider avatar (GitHub, Google) arrives as an https URL rather than
  // stored bytes; send the browser there instead of failing to decode it.
  if (/^https?:\/\//i.test(dataUrl)) {
    return NextResponse.redirect(dataUrl, {
      status: 307,
      headers: { "cache-control": `${shared ? "public" : "private"}, max-age=300` },
    });
  }
  const picture = decodeLogo(dataUrl);
  if (!picture) return notFound();

  const cacheControl = `${shared ? "public" : "private"}, max-age=${ONE_YEAR}, immutable`;
  const headers: Record<string, string> = {
    etag: picture.etag,
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
    // An SVG is a document: even though uploads are rejected when they carry
    // scripts, serve it inert.
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };

  if (etagMatches(req.headers.get("if-none-match"), picture.etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(picture.body as unknown as BodyInit, {
    headers: { ...headers, "content-type": picture.mediaType, "content-length": String(picture.body.length) },
  });
}
