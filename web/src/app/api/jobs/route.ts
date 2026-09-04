// GET /api/jobs — list available jobs and recent runs.
import { NextRequest, NextResponse } from "next/server";
import { authenticateJobsRequest } from "@/lib/jobs-auth";
import { listJobs, recentJobRuns } from "@/lib/jobs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await authenticateJobsRequest(req.headers.get("authorization"), req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });
  const [runs, jobs] = await Promise.all([recentJobRuns(20), listJobs()]);
  return NextResponse.json({
    jobs: jobs.map(({ name, title, description, params }) => ({ name, title, description, params })),
    runs,
  });
}
