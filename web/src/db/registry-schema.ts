// Registry domain tables. registryd (Go) reads and writes these directly, so
// every table/column name here is part of a cross-service contract — keep in
// sync with registryd/internal/store/store.go.
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  foreignKey,
  index,
  integer,
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
    /** Pull policy override: null = inherit the organization's, "off" = never block. */
    blockPullsAt: text("block_pulls_at", { enum: ["off", "critical", "high", "medium", "low"] }),
    /** Override for counting unrated findings; null = inherit. */
    blockUnrated: boolean("block_unrated"),
    /** Markdown shown on the repository page (Settings → General), at most README_MAX_BYTES. */
    readme: text("readme"),
    /**
     * Repository picture as a data: URL (PNG/SVG/JPEG/WebP, at most
     * LOGO_MAX_BYTES). Served by /api/logo/repository/<id>, never inlined into
     * a listing. registryd does not read it.
     */
    logo: text("logo"),
    /** Signature policy override: null = inherit the organization's; true/false = require a verified cosign signature or not. */
    requireSignature: boolean("require_signature"),
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

/**
 * Manifests whose pulls the registry must refuse, derived by the web app
 * from scan results and the pull policy (registryd only reads this table).
 */
export const manifestBlocks = pgTable(
  "manifest_blocks",
  {
    repositoryId: text("repository_id").notNull(),
    digest: text("digest").notNull(),
    /** Human-readable cause, returned to docker clients. */
    reason: text("reason").notNull(),
    /**
     * Signature-policy blocks only: callers whose token grants push on the
     * repository may still read the manifest (they are the ones who sign
     * it — cosign has to fetch the image before it can attach a signature).
     * Vulnerability blocks never set this.
     */
    pushersExempt: boolean("pushers_exempt").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.repositoryId, t.digest] }),
    foreignKey({
      columns: [t.repositoryId, t.digest],
      foreignColumns: [manifests.repositoryId, manifests.digest],
      name: "manifest_blocks_manifest_fk",
    }).onDelete("cascade"),
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
    /** Proxy caches: when the upstream last confirmed this tag → digest mapping. */
    proxyCheckedAt: timestamp("proxy_checked_at", { withTimezone: true }),
    /** Proxy caches: last pull of this tag (the proxy-evict job uses it). */
    lastPulledAt: timestamp("last_pulled_at", { withTimezone: true }),
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
    actorType: text("actor_type", { enum: ["user", "sa", "anonymous", "mirror", "proxy"] }).notNull(),
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
  /** Per-severity finding counts computed from `findings`, e.g. {"Critical": 1, "High": 4, …}. */
  summary: jsonb("summary"),
  /** The scanner's raw report (Clair vulnerability report or Trivy JSON), kept for reference. */
  report: jsonb("report"),
  /** Normalised findings (lib/scanner-shared.ts `Finding[]`); the UI reads only these. */
  findings: jsonb("findings"),
  /** Which backend produced the result: clair | trivy. */
  scanner: text("scanner"),
  scannerVersion: text("scanner_version"),
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
    /** Client address seen at the last use (token endpoint); updated with last_used_at. */
    lastUsedIp: text("last_used_ip"),
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
  /** Client address seen at the last use; updated together with last_used_at (throttled to once per 5 minutes). */
  lastUsedIp: text("last_used_ip"),
  description: text("description").notNull().default(""),
  /** Restrict the token to one organization (null = every organization the user belongs to). */
  organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
  /** Within that organization, restrict to these repository ids (null = every repository). */
  repositoryIds: jsonb("repository_ids").$type<string[] | null>(),
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
  /** Shown to the account owner next to their usage (a plan name, say); empty = nothing shown. */
  label: text("label").notNull().default(""),
  /** Operator note, visible to administrators only. */
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
  /**
   * How many members (any role) the organization may have; pending
   * invitations count while they are open. Enforced by the web app only
   * (registryd never adds members). null = unlimited.
   */
  maxMembers: integer("max_members"),
  /** Shown to owners and admins next to the organization's usage; empty = nothing shown. */
  label: text("label").notNull().default(""),
  /** Operator note, visible to administrators only. */
  note: text("note").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

/**
 * Organizations and accounts found above their storage limit by the
 * `quota-enforce` job: when it first saw them over, what it told the owners,
 * and when it pruned. Rows go when the target fits again.
 */
