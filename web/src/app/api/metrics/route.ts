import { timingSafeEqual } from "node:crypto";
import { getInstanceSettings } from "@/lib/instance-settings";
import { renderMetrics } from "@/lib/metrics";

export const dynamic = "force-dynamic";

function tokenMatches(header: string | null, expected: string): boolean {
  if (!expected) return false;
  const given = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Prometheus scrape target. Enabled from Administration → Metrics; every
 * scrape must carry the configured bearer token.
 */
export async function GET(req: Request) {
  const { metrics } = await getInstanceSettings();
  if (!metrics.enabled) return new Response("metrics endpoint is disabled", { status: 404 });
  if (!tokenMatches(req.headers.get("authorization"), metrics.token)) {
    return new Response("unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="metrics"' },
    });
  }
  const body = await renderMetrics();
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
