// GET /api/search?q=… — the typeahead behind the header search box: up to
// eight mixed hits (repositories, tags, digests, organizations) as JSON,
// filtered by what the caller's session may see. Anonymous callers get
// public repositories only and share the anonymous API budget per address.
import { NextRequest, NextResponse } from "next/server";
import type { ApiCaller } from "@/lib/api/auth";
import { checkApiRateLimit } from "@/lib/api/rate-limit";
import { ApiError, errorResponse } from "@/lib/api/respond";
import { clientIp } from "@/lib/audit";
import { getAuth } from "@/lib/auth";
import { quickSearch } from "@/lib/search";
import { normalizeQuery, SEARCH_MIN_TYPEAHEAD, SEARCH_TYPEAHEAD_LIMIT } from "@/lib/search-shared";
import { ANONYMOUS, viewerFromSession } from "@/lib/viewer";

export const dynamic = "force-dynamic";

const ANONYMOUS_CALLER: ApiCaller = {
  kind: "anonymous",
  via: "none",
  viewer: ANONYMOUS,
  caller: { kind: "anonymous" },
  subject: "anonymous",
  auditActor: { type: "system", label: "anonymous" },
};

export async function GET(req: NextRequest) {
  const q = normalizeQuery(req.nextUrl.searchParams.get("q"));
  const headers = { "Cache-Control": "private, no-store" };
  if (q.length < SEARCH_MIN_TYPEAHEAD) return NextResponse.json({ q, hits: [] }, { headers });
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    try {
      await checkApiRateLimit(ANONYMOUS_CALLER, clientIp(req.headers));
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      throw err;
    }
  }
  const hits = await quickSearch(viewerFromSession(session), q, SEARCH_TYPEAHEAD_LIMIT);
  return NextResponse.json({ q, hits }, { headers });
}
