// POST /api/jobs/<name> — run a job. Parameters come from the query string or
// a JSON body. Add ?wait=false to return immediately with the run id.
//
//   curl -X POST -H "Authorization: Bearer $JOBS_API_TOKEN" \
//        "https://registry.example.com/api/jobs/gc?grace=30m"
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { authenticateJobsRequest } from "@/lib/jobs-auth";
import { JOBS, runJob } from "@/lib/jobs";
import { recordAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ job: string }> }) {
  const auth = await authenticateJobsRequest(req.headers.get("authorization"));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: 401 });

  const { job } = await params;
  if (!JOBS[job]) {
    return NextResponse.json({ error: `unknown job "${job}"`, available: Object.keys(JOBS) }, { status: 404 });
  }

  const jobParams: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((v, k) => {
    if (k !== "wait") jobParams[k] = v;
  });
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body)) jobParams[k] = String(v);
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
  }

  // Audit actor: the static token or the admin behind the access token.
  const actor = auth.triggeredBy.startsWith("user:") ? { type: "user" as const, id: auth.triggeredBy.slice(5), label: "" } : { type: "api-token" as const, label: "JOBS_API_TOKEN" };
  await recordAudit({ action: "job.run", actor, targetType: "job", targetId: job, targetLabel: job, details: { params: jobParams, via: "api" }, headers: req.headers });

  if (req.nextUrl.searchParams.get("wait") === "false") {
    after(async () => {
      await runJob(job, jobParams, auth.triggeredBy).catch((err) => console.error("job failed:", err));
    });
    return NextResponse.json({ job, status: "queued" }, { status: 202 });
  }

  const run = await runJob(job, jobParams, auth.triggeredBy);
  return NextResponse.json({ job, ...run }, { status: run.status === "succeeded" ? 200 : 500 });
}
