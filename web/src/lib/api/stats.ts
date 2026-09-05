// Request counters for the metrics endpoint: buffered in memory per
// process and flushed to api_request_stats every ten seconds (or sooner
// when the buffer grows), so the numbers survive restarts and add up
// across replicas at the cost of one upsert per distinct label set.
import { sql } from "drizzle-orm";
import { db } from "@/db";

const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_AT = 500;

const buffer = new Map<string, { endpoint: string; method: string; status: number; credential: string; count: number }>();
let lastFlush = Date.now();
let flushing = false;

export function recordApiRequest(sample: { endpoint: string; method: string; status: number; credential: string }): void {
  const key = `${sample.method} ${sample.endpoint} ${sample.status} ${sample.credential}`;
  const entry = buffer.get(key);
  if (entry) entry.count++;
  else buffer.set(key, { ...sample, count: 1 });
  if (buffer.size >= FLUSH_AT || Date.now() - lastFlush > FLUSH_INTERVAL_MS) void flushApiStats();
}

/** Write the buffer out; safe to call any time (a flush in progress is not doubled). */
export async function flushApiStats(): Promise<void> {
  if (flushing || buffer.size === 0) return;
  flushing = true;
  lastFlush = Date.now();
  const rows = [...buffer.values()];
  buffer.clear();
  try {
    await db.execute(sql`
      INSERT INTO api_request_stats (endpoint, method, status, credential, count, updated_at)
      VALUES ${sql.join(
        rows.map((r) => sql`(${r.endpoint}, ${r.method}, ${r.status}, ${r.credential}, ${r.count}, now())`),
        sql`, `,
      )}
      ON CONFLICT (endpoint, method, status, credential) DO UPDATE
        SET count = api_request_stats.count + EXCLUDED.count, updated_at = now()`);
  } catch (err) {
    console.error("[api] request stats flush failed:", err);
    // Put the samples back so the next flush retries them.
    for (const r of rows) {
      const key = `${r.method} ${r.endpoint} ${r.status} ${r.credential}`;
      const entry = buffer.get(key);
      if (entry) entry.count += r.count;
      else buffer.set(key, r);
    }
  } finally {
    flushing = false;
  }
}
