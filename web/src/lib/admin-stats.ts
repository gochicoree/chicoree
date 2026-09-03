// Instance-wide statistics for the admin Metrics tab. Everything here is a
// handful of aggregate queries; nothing is cached, the page is admin-only.
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { DayCount } from "@/components/pulls-chart";

export interface TrafficDay {
  day: string;
  pulls: number;
  pushes: number;
}

export async function trafficSeries(days = 30): Promise<TrafficDay[]> {
  const { rows } = await db.execute(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
      COALESCE(c.pulls, 0)::int AS pulls,
      COALESCE(c.pushes, 0)::int AS pushes
    FROM generate_series(
      (now() AT TIME ZONE 'utc')::date - ${days - 1}::int,
      (now() AT TIME ZONE 'utc')::date,
      interval '1 day') AS d(day)
    LEFT JOIN (
      SELECT (created_at AT TIME ZONE 'utc')::date AS day,
        count(*) FILTER (WHERE type = 'pull') AS pulls,
        count(*) FILTER (WHERE type = 'push') AS pushes
      FROM events
      WHERE created_at > now() - make_interval(days => ${days})
      GROUP BY 1
    ) c ON c.day = d.day
    ORDER BY d.day`);
  return rows.map((r) => ({ day: String(r.day), pulls: Number(r.pulls), pushes: Number(r.pushes) }));
}

export const toSeries = (days: TrafficDay[], key: "pulls" | "pushes"): DayCount[] =>
  days.map((d) => ({ day: d.day, count: d[key] }));

export interface TopRepo {
  id: string;
  org: string;
  name: string;
  visibility: string;
  pulls30d: number;
  pullsTotal: number;
  bytes: number;
  tags: number;
}

/** Busiest repositories (pulls in the last 30 days) and the largest ones. */
export async function topRepositories(limit = 8): Promise<{ byPulls: TopRepo[]; bySize: TopRepo[] }> {
  const { rows } = await db.execute(sql`
    SELECT r.id, r.name, o.slug AS org, r.visibility,
      r.pull_count::bigint AS pulls_total,
      (SELECT count(*) FROM events e
        WHERE e.repository_id = r.id AND e.type = 'pull' AND e.created_at > now() - interval '30 days')::int AS pulls_30d,
      COALESCE((SELECT sum(b.size) FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest
        WHERE rb.repository_id = r.id), 0)::bigint AS bytes,
      (SELECT count(*) FROM tags t WHERE t.repository_id = r.id)::int AS tags
    FROM repositories r
    JOIN organization o ON o.id = r.organization_id`);
  const all: TopRepo[] = rows.map((r) => ({
    id: String(r.id),
    org: String(r.org),
    name: String(r.name),
    visibility: String(r.visibility),
    pulls30d: Number(r.pulls_30d),
    pullsTotal: Number(r.pulls_total),
    bytes: Number(r.bytes),
    tags: Number(r.tags),
  }));
  const byPulls = [...all].sort((a, b) => b.pulls30d - a.pulls30d || b.pullsTotal - a.pullsTotal).slice(0, limit);
  const bySize = [...all].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
  return { byPulls, bySize };
}

export interface OrgStorage {
  id: string;
  slug: string;
  name: string;
  repos: number;
  manifests: number;
  members: number;
  bytes: number;
}

export async function storageByOrganization(): Promise<OrgStorage[]> {
  const { rows } = await db.execute(sql`
    SELECT o.id, o.slug, o.name,
      (SELECT count(*) FROM repositories r WHERE r.organization_id = o.id)::int AS repos,
      (SELECT count(*) FROM manifests m JOIN repositories r ON r.id = m.repository_id
        WHERE r.organization_id = o.id)::int AS manifests,
      (SELECT count(*) FROM member m WHERE m.organization_id = o.id)::int AS members,
      COALESCE((SELECT sum(b.size) FROM repositories r
        JOIN repository_blobs rb ON rb.repository_id = r.id
        JOIN blobs b ON b.digest = rb.blob_digest
        WHERE r.organization_id = o.id), 0)::bigint AS bytes
    FROM organization o
    ORDER BY bytes DESC, o.name`);
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    repos: Number(r.repos),
    manifests: Number(r.manifests),
    members: Number(r.members),
    bytes: Number(r.bytes),
  }));
}

export interface ScanOverview {
  scanned: number;
  pending: number;
  failed: number;
  withCritical: number;
  withHigh: number;
  blocked: number;
  findings: Record<"Critical" | "High" | "Medium" | "Low" | "Negligible" | "Unknown", number>;
}

export async function scanOverview(): Promise<ScanOverview> {
  const { rows } = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'scanned')::int AS scanned,
      count(*) FILTER (WHERE status IN ('pending', 'indexing'))::int AS pending,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status = 'scanned' AND COALESCE((summary->>'Critical')::int, 0) > 0)::int AS with_critical,
      count(*) FILTER (WHERE status = 'scanned' AND COALESCE((summary->>'High')::int, 0) > 0)::int AS with_high,
      COALESCE(sum((summary->>'Critical')::int), 0)::int AS critical,
      COALESCE(sum((summary->>'High')::int), 0)::int AS high,
      COALESCE(sum((summary->>'Medium')::int), 0)::int AS medium,
      COALESCE(sum((summary->>'Low')::int), 0)::int AS low,
      COALESCE(sum((summary->>'Negligible')::int), 0)::int AS negligible,
      COALESCE(sum((summary->>'Unknown')::int), 0)::int AS unknown,
      (SELECT count(*) FROM manifest_blocks)::int AS blocked
    FROM vulnerability_scans`);
  const r = rows[0];
  return {
    scanned: Number(r.scanned),
    pending: Number(r.pending),
    failed: Number(r.failed),
    withCritical: Number(r.with_critical),
    withHigh: Number(r.with_high),
    blocked: Number(r.blocked),
    findings: {
      Critical: Number(r.critical),
      High: Number(r.high),
      Medium: Number(r.medium),
      Low: Number(r.low),
      Negligible: Number(r.negligible),
      Unknown: Number(r.unknown),
    },
  };
}

