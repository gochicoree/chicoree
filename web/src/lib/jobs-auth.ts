// Authentication for the jobs API: either the static JOBS_API_TOKEN or a
// personal access token (write scope) belonging to an instance admin. Token
// expiry, restrictions and last-use bookkeeping come from lib/credential-auth.ts.
import { timingSafeEqual } from "crypto";
import { env } from "./env";
import { PAT_PREFIX } from "./secrets";
import { identifyAccessToken } from "./credential-auth";
import { clientIp } from "./audit";

export async function authenticateJobsRequest(
  authorization: string | null,
  /** Request headers, for the client address recorded on the token. */
  headers?: Headers | null,
): Promise<{ ok: true; triggeredBy: string } | { ok: false; error: string }> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, error: "missing bearer token" };

  if (env.jobsApiToken) {
    const a = Buffer.from(token);
    const b = Buffer.from(env.jobsApiToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, triggeredBy: "api-token" };
  }

  if (token.startsWith(PAT_PREFIX)) {
    const res = await identifyAccessToken(token, clientIp(headers));
    if ("error" in res) return { ok: false, error: res.error };
    if (res.token.scope !== "write") return { ok: false, error: "a read & write access token is required" };
    if (res.caller.restriction) return { ok: false, error: "a token limited to one organization cannot use the jobs API" };
    if (res.user.role !== "admin") return { ok: false, error: "token does not belong to an administrator" };
    return { ok: true, triggeredBy: `user:${res.user.id}` };
  }
  return { ok: false, error: "invalid credential" };
}