export const quotaBreaches = pgTable(
  "quota_breaches",
  {
    targetType: text("target_type").$type<"organization" | "user">().notNull(),
    targetId: text("target_id").notNull(),
    firstOverAt: timestamp("first_over_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    usedBytes: bigint("used_bytes", { mode: "number" }).notNull(),
    limitBytes: bigint("limit_bytes", { mode: "number" }).notNull(),
    /** First notice sent (the grace period started). */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /** Reminder sent shortly before pruning. */
    finalNoticeAt: timestamp("final_notice_at", { withTimezone: true }),
    /** Last time images were removed to fit. */
    prunedAt: timestamp("pruned_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.targetType, t.targetId] })],
);

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
  /** Pull policy: block pulls of images with findings at this severity or worse; null = off. */
  blockPullsAt: text("block_pulls_at", { enum: ["critical", "high", "medium", "low"] }),
  /** Whether findings without a severity rating count against the threshold. */
  blockUnrated: boolean("block_unrated").notNull().default(false),
  /** Signature policy: pulls of images without a cosign signature from a trusted key are refused. */
  requireSignature: boolean("require_signature").notNull().default(false),
  /** Whether the personal signing keys of members who may push count as trusted in the organization's repositories. */
  trustMemberKeys: boolean("trust_member_keys").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Instance-wide configuration edited in the admin panel (SMTP, sign-in
 * providers, LDAP, group bindings). One row per section; secrets inside the
 * JSON are encrypted with lib/crypto. Environment variables act as defaults
 * for sections without a row.
 */
export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userSettings = pgTable("user_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  defaultVisibility: text("default_visibility", { enum: ["public", "private"] }),
  /** Show signatures, SBOMs and attestation entries in lists; null = the instance default (Administration → Branding). */
  showArtifacts: boolean("show_artifacts"),
  /** The dashboard onboarding checklist was closed by the user. */
  onboardingDismissedAt: timestamp("onboarding_dismissed_at", { withTimezone: true }),
  /** The /admin setup checklist was closed by this administrator. */
  adminChecklistDismissedAt: timestamp("admin_checklist_dismissed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Outbound webhooks (repository- or organization-scoped) ---

/**
 * One table for both scopes: a row with repository_id belongs to that
 * repository; a row with organization_id and NULL repository_id applies to
 * every repository of the organization. Deliveries, retries, the log and
 * test sends are shared (lib/webhooks.ts).
 */
export const repositoryWebhooks = pgTable(
  "repository_webhooks",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    /** Set (with repository_id NULL) for organization-wide hooks. */
    organizationId: text("organization_id").references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    method: text("method", { enum: ["GET", "POST", "PUT", "PATCH"] }).notNull().default("POST"),
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
    /**
     * Body format: "json" is the documented payload; the chat formats render
     * the same event as a message for a Slack, Discord or Microsoft Teams
     * incoming webhook, or as a plain {text} document (Mattermost, Google
     * Chat, Rocket.Chat). See lib/webhook-chat.ts.
     */
    format: text("format", { enum: ["json", "none", "slack", "discord", "teams", "text"] }).notNull().default("json"),
    events: jsonb("events").$type<string[]>().notNull().default(["push"]),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastStatus: integer("last_status"),
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [
    index("repository_webhooks_repo_idx").on(t.repositoryId),
    index("repository_webhooks_org_idx").on(t.organizationId),
  ],
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
  /** Point "latest" at the newest imported image when the source has no latest tag (default true). */
  latest?: boolean;
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

// --- Proxy caches: an organization that mirrors an upstream registry on demand ---

/**
 * One row turns the organization into a pull-through cache of `upstreamUrl`.
 * registryd reads the configuration through GET /api/internal/proxies (the
 * credentials are encrypted with the web app's key) and writes
 * last_checked_at / last_error; tags.proxy_checked_at and tags.last_pulled_at
 * carry the per-tag state.
 */
export const organizationProxies = pgTable("organization_proxies", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** Distribution API root, e.g. https://registry-1.docker.io or https://ghcr.io */
  upstreamUrl: text("upstream_url").notNull(),
  preset: text("preset", { enum: ["dockerhub", "ghcr", "quay", "custom"] }).notNull().default("custom"),
  /** Encrypted "user:password" (or a bare token) for the upstream; null = anonymous. */
  auth: text("auth"),
  /** Space-separated globs on the upstream path (library/* bitnami/*); empty = everything. */
  allowedPatterns: text("allowed_patterns").notNull().default(""),
  /** How long a cached tag → digest mapping is trusted before re-checking upstream. */
  tagTtlSeconds: integer("tag_ttl_seconds").notNull().default(300),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Outcome of the latest upstream contact, maintained by registryd. */
  lastError: text("last_error"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
});
// --- Traffic accounting (written by registryd, read by the web app) ---

/**
 * Egress/ingress per repository and UTC day. registryd aggregates in memory
 * and upserts every few seconds (registryd/internal/traffic); the web app
 * only reads. pull_bytes are bytes registryd itself served (blob + manifest
 * GETs, partial responses count what was sent); redirect_bytes are blob
 * sizes of GETs answered with a redirect to the storage backend (the bytes
 * then leave S3/CDN, not the registry); push_bytes are bytes received for
 * committed uploads and manifest PUTs.
 */
export const repositoryTraffic = pgTable(
  "repository_traffic",
  {
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    day: date("day").notNull(),
    pullBytes: bigint("pull_bytes", { mode: "number" }).notNull().default(0),
    pushBytes: bigint("push_bytes", { mode: "number" }).notNull().default(0),
    redirectBytes: bigint("redirect_bytes", { mode: "number" }).notNull().default(0),
    blobPulls: bigint("blob_pulls", { mode: "number" }).notNull().default(0),
    manifestPulls: bigint("manifest_pulls", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.repositoryId, t.day] }), index("repository_traffic_day_idx").on(t.day)],
);
// --- Automation: job schedules, notifications ---

/** In-app cron schedule per maintenance job (one row per job name). */
export const jobSchedules = pgTable("job_schedules", {
  job: text("job").primaryKey(),
  /** Standard 5-field cron expression. */
  cron: text("cron").notNull(),
  /** Job parameters, same keys as the manual run form. */
  params: jsonb("params").$type<Record<string, string>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(false),
  /** IANA zone the cron expression is evaluated in. */
  timezone: text("timezone").notNull().default("UTC"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  /** Outcome of the last scheduled run: succeeded | failed | skipped. */
  lastStatus: text("last_status"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-user email preference per notification event. Rows exist only for
 * events the user changed; lib/notify-shared.ts holds the defaults.
 */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    email: boolean("email").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.event] })],
);

/** Dedup memory for notifications that must not repeat (quota thresholds, once per 24 h). */
export const notificationState = pgTable("notification_state", {
  /** e.g. "quota.warning:<organization id>:storage:80" */
  key: text("key").primaryKey(),
  sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
});
// --- Tag lifecycle: protected / immutable tags and retention policies ---

/**
 * Tag rules: glob patterns (`*` and `?` only) over tag names, per
 * organization or per repository (repository_id NULL = every repository).
 * `immutable` stops an existing tag from being re-pointed at a different
 * digest (re-pushing the same digest is fine); `protected` stops the tag —
 * and, by digest, the manifest it names — from being deleted. registryd
 * enforces both on manifest PUT/DELETE (internal/store/tagrules.go); the web
 * app mirrors the checks and shows lock badges (lib/tag-rules-shared.ts).
 */
export const tagRules = pgTable(
  "tag_rules",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** null = every repository of the organization. */
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    immutable: boolean("immutable").notNull().default(false),
    protected: boolean("protected").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tag_rules_org_idx").on(t.organizationId), index("tag_rules_repo_idx").on(t.repositoryId)],
);

/**
 * Retention policies: one row per organization (repository_id NULL = the
 * default for its repositories) and optionally one per repository, which
 * replaces the organization's entirely. Applied by the `retention` job and
 * previewed from the settings pages (lib/retention-shared.ts is the planner).
 */
export const retentionPolicies = pgTable(
  "retention_policies",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** null = the organization default; a repository row overrides it entirely. */
    repositoryId: text("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    /** Keep the N most recently pushed tags. */
    keepLast: integer("keep_last"),
    /** Space-separated globs of tags that are always kept, e.g. "latest v*". */
    keepMatching: text("keep_matching"),
    /** Tags last pushed more than N days ago are deletion candidates. */
    deleteOlderThanDays: integer("delete_older_than_days"),
    /** Manifests without a tag, pushed more than N days ago, are deleted (index children and referrers excepted). */
    deleteUntaggedAfterDays: integer("delete_untagged_after_days"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("retention_policies_scope_uq").on(t.organizationId, t.repositoryId).nullsNotDistinct()],
);

// --- Discovery: stars and recently viewed repositories (web app only) ---

/** A user starred a repository; the count shows in listings, the list on the dashboard. */
export const repositoryStars = pgTable(
  "repository_stars",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repositoryId] }), index("repository_stars_repo_idx").on(t.repositoryId)],
);