export interface AccountOverview {
  users: number;
  admins: number;
  twoFactor: number;
  passkeys: number;
  banned: number;
  new30d: number;
  sessions: number;
  active7d: number;
  tokens: number;
  tokensUsed7d: number;
  serviceAccounts: number;
  serviceAccountsUsed7d: number;
}

export async function accountOverview(): Promise<AccountOverview> {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM "user")::int AS users,
      (SELECT count(*) FROM "user" WHERE role = 'admin')::int AS admins,
      (SELECT count(*) FROM "user" WHERE two_factor_enabled)::int AS two_factor,
      (SELECT count(DISTINCT user_id) FROM passkey)::int AS passkeys,
      (SELECT count(*) FROM "user" WHERE banned)::int AS banned,
      (SELECT count(*) FROM "user" WHERE created_at > now() - interval '30 days')::int AS new_30d,
      (SELECT count(*) FROM session WHERE expires_at > now())::int AS sessions,
      (SELECT count(DISTINCT user_id) FROM session WHERE updated_at > now() - interval '7 days')::int AS active_7d,
      (SELECT count(*) FROM access_tokens)::int AS tokens,
      (SELECT count(*) FROM access_tokens WHERE last_used_at > now() - interval '7 days')::int AS tokens_used_7d,
      (SELECT count(*) FROM service_accounts)::int AS service_accounts,
      (SELECT count(*) FROM service_accounts WHERE last_used_at > now() - interval '7 days')::int AS sa_used_7d`);
  const r = rows[0];
  return {
    users: Number(r.users),
    admins: Number(r.admins),
    twoFactor: Number(r.two_factor),
    passkeys: Number(r.passkeys),
    banned: Number(r.banned),
    new30d: Number(r.new_30d),
    sessions: Number(r.sessions),
    active7d: Number(r.active_7d),
    tokens: Number(r.tokens),
    tokensUsed7d: Number(r.tokens_used_7d),
    serviceAccounts: Number(r.service_accounts),
    serviceAccountsUsed7d: Number(r.sa_used_7d),
  };
}

export interface AutomationOverview {
  mirrors: number;
  mirrorsEnabled: number;
  mirrorOk7d: number;
  mirrorFailed7d: number;
  webhooks: number;
  deliveriesOk7d: number;
  deliveriesFailed7d: number;
  jobsOk7d: number;
  jobsFailed7d: number;
}

export async function automationOverview(): Promise<AutomationOverview> {
  const { rows } = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM mirrors)::int AS mirrors,
      (SELECT count(*) FROM mirrors WHERE enabled)::int AS mirrors_enabled,
      (SELECT count(*) FROM mirror_runs WHERE started_at > now() - interval '7 days' AND status = 'succeeded')::int AS mirror_ok,
      (SELECT count(*) FROM mirror_runs WHERE started_at > now() - interval '7 days' AND status = 'failed')::int AS mirror_failed,
      (SELECT count(*) FROM repository_webhooks)::int AS webhooks,
      (SELECT count(*) FROM webhook_deliveries WHERE created_at > now() - interval '7 days' AND ok)::int AS deliveries_ok,
      (SELECT count(*) FROM webhook_deliveries WHERE created_at > now() - interval '7 days' AND NOT ok)::int AS deliveries_failed,
      (SELECT count(*) FROM job_runs WHERE started_at > now() - interval '7 days' AND status = 'succeeded')::int AS jobs_ok,
      (SELECT count(*) FROM job_runs WHERE started_at > now() - interval '7 days' AND status = 'failed')::int AS jobs_failed`);
  const r = rows[0];
  return {
    mirrors: Number(r.mirrors),
    mirrorsEnabled: Number(r.mirrors_enabled),
    mirrorOk7d: Number(r.mirror_ok),
    mirrorFailed7d: Number(r.mirror_failed),
    webhooks: Number(r.webhooks),
    deliveriesOk7d: Number(r.deliveries_ok),
    deliveriesFailed7d: Number(r.deliveries_failed),
    jobsOk7d: Number(r.jobs_ok),
    jobsFailed7d: Number(r.jobs_failed),
  };
}

