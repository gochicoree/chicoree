// Wraps a route handler of the REST API: authenticates the caller, resolves
// the dynamic route parameters, and turns thrown ApiErrors into JSON error
// responses (anything else becomes a logged 500).
import type { NextRequest, NextResponse } from "next/server";
import { authenticate, type ApiCaller } from "./auth";
import { ApiError, errorResponse } from "./respond";

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
    try {
      const [caller, params] = await Promise.all([authenticate(req), ctx.params]);
      return await fn(req, { caller, params, url: req.nextUrl });
    } catch (err) {
      if (err instanceof ApiError) return errorResponse(err);
      console.error(`[api] ${req.method} ${req.nextUrl.pathname} failed:`, err);
      return errorResponse(new ApiError("internal", "Something went wrong on the server."));
    }
  };
}
