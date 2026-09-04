// First-run guidance: the user checklist on the dashboard and the
// administrator setup checklist on /admin. Both derive their state from the
// database on every render and can be dismissed per user (user_settings).
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { LIBRARY_SLUG } from "./library";

export interface OnboardingState {
  /** The organization used in the sample commands (a non-library one when there is a choice). */
  orgSlug: string | null;
  hasOrg: boolean;
  hasToken: boolean;
  hasPush: boolean;
  dismissed: boolean;
  /** Every step done: the card hides itself. */
  complete: boolean;
}

export async function userOnboarding(userId: string): Promise<OnboardingState> {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT o.slug FROM member m JOIN organization o ON o.id = m.organization_id
        WHERE m.user_id = ${userId} ORDER BY (o.slug = ${LIBRARY_SLUG}) ASC, m.created_at ASC LIMIT 1) AS org_slug,
      EXISTS (SELECT 1 FROM access_tokens t WHERE t.user_id = ${userId}) AS has_token,
      (EXISTS (SELECT 1 FROM events e WHERE e.type = 'push' AND e.actor_type = 'user' AND e.actor_id = ${userId})
        OR EXISTS (SELECT 1 FROM manifests mf WHERE mf.pushed_by = ${`user:${userId}`})) AS has_push,
      (SELECT onboarding_dismissed_at FROM user_settings WHERE user_id = ${userId}) AS dismissed_at`);
  const r = rows[0] ?? {};
  const orgSlug = (r.org_slug as string | null) ?? null;
  const hasOrg = orgSlug !== null;
  const hasToken = Boolean(r.has_token);
  const hasPush = Boolean(r.has_push);
  return { orgSlug, hasOrg, hasToken, hasPush, dismissed: !!r.dismissed_at, complete: hasOrg && hasToken && hasPush };
}
