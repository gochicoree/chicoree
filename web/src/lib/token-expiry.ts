// The token-expiry job: warn once about every credential that expires
// within the window. "Once" is tracked in notification_state under
// token.expiring:<kind>:<id> — a rotated personal access token is a new row
// and gets its own reminder; a rotated service account keeps its id, so its
// state row is cleared when its expiry moves out of the window.
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { expiringCredentials } from "./credential-auth";
import { notify } from "./notify";

export async function runTokenExpiryReminders(withinDays: number): Promise<Record<string, unknown>> {
  const now = new Date();
  const { pats, sas } = await expiringCredentials(withinDays, now);
  let sent = 0;
  let skipped = 0;
  const claim = async (key: string) => {
    const { rows } = await db.execute(sql`
      INSERT INTO notification_state (key, sent_at) VALUES (${key}, now())
      ON CONFLICT (key) DO NOTHING
      RETURNING key`);
    return rows.length > 0;
  };
  for (const t of pats) {
    if (!(await claim(`token.expiring:pat:${t.id}`))) {
      skipped++;
      continue;
    }
    await notify({ event: "token.expiring", kind: "pat", id: t.id, name: t.name, expiresAt: t.expiresAt!, userId: t.userId, organizationId: null }).catch(
      (err) => console.error("token.expiring notification failed:", err),
    );
    sent++;
  }
  for (const sa of sas) {
    if (!(await claim(`token.expiring:sa:${sa.id}`))) {
      skipped++;
      continue;
    }
    await notify({ event: "token.expiring", kind: "sa", id: sa.id, name: sa.name, expiresAt: sa.expiresAt!, userId: null, organizationId: sa.organizationId }).catch(
      (err) => console.error("token.expiring notification failed:", err),
    );
    sent++;
  }
  // Service accounts keep their id across rotations: forget reminders for
  // those whose expiry is no longer inside the window so the next one fires.
  await db.execute(sql`
    DELETE FROM notification_state ns
    WHERE ns.key LIKE 'token.expiring:sa:%'
      AND EXISTS (
        SELECT 1 FROM service_accounts sa
        WHERE ns.key = 'token.expiring:sa:' || sa.id
          AND (sa.expires_at IS NULL OR sa.expires_at > ${new Date(now.getTime() + withinDays * 86_400_000)})
      )`);
  return { withinDays, expiring: pats.length + sas.length, sent, alreadySent: skipped };
}
