// Request limits for the REST API: fixed windows counted in Postgres (the
// rate_limit_counters table registryd uses for pulls, under an "api|"
// prefix), so every web replica enforces the same budget. Instance
// administrators are never limited.
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getInstanceSettings } from "@/lib/instance-settings";
import { parseRateLimit, type RateLimit } from "@/lib/rate-limit-shared";
import type { ApiCaller } from "./auth";
import { ApiError } from "./respond";

export interface RateLimitState {
  limit: RateLimit;
  /** Requests counted in the current window, this one included. */
  count: number;
  /** When the window ends (epoch seconds). */
  resetAt: number;
}

function keyFor(c: ApiCaller, ip: string | null): string {
  if (c.kind === "user") return `api|user:${c.user.id}`;
  if (c.kind === "sa") return `api|sa:${c.sa.id}`;
  return `api|ip:${ip ?? "unknown"}`;
}

let lastPrune = 0;

/** Once an hour, drop API counters whose window ended more than a day ago. */
function pruneOpportunistically(): void {
  const now = Date.now();
  if (now - lastPrune < 3_600_000) return;
  lastPrune = now;
  db.execute(sql`DELETE FROM rate_limit_counters WHERE key LIKE 'api|%' AND window_start < now() - interval '1 day'`).catch((err) =>
    console.error("[api] rate limit prune failed:", err),
  );
}

/**
 * Count this request and return the window state, or null when no limit
 * applies. Throws 429 (with Retry-After) when the window is exhausted.
 */
export async function checkApiRateLimit(c: ApiCaller, ip: string | null): Promise<RateLimitState | null> {
  if (c.kind === "user" && c.caller.isAdmin) return null;
  const { ratelimit } = await getInstanceSettings();
  const { limit } = parseRateLimit(c.kind === "anonymous" ? ratelimit.apiAnonymous : ratelimit.apiAuthenticated);
  if (!limit) return null;
  const windowStart = Math.floor(Date.now() / 1000 / limit.windowSeconds) * limit.windowSeconds;
  const resetAt = windowStart + limit.windowSeconds;
  const key = keyFor(c, ip);
  const { rows } = await db.execute(sql`
    INSERT INTO rate_limit_counters (key, window_start, count) VALUES (${key}, to_timestamp(${windowStart}), 1)
    ON CONFLICT (key) DO UPDATE SET
      count = CASE WHEN rate_limit_counters.window_start = EXCLUDED.window_start THEN rate_limit_counters.count + 1 ELSE 1 END,
      window_start = EXCLUDED.window_start
    RETURNING count`);
  const count = Number(rows[0]?.count ?? 1);
  pruneOpportunistically();
  const state = { limit, count, resetAt };
  if (count > limit.count) {
    const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));
    throw new ApiError("rate_limited", `Too many requests: at most ${limit.count} per ${limit.windowSeconds} s for this ${c.kind === "anonymous" ? "address" : "credential"}. Try again in ${retryAfter} s.`, {
      retryAfter,
      limit: limit.count,
      windowSeconds: limit.windowSeconds,
      resetAt,
    });
  }
  return state;
}

/** Headers for a refused request, from the error's details. */
export function exhaustedHeaders(err: ApiError): Record<string, string> {
  if (err.code !== "rate_limited" || !err.details) return {};
  return {
    "X-RateLimit-Limit": String(err.details.limit ?? ""),
    "X-RateLimit-Remaining": "0",
    "X-RateLimit-Reset": String(err.details.resetAt ?? ""),
  };
}

export function rateLimitHeaders(state: RateLimitState | null): Record<string, string> {
  if (!state) return {};
  return {
    "X-RateLimit-Limit": String(state.limit.count),
    "X-RateLimit-Remaining": String(Math.max(0, state.limit.count - state.count)),
    "X-RateLimit-Reset": String(state.resetAt),
  };
}
