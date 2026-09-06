// POST /api/internal/worker/tasks/<id>/result — the scan output of a task
// leased to this worker: { worker, result: { raw, scannerVersion, findings? } }.
// `raw` is Trivy's JSON report; the instance normalises it unless the worker
// already sends `findings` in the registry's own shape.
import { NextResponse, type NextRequest } from "next/server";
import { completeScanTask } from "@/lib/scan-tasks";
import { workerRequest } from "@/lib/scan-worker-auth";
import type { Finding } from "@/lib/scanner-shared";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await workerRequest(req);
  if (!gate.ok) return gate.response;
  const { id } = await params;
  const result = gate.body.result as { findings?: unknown; raw?: unknown; scannerVersion?: unknown } | undefined;
  if (!result || (result.findings !== undefined && !Array.isArray(result.findings))) {
    return NextResponse.json({ error: "body.result.findings must be an array when present" }, { status: 400 });
  }
  if (result.findings === undefined && (typeof result.raw !== "object" || result.raw === null)) {
    return NextResponse.json({ error: "body.result.raw must be the scanner's JSON report when findings are not sent" }, { status: 400 });
  }
  const ok = await completeScanTask(id, gate.worker, {
    findings: result.findings as Finding[] | undefined,
    raw: result.raw ?? null,
    scannerVersion: typeof result.scannerVersion === "string" ? result.scannerVersion : null,
  });
  if (!ok) return NextResponse.json({ error: "task is not leased to this worker (lease expired or already reported)" }, { status: 409 });
  return new NextResponse(null, { status: 204 });
}
