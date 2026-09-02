// GET /api/jobs/runs — recent job runs (newest first).
import { NextRequest, NextResponse } from "next/server";
import { authenticateJobsRequest } from "@/lib/jobs-auth";
import { recentJobRuns } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateJobsRequest(req.headers.get("authorization"));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  const limit = Math.min(200, Number(req.nextUrl.searchParams.get("limit")) || 50);
  return NextResponse.json({ runs: await recentJobRuns(limit) });
}
