// Brute-force protection for docker login (/api/registry/token). Failed
// attempts are counted per client address and per account in Postgres, so
// every web replica sees the same budget. Five wrong passwords for one
// account, or thirty failures from one address, within fifteen minutes lock
// that key for fifteen minutes; a successful sign-in clears the account's
// counter. Access-token and service-account failures count against the
// address only — those secrets are not guessable, but a scanner trying
// them still gets slowed down. better-auth rate-limits its own sign-in
// routes; this covers the registry path it does not see.
import { sql } from "drizzle-orm";
import { db } from "@/db";

export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_LOCK_MINUTES = 15;
export const ACCOUNT_MAX_FAILURES = 5;
export const IP_MAX_FAILURES = 30;

export function accountKey(email: string): string {
  return `account:${email.trim().toLowerCase()}`;
}

export function ipKey(ip: string | null): string | null {
  return ip ? `ip:${ip}` : null;
}

/** The lock that applies to any of these keys, if one is active. */
export async function loginLock(keys: (string | null)[]): Promise<{ lockedUntil: Date; retryAfterSeconds: number } | null> {
  const list = keys.filter((k): k is string => !!k);
  if (list.length === 0) return null;
  const { rows } = await db.execute(sql`
    SELECT locked_until FROM login_attempts
    WHERE key IN (${sql.join(
      list.map((k) => sql`${k}`),
      sql`, `,
    )}) AND locked_until > now()
    ORDER BY locked_until DESC LIMIT 1`);
  const until = rows[0]?.locked_until;
  if (!until) return null;
  const lockedUntil = new Date(until as string);
  return { lockedUntil, retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 1000)) };
}

/**
 * Count one failure against each key and lock the ones that crossed their
 * limit. Returns the lock that now applies, if any.
 */
export async function recordLoginFailure(entries: { key: string | null; max: number }[]): Promise<{ lockedUntil: Date } | null> {
  let locked: Date | null = null;
  for (const e of entries) {
    if (!e.key) continue;
    const { rows } = await db.execute(sql`
      INSERT INTO login_attempts (key, failures, window_start, locked_until, updated_at)
      VALUES (${e.key}, 1, now(), NULL, now())
      ON CONFLICT (key) DO UPDATE SET
        failures = CASE WHEN login_attempts.window_start < now() - interval '${sql.raw(`${LOGIN_WINDOW_MINUTES} minutes`)}'
                        THEN 1 ELSE login_attempts.failures + 1 END,
        window_start = CASE WHEN login_attempts.window_start < now() - interval '${sql.raw(`${LOGIN_WINDOW_MINUTES} minutes`)}'
                            THEN now() ELSE login_attempts.window_start END,
        updated_at = now()
      RETURNING failures`);
    const failures = Number(rows[0]?.failures ?? 0);
    if (failures >= e.max) {
      const { rows: lockRows } = await db.execute(sql`
        UPDATE login_attempts
        SET locked_until = now() + interval '${sql.raw(`${LOGIN_LOCK_MINUTES} minutes`)}', failures = 0, window_start = now()
        WHERE key = ${e.key}
        RETURNING locked_until`);
      const until = lockRows[0]?.locked_until;
      if (until) {
        const d = new Date(until as string);
        if (!locked || d > locked) locked = d;
      }
    }
  }
  // Rows nobody touched for a day carry no information anymore.
  if (Math.random() < 0.05) {
    await db.execute(sql`DELETE FROM login_attempts WHERE updated_at < now() - interval '1 day'`).catch(() => {});
  }
  return locked ? { lockedUntil: locked } : null;
}

export async function clearLoginFailures(key: string | null): Promise<void> {
  if (!key) return;
  await db.execute(sql`DELETE FROM login_attempts WHERE key = ${key}`).catch(() => {});
}

export function lockMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `too many failed sign-in attempts; try again in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
