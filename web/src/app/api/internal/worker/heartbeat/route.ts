// POST /api/internal/worker/heartbeat — { worker, running } every 30 s.
import { NextResponse, type NextRequest } from "next/server";
import { heartbeat } from "@/lib/scan-tasks";
import { workerRequest } from "@/lib/scan-worker-auth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await workerRequest(req);
  if (!gate.ok) return gate.response;
  await heartbeat(gate.worker, typeof gate.body.running === "number" ? gate.body.running : 0);
  return new NextResponse(null, { status: 204 });
}