/** Repository page views per user, upserted at most once a minute; feeds "Recently viewed". */
export const repositoryVisits = pgTable(
  "repository_visits",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    lastVisitedAt: timestamp("last_visited_at", { withTimezone: true }).notNull().defaultNow(),
    visits: integer("visits").notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.userId, t.repositoryId] }), index("repository_visits_user_idx").on(t.userId, t.lastVisitedAt)],
);

// --- Shared upload staging (STORAGE_STAGING=shared) ---

/**
 * In-flight blob uploads when registryd runs with STORAGE_STAGING=shared.
 * The row is the source of truth for the byte offset and the ordered chunk
 * objects (`_uploads/<id>/<seq>-<nonce>` in the storage backend), so any
 * replica can continue, inspect, cancel or commit an upload. Written by
 * registryd only (internal/store/uploads.go); rows disappear on commit,
 * cancel or the GC sweep (expired sessions and orphaned chunks).
 */
export const uploadSessions = pgTable(
  "upload_sessions",
  {
    /** The Docker-Upload-UUID handed to the client. */
    id: text("id").primaryKey(),
    /** Resolved organization slug and repository name; every request on the session must match. */
    organization: text("organization").notNull(),
    repository: text("repository").notNull(),
    /** Bytes staged so far; appends are an optimistic `UPDATE … WHERE offset = <seen>`. */
    offset: bigint("offset", { mode: "number" }).notNull().default(0),
    /** Ordered chunk objects: [{ seq, size, key }]. */
    chunks: jsonb("chunks")
      .$type<{ seq: number; size: number; key: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Hostname of the replica that opened the session (diagnostics only). */
    node: text("node"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Idle deadline, pushed forward by every append; GC deletes rows past it. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("upload_sessions_expires_idx").on(t.expiresAt)],
);
// --- Rename / transfer redirects (read by registryd, written by the web app) ---

/**
 * One row per former `<org>/<name>` of a repository: created when a
 * repository is renamed or transferred to another organization. registryd
 * serves pulls, tag lists, referrers and blob reads of the old name from the
 * target and refuses pushes with 403 (lib/redirects.ts, internal/api/redirects.go).
 * The row disappears when a new repository takes the old name.
 */
export const repositoryRedirects = pgTable(
  "repository_redirects",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Organization slug the repository used to live under (at the time of the move). */
    organizationSlug: text("organization_slug").notNull(),
    /** Former repository name. */
    repositoryName: text("repository_name").notNull(),
    repositoryId: text("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by"),
  },
  (t) => [
    unique("repository_redirects_name_uq").on(t.organizationSlug, t.repositoryName),
    index("repository_redirects_repo_idx").on(t.repositoryId),
  ],
);

/** Former organization slugs, so `<old-slug>/<repo>` keeps resolving after a rename. */
export const organizationRedirects = pgTable("organization_redirects", {
  oldSlug: text("old_slug").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: text("created_by"),
});

// --- Pull rate limits (written by registryd, one budget across replicas) ---

/**
 * One row per client and fixed window: registryd upserts it on every
 * manifest request that counts against a limit, so several replicas share
 * one budget instead of each granting the full one. Windows are aligned to
 * the wall clock; rows are swept once their window is two windows old. The
 * key is "<class>|<client>", e.g. "anon|ip:203.0.113.7" or "auth|user:abc".
 */
export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    key: text("key").primaryKey(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: bigint("count", { mode: "number" }).notNull().default(0),
  },
  (t) => [index("rate_limit_counters_window_idx").on(t.windowStart)],
);

