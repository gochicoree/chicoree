// Registry domain tables. registryd (Go) reads and writes these directly, so
// every table/column name here is part of a cross-service contract — keep in
// sync with registryd/internal/store/store.go.
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  foreignKey,
  integer,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

export const repositories = pgTable(
  "repositories",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    visibility: text("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("private"),
    pullCount: bigint("pull_count", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("repositories_org_name_uq").on(t.organizationId, t.name),
    index("repositories_org_idx").on(t.organizationId),
  ],
);

export const blobs = pgTable("blobs", {
  digest: text("digest").primaryKey(),
  size: bigint("size", { mode: "number" }).notNull(),
  mediaType: text("media_type"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const repositoryBlobs = pgTable(
  "repository_blobs",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    blobDigest: text("blob_digest")
      .notNull()
      .references(() => blobs.digest, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.blobDigest] }),
    index("repository_blobs_digest_idx").on(t.blobDigest),
  ],
);

export const manifests = pgTable(
  "manifests",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    digest: text("digest").notNull(),
    mediaType: text("media_type").notNull(),
    artifactType: text("artifact_type"),
    size: bigint("size", { mode: "number" }).notNull(),
    /** Exact manifest bytes as pushed; digests verify against this. */
    payload: text("payload").notNull(),
    configDigest: text("config_digest"),
    subjectDigest: text("subject_digest"),
    /** Cached image config JSON (history, platform, …), filled by the web app. */
    config: jsonb("config"),
    pushedBy: text("pushed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.digest] }),
    index("manifests_subject_idx").on(t.repositoryId, t.subjectDigest),
    index("manifests_digest_idx").on(t.digest),
  ],
);

export const manifestRefs = pgTable(
  "manifest_refs",
  {
    repositoryId: text("repository_id").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    /** Digest of a config blob, layer blob, or child manifest. */
    refDigest: text("ref_digest").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.manifestDigest, t.refDigest] }),
    foreignKey({
      columns: [t.repositoryId, t.manifestDigest],
      foreignColumns: [manifests.repositoryId, manifests.digest],
      name: "manifest_refs_manifest_fk",
    }).onDelete("cascade"),
    index("manifest_refs_ref_idx").on(t.repositoryId, t.refDigest),
  ],
);

export const tags = pgTable(
  "tags",
  {
    repositoryId: text("repository_id").notNull(),
    name: text("name").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.name] }),
    foreignKey({
      columns: [t.repositoryId, t.manifestDigest],
      foreignColumns: [manifests.repositoryId, manifests.digest],
      name: "tags_manifest_fk",
    }).onDelete("cascade"),
  ],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["push", "pull", "delete"] }).notNull(),
    actorType: text("actor_type", { enum: ["user", "sa", "anonymous"] }).notNull(),
    actorId: text("actor_id"),
    manifestDigest: text("manifest_digest"),
    tag: text("tag"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("events_repo_time_idx").on(t.repositoryId, t.createdAt),
    index("events_time_idx").on(t.createdAt),
  ],
);

