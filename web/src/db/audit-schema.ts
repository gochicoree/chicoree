// Audit log: who did what, when, from where. Written by the web app only
// (lib/audit.ts); registryd never touches this table.
import { bigserial, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const AUDIT_ACTOR_TYPES = ["user", "sa", "system", "api-token"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    actorType: text("actor_type", { enum: AUDIT_ACTOR_TYPES }).notNull(),
    actorId: text("actor_id"),
    /** Email or name at the time of the event; survives account deletion. */
    actorLabel: text("actor_label").notNull().default(""),
    /** Admin acting through impersonation, when applicable. */
    impersonatorId: text("impersonator_id"),
    /** Dotted action name, e.g. org.create, repo.visibility, auth.sign_in. */
    action: text("action").notNull(),
    /** Plain id (no foreign key) so history outlives the organization. */
    organizationId: text("organization_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetLabel: text("target_label"),
    /** Small, redacted context — never secrets. */
    details: jsonb("details").$type<Record<string, unknown>>(),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [
    index("audit_log_created_idx").on(t.createdAt),
    index("audit_log_org_created_idx").on(t.organizationId, t.createdAt),
    index("audit_log_actor_created_idx").on(t.actorId, t.createdAt),
  ],
);
