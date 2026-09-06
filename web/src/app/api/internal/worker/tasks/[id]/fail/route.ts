// POST /api/internal/worker/tasks/<id>/fail — { worker, error }: the task is
// retried later, or marked failed after the last attempt.
import { NextResponse, type NextRequest } from "next/server";
import { failScanTask } from "@/lib/scan-tasks";
import { workerRequest } from "@/lib/scan-worker-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await workerRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const error = typeof gate.body.error === "string" && gate.body.error.trim() ? gate.body.error : "worker reported a failure";
  const ok = await failScanTask(id, gate.worker, error);
  if (!ok) return NextResponse.json({ error: "task is not leased to this worker (lease expired or already reported)" }, { status: 409 });
  return new NextResponse(null, { status: 204 });
}
