// Tables the REST API owns (registryd never reads them): trusted CI
// identities for keyless authentication, and the per-endpoint request
// counters behind the api_requests metrics.
import { sql } from "drizzle-orm";
import { bigint, index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

/**
 * An OIDC identity an organization trusts for keyless CI authentication:
 * a workflow whose token (GitHub Actions, GitLab, any OIDC issuer) carries
 * this issuer and a subject matching the pattern may exchange it for a
 * short-lived registry credential with the given permission, limited to
 * the listed repositories when set (null = every repository).
 */
export const ciIdentitiesTrusted = pgTable(
  "ci_identities_trusted",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Issuer URL exactly as the token carries it, e.g. https://token.actions.githubusercontent.com */
    issuer: text("issuer").notNull(),
    /** Subject pattern: exact value or glob with `*`, e.g. repo:acme/app:ref:refs/heads/main */
    subject: text("subject").notNull(),
    permission: text("permission", { enum: ["pull", "push", "admin"] }).notNull().default("push"),
    /** Restrict to specific repository ids; null means every organization repository. */
    repositoryIds: jsonb("repository_ids").$type<string[] | null>(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** The concrete subject that last exchanged a token through this identity. */
    lastSubject: text("last_subject"),
  },
  (t) => [index("ci_identities_trusted_org_idx").on(t.organizationId), index("ci_identities_trusted_issuer_idx").on(t.issuer)],
);

/**
 * Request counts per endpoint, method, status and credential kind, flushed
 * from an in-process buffer every few seconds (lib/api/stats.ts) and read
 * by the Prometheus endpoint, so the numbers survive restarts and add up
 * across replicas.
 */
export const apiRequestStats = pgTable(
  "api_request_stats",
  {
    /** Catalog path template, e.g. /repos/{org}/{repo}/tags */
    endpoint: text("endpoint").notNull(),
    method: text("method").notNull(),
    status: integer("status").notNull(),
    /** token | service-account | ci | session | none */
    credential: text("credential").notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.endpoint, t.method, t.status, t.credential] })],
);