/**
 * Durable copy of every manifest push / delete registryd reports to the web
 * app. registryd inserts the row right after the change (store/outbox.go)
 * and POSTs the event with the row id; the web app claims the row before
 * acting (claimed_at) and marks it delivered_at afterwards. The scheduler
 * drains rows that were never claimed — or whose claim is stale — with
 * exponential backoff, so a web outage or a registryd restart delays
 * scans, signature checks, webhooks and quota warnings instead of losing
 * them. Delivered rows are swept after a week.
 */
export const registryEventOutbox = pgTable(
  "registry_event_outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** manifest.push | manifest.delete */
    type: text("type").notNull(),
    /** Repository path as registryd names it, e.g. "acme/app" or "nginx" (library). */
    repository: text("repository").notNull(),
    digest: text("digest"),
    tag: text("tag"),
    /** Tags that pointed at a manifest deleted by digest. */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    mediaType: text("media_type"),
    actor: text("actor"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [index("registry_event_outbox_pending_idx").on(t.deliveredAt, t.nextAttemptAt)],
);

/**
 * Failed docker-login attempts at the token endpoint, counted per client
 * address and per account so password guessing is slowed down on every
 * replica alike (lib/login-throttle.ts). Rows expire with their window.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    /** "ip:<address>" or "account:<email>" */
    key: text("key").primaryKey(),
    failures: integer("failures").notNull().default(0),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_updated_idx").on(t.updatedAt)],
);
