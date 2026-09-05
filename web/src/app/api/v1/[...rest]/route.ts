// Anything under /api/v1 that no handler claims: a JSON 404 instead of the
// HTML not-found page, so scripts get a parsable answer.
import { NextResponse } from "next/server";
import { apiDisabled, apiHeaders, errorResponse } from "@/lib/api/respond";
import { API_BASE } from "@/lib/api/version";
import { getInstanceSettings } from "@/lib/instance-settings";

export const dynamic = "force-dynamic";

async function missing(req: Request) {
  if (!(await getInstanceSettings()).access.apiEnabled) return errorResponse(apiDisabled());
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
