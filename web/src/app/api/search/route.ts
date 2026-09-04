// GET /api/search?q=… — the typeahead behind the header search box: up to
// eight mixed hits (repositories, tags, digests, organizations) as JSON,
// filtered by what the caller's session may see. Anonymous callers get
// public repositories only.
import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { quickSearch } from "@/lib/search";
import { normalizeQuery, SEARCH_MIN_TYPEAHEAD, SEARCH_TYPEAHEAD_LIMIT } from "@/lib/search-shared";
import { viewerFromSession } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = normalizeQuery(req.nextUrl.searchParams.get("q"));
  const headers = { "Cache-Control": "private, no-store" };
  if (q.length < SEARCH_MIN_TYPEAHEAD) return NextResponse.json({ q, hits: [] }, { headers });
  const auth = await getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  const hits = await quickSearch(viewerFromSession(session), q, SEARCH_TYPEAHEAD_LIMIT);
  return NextResponse.json({ q, hits }, { headers });
}
