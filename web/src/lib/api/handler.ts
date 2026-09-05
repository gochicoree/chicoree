// Wraps a route handler of the REST API: refuses while the API is switched
// off, authenticates the caller, applies the request limit, resolves the
// dynamic route parameters, turns thrown ApiErrors into JSON error
// responses (anything else becomes a logged 500), stamps rate-limit and
// deprecation headers, and counts the request for the metrics endpoint.
import { createHash } from "crypto";
import type { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/audit";
import { getInstanceSettings } from "@/lib/instance-settings";
import { env } from "@/lib/env";
import { authenticate, type ApiCaller } from "./auth";
import { deprecationHeaders, matchEndpoint } from "./match";
import { checkApiRateLimit, exhaustedHeaders, rateLimitHeaders, type RateLimitState } from "./rate-limit";
import { ApiError, apiDisabled, errorResponse } from "./respond";
import { recordApiRequest } from "./stats";

export interface ApiContext<P> {
  caller: ApiCaller;
  params: P;
  url: URL;
}

type RouteContext<P> = { params: Promise<P> };

export function route<P extends Record<string, string> = Record<string, never>>(
  fn: (req: NextRequest, ctx: ApiContext<P>) => Promise<NextResponse | Response>,
) {
  return async (req: NextRequest, ctx: RouteContext<P>): Promise<NextResponse | Response> => {
    const endpoint = matchEndpoint(req.method, req.nextUrl.pathname);
    let credential = "none";
    let limitState: RateLimitState | null = null;
    let res: NextResponse | Response;
    let exhausted: Record<string, string> = {};
    try {
      // The switch is read on every request, so flipping it takes effect at once.
      if (!(await getInstanceSettings()).access.apiEnabled) throw apiDisabled();
      const [caller, params] = await Promise.all([authenticate(req), ctx.params]);
      credential = caller.via;
      limitState = await checkApiRateLimit(caller, clientIp(req.headers));
      res = await fn(req, { caller, params, url: req.nextUrl });
    } catch (err) {
      if (err instanceof ApiError) {
        res = errorResponse(err);
        exhausted = exhaustedHeaders(err);
      } else {
        console.error(`[api] ${req.method} ${req.nextUrl.pathname} failed:`, err);
        res = errorResponse(new ApiError("internal", "Something went wrong on the server."));
      }
    }
    const extra = {
      ...rateLimitHeaders(limitState),
      ...exhausted,
      ...(endpoint ? deprecationHeaders(endpoint, `${env.appUrl.replace(/\/$/, "")}/docs/api`) : {}),
    };
    for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
    // Conditional GETs: a weak ETag over the body; an If-None-Match hit answers 304 with the same headers.
    if (req.method === "GET" && res.status === 200 && (res.headers.get("content-type") ?? "").includes("json")) {
      const body = await res.clone().text();
      const etag = `W/"${createHash("sha1").update(body).digest("base64url").slice(0, 27)}"`;
      res.headers.set("ETag", etag);
      const inm = req.headers.get("if-none-match");
      if (inm && inm.split(",").some((t) => t.trim() === etag || t.trim() === "*")) {
        recordApiRequest({ endpoint: endpoint?.path ?? "unknown", method: req.method, status: 304, credential });
        const headers = new Headers(res.headers);
        headers.delete("content-length");
        headers.delete("content-type");
        return new Response(null, { status: 304, headers });
      }
    }
    recordApiRequest({ endpoint: endpoint?.path ?? "unknown", method: req.method, status: res.status, credential });
    return res;
  };
}
