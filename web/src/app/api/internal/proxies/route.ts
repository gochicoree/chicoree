// Proxy-cache configuration feed for registryd: every organization proxy
// with its credentials decrypted. Authenticated with the shared webhook
// secret; only reachable on the internal network.
import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { listProxyConfigs } from "@/lib/proxy";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(env.webhookSecret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const proxies = await listProxyConfigs();
  return NextResponse.json({ proxies }, { headers: { "Cache-Control": "no-store" } });
}
