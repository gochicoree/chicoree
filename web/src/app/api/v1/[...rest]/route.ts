// Anything under /api/v1 that no handler claims: a JSON 404 instead of the
// HTML not-found page, so scripts get a parsable answer.
import { NextResponse } from "next/server";
import { apiHeaders } from "@/lib/api/respond";
import { API_BASE } from "@/lib/api/version";

export const dynamic = "force-dynamic";

function missing(req: Request) {
  const path = new URL(req.url).pathname;
  return NextResponse.json(
    { error: `No endpoint at ${req.method} ${path}. GET ${API_BASE} lists every endpoint.`, code: "not_found" },
    { status: 404, headers: apiHeaders() },
  );
}

export const GET = missing;
export const POST = missing;
export const PUT = missing;
export const PATCH = missing;
export const DELETE = missing;
