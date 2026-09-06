// POST /api/internal/worker/claim — a scan worker asks for work. Body:
// { worker: { name, hostname?, version?, scannerVersion? }, wait?: seconds }.
// 200 with the task, or 204 when nothing is due within `wait` (≤ 20 s).
import { NextResponse, type NextRequest } from "next/server";
import { claimScanTask, heartbeat } from "@/lib/scan-tasks";
import { workerRequest } from "@/lib/scan-worker-auth";

export const dynamic = "force-dynamic";
const MAX_WAIT_MS = 20_000;
const POLL_MS = 2_000;

export async function POST(req: NextRequest) {
  const gate = await workerRequest(req);
  if (!gate.ok) return gate.response;
  const { body, worker } = gate;
  await heartbeat(worker, typeof body.running === "number" ? body.running : 0);
  const wait = Math.min(MAX_WAIT_MS, Math.max(0, Number(body.wait ?? 0) * 1000));
  const deadline = Date.now() + wait;
  for (;;) {
    const task = await claimScanTask(worker);
    if (task) return NextResponse.json({ task }, { headers: { "Cache-Control": "no-store" } });
    if (Date.now() + POLL_MS > deadline || req.signal.aborted) return new NextResponse(null, { status: 204 });
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}
