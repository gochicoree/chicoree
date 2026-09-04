// Server-side half of the local sign-in policy (Administration → Auth
// providers → Access). The sign-in page hides the local methods; this hook
// refuses the matching better-auth endpoints, so hiding is not merely cosmetic.
import { createHmac, timingSafeEqual } from "crypto";
import { APIError } from "better-auth/api";
import { isLocalSignInRequest, LOCAL_SIGNIN_COOKIE, LOCAL_SIGNIN_DISABLED } from "./access-shared";
import { env } from "./env";
import { getInstanceSettings } from "./instance-settings";

/** Value the hidden page's browser carries in its cookie; nobody without AUTH_SECRET can mint it. */
export function localSignInCookieValue(): string {
  return createHmac("sha256", env.authSecret).update("local-signin").digest("hex");
}

function hasLocalCookie(headers: Headers | null | undefined): boolean {
  const raw = headers?.get("cookie") ?? "";
  const m = new RegExp(`(?:^|;\\s*)${LOCAL_SIGNIN_COOKIE}=([a-f0-9]+)`).exec(raw);
  if (!m) return false;
  const expected = Buffer.from(localSignInCookieValue());
  const got = Buffer.from(m[1]);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Throws for password / magic-link / email-code attempts the policy does not allow. */
export async function enforceLocalSignIn(ctx: { path?: string; headers?: Headers | null; body?: unknown }): Promise<void> {
  if (!ctx.path || !isLocalSignInRequest(ctx.path, ctx.body)) return;
  const access = (await getInstanceSettings()).access;
  if (access.localSignIn === "everyone") return;
  if (access.localSignIn === "hidden" && hasLocalCookie(ctx.headers)) return;
  throw new APIError("FORBIDDEN", { message: LOCAL_SIGNIN_DISABLED });
}
