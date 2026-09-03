// GET /api/health — unauthenticated liveness for uptime monitors: pings the
// database and registryd (3 s timeouts) and answers 200 when both respond,
// 503 otherwise. No versions or internals are exposed here; the admin health
// page has those.
import { NextResponse } from "next/server";
import { quickHealth } from "@/lib/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const h = await quickHealth();
  return NextResponse.json(
    {
      status: h.status,
      checks: {
        database: { ok: h.database.ok, latencyMs: h.database.latencyMs },
        registry: { ok: h.registry.ok, latencyMs: h.registry.latencyMs },
      },
      time: new Date().toISOString(),
    },
    { status: h.status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
