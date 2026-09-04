import { NextResponse } from "next/server";
import { localSignInCookieValue } from "@/lib/auth-access";
import { LOCAL_SIGNIN_COOKIE } from "@/lib/access-shared";
import { env } from "@/lib/env";
import { getInstanceSettings } from "@/lib/instance-settings";

/**
 * The hidden sign-in page posts its slug here before a local sign-in. A
 * correct slug earns the short-lived cookie the auth hook looks for; a wrong
 * one looks like any other missing page.
 */
export async function POST(req: Request) {
  const access = (await getInstanceSettings()).access;
  const body = (await req.json().catch(() => null)) as { slug?: unknown } | null;
  const slug = typeof body?.slug === "string" ? body.slug : "";
  if (access.localSignIn !== "hidden" || !slug || slug !== access.localSignInPath) {
    return new NextResponse(null, { status: 404 });
  }
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(LOCAL_SIGNIN_COOKIE, localSignInCookieValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.appUrl.startsWith("https://"),
    path: "/api/auth",
    maxAge: 10 * 60,
  });
  return res;
}
