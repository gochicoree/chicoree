// Runs before every request that is not a static asset. Two jobs:
//
// 1. Security headers. Pages get a Content-Security-Policy with a fresh
//    nonce per request (Next.js reads it from the request header and puts
//    it on every script it emits), plus HSTS when the request came in over
//    TLS, nosniff, a referrer policy, frame denial and a permissions policy.
//    API responses get everything but the CSP — the picture route sets its
//    own, stricter one.
// 2. The request path as a header (x-pathname) for server layouts, which
//    cannot see the URL they render for; the organization layout needs it
//    to send a renamed organization's old address to the same page under
//    the new slug (lib/redirects.ts).
import { NextResponse, type NextRequest } from "next/server";

const production = process.env.NODE_ENV === "production";

function makeNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function contentSecurityPolicy(nonce: string, https: boolean): string {
  const directives = [
    "default-src 'self'",
    // Next.js inline bootstrapping and every chunk it loads carry the nonce;
    // strict-dynamic lets those scripts load further chunks. Development
    // needs eval for React refresh.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? "" : " 'unsafe-eval'"}`,
    // Tailwind output is a stylesheet; inline style attributes (chart
    // widths, brand colour) need unsafe-inline for styles only.
    "style-src 'self' 'unsafe-inline'",
    // README images may live anywhere on https; QR codes and previews are
    // data/blob URLs; avatars are served by this app.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${production ? "" : " ws: wss:"}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", path);

  const https =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() === "https" ||
    req.nextUrl.protocol === "https:" ||
    (process.env.APP_URL ?? "").startsWith("https://");
  const page = !path.startsWith("/api/");

  let csp: string | null = null;
  if (page) {
    const nonce = makeNonce();
    csp = contentSecurityPolicy(nonce, https);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("content-security-policy", csp);
  }

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  if (csp) res.headers.set("Content-Security-Policy", csp);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  if (https) res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return res;
}

export const config = {
  // Everything except Next's immutable build assets.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