// --- Traffic in bytes (repository_traffic, written by registryd) ---

export interface TrafficBytesDay {
  day: string;
  /** Bytes served by registryd (blob + manifest GETs). */
  egress: number;
  /** Bytes received (committed uploads + manifest PUTs). */
  ingress: number;
  /** Blob sizes of GETs answered with a redirect to the storage backend. */
  redirect: number;
}

export async function trafficBytesSeries(days = 30): Promise<TrafficBytesDay[]> {
  const { rows } = await db.execute(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
      COALESCE(t.egress, 0)::bigint AS egress,
      COALESCE(t.ingress, 0)::bigint AS ingress,
      COALESCE(t.redirect, 0)::bigint AS redirect
    FROM generate_series(
      (now() AT TIME ZONE 'utc')::date - ${days - 1}::int,
      (now() AT TIME ZONE 'utc')::date,
      interval '1 day') AS d(day)
    LEFT JOIN (
      SELECT day, sum(pull_bytes) AS egress, sum(push_bytes) AS ingress, sum(redirect_bytes) AS redirect
      FROM repository_traffic
      WHERE day >= (now() AT TIME ZONE 'utc')::date - ${days - 1}::int
      GROUP BY day
    ) t ON t.day = d.day
    ORDER BY d.day`);
  return rows.map((r) => ({ day: String(r.day), egress: Number(r.egress), ingress: Number(r.ingress), redirect: Number(r.redirect) }));
}

export const toBytesSeries = (days: TrafficBytesDay[], key: "egress" | "ingress" | "redirect"): DayCount[] =>
  days.map((d) => ({ day: d.day, count: d[key] }));

export interface TopEgressRepo {
  id: string;
  org: string;
  name: string;
  visibility: string;
  egress30d: number;
  redirect30d: number;
  ingress30d: number;
  blobPulls30d: number;
}

/** Repositories that caused the most egress in the last 30 days. */
export async function topRepositoriesByEgress(limit = 8): Promise<TopEgressRepo[]> {
  const { rows } = await db.execute(sql`
    SELECT r.id, r.name, o.slug AS org, r.visibility,
      sum(t.pull_bytes)::bigint AS egress,
      sum(t.redirect_bytes)::bigint AS redirect,
      sum(t.push_bytes)::bigint AS ingress,
      sum(t.blob_pulls)::bigint AS blob_pulls
    FROM repository_traffic t
    JOIN repositories r ON r.id = t.repository_id
    JOIN organization o ON o.id = r.organization_id
    WHERE t.day > (now() AT TIME ZONE 'utc')::date - 30
    GROUP BY r.id, r.name, o.slug, r.visibility
    HAVING sum(t.pull_bytes) + sum(t.redirect_bytes) > 0
    ORDER BY sum(t.pull_bytes) + sum(t.redirect_bytes) DESC, o.slug, r.name
    LIMIT ${limit}`);
  return rows.map((r) => ({
    id: String(r.id),
    org: String(r.org),
    name: String(r.name),
    visibility: String(r.visibility),
    egress30d: Number(r.egress),
    redirect30d: Number(r.redirect),
    ingress30d: Number(r.ingress),
    blobPulls30d: Number(r.blob_pulls),
  }));
}

export interface OrgTraffic {
  id: string;
  slug: string;
  name: string;
  egress30d: number;
  redirect30d: number;
  ingress30d: number;
}

/** Egress / ingress per organization, last 30 days (organizations without traffic included). */
export async function trafficByOrganization(): Promise<OrgTraffic[]> {
  const { rows } = await db.execute(sql`
    SELECT o.id, o.slug, o.name,
      COALESCE(t.egress, 0)::bigint AS egress,
      COALESCE(t.redirect, 0)::bigint AS redirect,
      COALESCE(t.ingress, 0)::bigint AS ingress
    FROM organization o
    LEFT JOIN (
      SELECT r.organization_id,
        sum(t.pull_bytes) AS egress, sum(t.redirect_bytes) AS redirect, sum(t.push_bytes) AS ingress
      FROM repository_traffic t
      JOIN repositories r ON r.id = t.repository_id
      WHERE t.day > (now() AT TIME ZONE 'utc')::date - 30
      GROUP BY r.organization_id
    ) t ON t.organization_id = o.id
    ORDER BY egress DESC, ingress DESC, o.name`);
  return rows.map((r) => ({
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    egress30d: Number(r.egress),
    redirect30d: Number(r.redirect),
    ingress30d: Number(r.ingress),
  }));
}

/** Who pushes and pulls: activity by actor type, last 30 days. */
export async function actorBreakdown(): Promise<{ actor: string; pulls: number; pushes: number }[]> {
  const { rows } = await db.execute(sql`
    SELECT actor_type AS actor,
      count(*) FILTER (WHERE type = 'pull')::int AS pulls,
      count(*) FILTER (WHERE type = 'push')::int AS pushes
    FROM events
    WHERE created_at > now() - interval '30 days'
    GROUP BY actor_type
    ORDER BY actor_type`);
  return rows.map((r) => ({ actor: String(r.actor), pulls: Number(r.pulls), pushes: Number(r.pushes) }));
}
