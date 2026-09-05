// "The API changed since you last looked": administrators acknowledge the
// current revision on the overview; until they do, a card lists what
// changed. The acknowledged revision lives in instance_settings under a key
// of its own (not a settings section).
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { API_CHANGELOG, API_REVISION, type ApiChange } from "./version";

const KEY = "api_revision";

export interface RevisionNotice {
  current: string;
  acknowledged: string | null;
  /** Entries newer than the acknowledged revision (every entry when none was acknowledged). */
  unseen: ApiChange[];
}

export async function apiRevisionNotice(): Promise<RevisionNotice> {
  const { rows } = await db.execute(sql`SELECT value->>'revision' AS revision FROM instance_settings WHERE key = ${KEY}`);
  const acknowledged = (rows[0]?.revision as string | null) ?? null;
  const idx = acknowledged ? API_CHANGELOG.findIndex((c) => c.revision === acknowledged) : -1;
  const unseen = acknowledged === API_REVISION ? [] : idx < 0 ? API_CHANGELOG : API_CHANGELOG.slice(0, idx);
  return { current: API_REVISION, acknowledged, unseen };
}

export async function acknowledgeApiRevision(revision: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO instance_settings (key, value, updated_at) VALUES (${KEY}, ${JSON.stringify({ revision })}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
}
