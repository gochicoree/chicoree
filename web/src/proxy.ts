// Request-path header for server layouts. Next.js layouts cannot see the URL
// they render for; the organization layout needs it to send a renamed
// organization's old address to the same page under the new slug
// (lib/redirects.ts). Nothing else happens here.
import { NextResponse, type NextRequest } from "next/server";

export function proxy(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Page routes only: no API, static assets or files with an extension.
  matcher: ["/((?!api/|_next/|favicon.ico|.*\\..*).*)"],
};
