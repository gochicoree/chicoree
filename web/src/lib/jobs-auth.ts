// Authentication for the jobs API: either the static JOBS_API_TOKEN or a
// personal access token (write scope) belonging to an instance admin.
import { eq } from "drizzle-orm";
import { timingSafeEqual } from "crypto";
import { db } from "@/db";
import { accessTokens, user as userTable } from "@/db/schema";
import { env } from "./env";
import { hashSecret, PAT_PREFIX } from "./secrets";

export async function authenticateJobsRequest(
  authorization: string | null,
): Promise<{ ok: true; triggeredBy: string } | { ok: false; error: string }> {
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, error: "missing bearer token" };

  if (env.jobsApiToken) {
    const a = Buffer.from(token);
    const b = Buffer.from(env.jobsApiToken);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, triggeredBy: "api-token" };
  }

  if (token.startsWith(PAT_PREFIX)) {
    const pat = await db.query.accessTokens.findFirst({ where: eq(accessTokens.tokenHash, hashSecret(token)) });
    if (!pat) return { ok: false, error: "unknown access token" };
    if (pat.expiresAt && pat.expiresAt < new Date()) return { ok: false, error: "access token expired" };
    if (pat.scope !== "write") return { ok: false, error: "a read & write access token is required" };
    const u = await db.query.user.findFirst({ where: eq(userTable.id, pat.userId) });
    if (!u || u.banned || u.role !== "admin") return { ok: false, error: "token does not belong to an administrator" };
    db.update(accessTokens).set({ lastUsedAt: new Date() }).where(eq(accessTokens.id, pat.id)).catch(() => {});
    return { ok: true, triggeredBy: `user:${u.id}` };
  }
  return { ok: false, error: "invalid credential" };
}
