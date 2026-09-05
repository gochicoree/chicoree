// Per-organization traffic for one calendar month (UTC), summed from
// repository_traffic, which registryd writes per repository and day. The
// usage endpoints of the REST API and the usage cards read it; the admin
// statistics (lib/admin-stats.ts) have their own instance-wide series.
import { sql } from "drizzle-orm";
import { db } from "@/db";

export interface MonthlyTraffic {
  /** YYYY-MM */
  month: string;
  /** First day of the month (inclusive) and of the next one (exclusive), YYYY-MM-DD. */
  from: string;
  to: string;
  /** Bytes registryd served itself (blob + manifest GETs). */
  pullBytes: number;
  /** Blob sizes of GETs answered with a redirect to the storage backend / CDN. */
  redirectBytes: number;
  /** Bytes received for committed uploads and manifest PUTs. */
  pushBytes: number;
  blobPulls: number;
  manifestPulls: number;
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The current month in UTC, YYYY-MM. */
export function currentMonthUtc(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `?month=YYYY-MM`; absent → the current month; anything else → an error message. */
export function parseMonth(raw: string | null | undefined): { month: string; error?: undefined } | { month?: undefined; error: string } {
  if (raw === null || raw === undefined || raw.trim() === "") return { month: currentMonthUtc() };
  const v = raw.trim();
  if (!MONTH_RE.test(v)) return { error: '"month" must look like YYYY-MM.' };
  return { month: v };
}

function range(month: string): { from: string; to: string } {
  const [, y, m] = MONTH_RE.exec(month)!;
  const year = Number(y);
  const mon = Number(m);
  const next = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

async function sumTraffic(month: string, where: ReturnType<typeof sql>): Promise<MonthlyTraffic> {
  const { from, to } = range(month);
  const { rows } = await db.execute(sql`
    SELECT
      COALESCE(sum(t.pull_bytes), 0)::bigint AS pull_bytes,
      COALESCE(sum(t.redirect_bytes), 0)::bigint AS redirect_bytes,
      COALESCE(sum(t.push_bytes), 0)::bigint AS push_bytes,
      COALESCE(sum(t.blob_pulls), 0)::bigint AS blob_pulls,
      COALESCE(sum(t.manifest_pulls), 0)::bigint AS manifest_pulls
    FROM repository_traffic t
    JOIN repositories r ON r.id = t.repository_id
    WHERE ${where} AND t.day >= ${from}::date AND t.day < ${to}::date`);
  const r = rows[0] ?? {};
  return {
    month,
    from,
    to,
    pullBytes: Number(r.pull_bytes ?? 0),
    redirectBytes: Number(r.redirect_bytes ?? 0),
    pushBytes: Number(r.push_bytes ?? 0),
    blobPulls: Number(r.blob_pulls ?? 0),
    manifestPulls: Number(r.manifest_pulls ?? 0),
  };
}

/** One organization's traffic in the month. */
export function orgTraffic(organizationId: string, month = currentMonthUtc()): Promise<MonthlyTraffic> {
  return sumTraffic(month, sql`r.organization_id = ${organizationId}`);
}

/** Traffic of every organization the user owns, in the month. */
export function ownedOrgsTraffic(userId: string, month = currentMonthUtc()): Promise<MonthlyTraffic> {
  return sumTraffic(month, sql`r.organization_id IN (SELECT organization_id FROM member WHERE user_id = ${userId} AND role = 'owner')`);
}