export const vulnerabilityScans = pgTable("vulnerability_scans", {
  /** Manifest digest — scans are content-addressed, shared across repos. */
  digest: text("digest").primaryKey(),
  /** Repository the digest was last pushed to (used to build layer URLs). */
  repositoryId: text("repository_id"),
  status: text("status", {
    enum: ["pending", "indexing", "scanned", "failed"],
  })
    .notNull()
    .default("pending"),
  /** Per-severity finding counts, e.g. {"Critical": 1, "High": 4, …}. */
  summary: jsonb("summary"),
  /** Full Clair vulnerability report. */
  report: jsonb("report"),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** sha256 hex of the full secret; the secret itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    /** First characters of the secret, shown in the UI for recognition. */
    tokenPrefix: text("token_prefix").notNull(),
    permission: text("permission", { enum: ["pull", "push", "admin"] })
      .notNull()
      .default("pull"),
    /** Restrict to specific repository ids; null means every org repository. */
    repositoryIds: jsonb("repository_ids").$type<string[] | null>(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [unique("service_accounts_org_name_uq").on(t.organizationId, t.name)],
);

export const accessTokens = pgTable("access_tokens", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  scope: text("scope", { enum: ["read", "write"] })
    .notNull()
    .default("write"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

// --- Admin-enforced limits (null = unlimited) ---

/** Caps applied to everything a user owns (organizations where they are owner). */
export const userLimits = pgTable("user_limits", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  maxOrganizations: integer("max_organizations"),
  maxPublicRepos: integer("max_public_repos"),
  maxPrivateRepos: integer("max_private_repos"),
  maxStorageBytes: bigint("max_storage_bytes", { mode: "number" }),
  note: text("note").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

export const organizationLimits = pgTable("organization_limits", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  maxPublicRepos: integer("max_public_repos"),
  maxPrivateRepos: integer("max_private_repos"),
  maxStorageBytes: bigint("max_storage_bytes", { mode: "number" }),
  note: text("note").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

// --- Background jobs (garbage collection, scans, pruning) ---

export const jobRuns = pgTable(
  "job_runs",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    job: text("job").notNull(),
    status: text("status", { enum: ["running", "succeeded", "failed"] })
      .notNull()
      .default("running"),
    params: jsonb("params"),
    result: jsonb("result"),
    error: text("error"),
    /** "user:<id>", "api-token", or "schedule" */
    triggeredBy: text("triggered_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("job_runs_started_idx").on(t.startedAt)],
);

// --- Defaults for repositories created on push ---

export const organizationSettings = pgTable("organization_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** Visibility for repositories auto-created by pushes; null = use pusher's / private. */
  defaultVisibility: text("default_visibility", { enum: ["public", "private"] }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  defaultVisibility: text("default_visibility", { enum: ["public", "private"] }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Repository webhooks (outbound, on push) ---

export const repositoryWebhooks = pgTable(
  "repository_webhooks",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method", { enum: ["POST", "PUT", "PATCH"] }).notNull().default("POST"),
    /** Extra request headers. */
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    authType: text("auth_type", { enum: ["none", "bearer", "basic", "header"] })
      .notNull()
      .default("none"),
    /** Header name when authType = header. */
    authHeaderName: text("auth_header_name"),
    /** Encrypted secret: bearer token, "user:password", or header value. */
    authSecret: text("auth_secret"),
    /** Encrypted HMAC key for X-Chicoree-Signature; null = unsigned. */
    signingSecret: text("signing_secret"),
    events: jsonb("events").$type<string[]>().notNull().default(["push"]),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastStatus: integer("last_status"),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [index("repository_webhooks_repo_idx").on(t.repositoryId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => repositoryWebhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload"),
    statusCode: integer("status_code"),
    ok: boolean("ok").notNull().default(false),
    attempts: integer("attempts").notNull().default(1),
    durationMs: integer("duration_ms"),
    error: text("error"),
    responseSnippet: text("response_snippet"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_deliveries_hook_idx").on(t.webhookId, t.createdAt)],
);

// --- Mirrors: import tags from another registry ---

export interface TagSelector {
  mode: "all" | "glob" | "regex" | "list";
  /** Glob or regex pattern, or comma/space separated list. */
  pattern: string;
  /** Optional glob/regex to exclude. */
  exclude?: string;
}

export interface Relabel {
  /** Template for the destination tag: {tag}, {source}, {major}, {minor}, {patch}. */
  tagTemplate: string;
  /** Optional regex applied to the source tag before templating. */
  replaceFrom?: string;
  replaceTo?: string;
}

export const mirrors = pgTable(
  "mirrors",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** e.g. docker.io/library/nginx, ghcr.io/org/app, registry.example.com/team/app */
    source: text("source").notNull(),
    /** Encrypted "user:password" for the source registry, or null for anonymous. */
    sourceAuth: text("source_auth"),
    selector: jsonb("selector").$type<TagSelector>().notNull(),
    relabel: jsonb("relabel").$type<Relabel>().notNull(),
    /** Re-import a tag whose upstream digest changed (mutable tags like :latest). */
    overwrite: boolean("overwrite").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
  },
  (t) => [index("mirrors_repo_idx").on(t.repositoryId)],
);

export const mirrorRuns = pgTable(
  "mirror_runs",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    mirrorId: text("mirror_id")
      .notNull()
      .references(() => mirrors.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull().default("running"),
    matched: integer("matched").notNull().default(0),
    imported: integer("imported").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    /** Per-tag outcomes: [{ sourceTag, targetTag, digest, status, error }] */
    log: jsonb("log").$type<MirrorLogEntry[]>().notNull().default([]),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("mirror_runs_mirror_idx").on(t.mirrorId, t.startedAt)],
);

export interface MirrorLogEntry {
  sourceTag: string;
  targetTag: string;
  digest?: string;
  status: "imported" | "skipped" | "failed";
  detail?: string;
}
