// Prometheus exposition of the registry's state. Every value is computed
// from the database at scrape time (the web app keeps no in-process
// counters, so the numbers stay correct across restarts and replicas).
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { env } from "./env";
import { registryHealth } from "./registry-client";

type Labels = Record<string, string>;
type Sample = [Labels, number];

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function line(name: string, labels: Labels, value: number): string {
  const keys = Object.keys(labels);
  const l = keys.length ? `{${keys.map((k) => `${k}="${esc(labels[k])}"`).join(",")}}` : "";
  return `${name}${l} ${Number.isFinite(value) ? value : 0}`;
}

class Exposition {
  private out: string[] = [];
  add(name: string, type: "gauge" | "counter", help: string, samples: Sample[]) {
    this.out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) this.out.push(line(name, labels, value));
  }
  toString() {
    return this.out.join("\n") + "\n";
  }
}

const num = (v: unknown) => Number(v ?? 0);

async function clairUp(): Promise<number> {
  if (!env.clairEnabled) return 0;
  try {
    const res = await fetch(`${env.clairUrl.replace(/\/$/, "")}/indexer/api/v1/index_state`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? 1 : 0;
  } catch {
    return 0;
  }
}

/** Render the whole exposition; a few aggregate queries plus two health probes. */
export async function renderMetrics(): Promise<string> {
  const started = performance.now();
  const [totals, byRepo, events, scans, findings, automation, health, clair] = await Promise.all([
    db.execute(sql`
      SELECT
        (SELECT count(*) FROM "user" WHERE role = 'admin')::int AS admins,
        (SELECT count(*) FROM "user" WHERE role IS DISTINCT FROM 'admin')::int AS users,
        (SELECT count(*) FROM organization)::int AS orgs,
        (SELECT count(*) FROM repositories WHERE visibility = 'public')::int AS repos_public,
        (SELECT count(*) FROM repositories WHERE visibility = 'private')::int AS repos_private,
        (SELECT count(*) FROM tags)::int AS tags,
        (SELECT count(*) FROM manifests)::int AS manifests,
        (SELECT count(*) FROM blobs)::int AS blobs,
        COALESCE((SELECT sum(size) FROM blobs), 0)::bigint AS physical_bytes,
        COALESCE((SELECT sum(b.size) FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest), 0)::bigint AS logical_bytes,
        COALESCE((SELECT sum(pull_count) FROM repositories), 0)::bigint AS pulls,
        (SELECT count(*) FROM session WHERE expires_at > now())::int AS sessions,
        (SELECT count(*) FROM access_tokens)::int AS tokens,
        (SELECT count(*) FROM service_accounts)::int AS service_accounts,
        (SELECT count(*) FROM manifest_blocks)::int AS blocked,
        (SELECT count(*) FROM mirrors WHERE enabled)::int AS mirrors_enabled,
        (SELECT count(*) FROM mirrors WHERE NOT enabled)::int AS mirrors_disabled,
        (SELECT count(*) FROM repository_webhooks)::int AS webhooks`),
    db.execute(sql`
      SELECT o.slug AS org, r.name, r.pull_count::bigint AS pulls,
        COALESCE((SELECT sum(b.size) FROM repository_blobs rb JOIN blobs b ON b.digest = rb.blob_digest
          WHERE rb.repository_id = r.id), 0)::bigint AS bytes,
        (SELECT count(*) FROM tags t WHERE t.repository_id = r.id)::int AS tags
      FROM repositories r JOIN organization o ON o.id = r.organization_id
      ORDER BY o.slug, r.name`),
    db.execute(sql`SELECT type, actor_type, count(*)::bigint AS n FROM events GROUP BY type, actor_type`),
    db.execute(sql`SELECT status, count(*)::int AS n FROM vulnerability_scans GROUP BY status`),
    db.execute(sql`
      SELECT
        COALESCE(sum((summary->>'Critical')::int), 0)::int AS critical,
        COALESCE(sum((summary->>'High')::int), 0)::int AS high,
        COALESCE(sum((summary->>'Medium')::int), 0)::int AS medium,
        COALESCE(sum((summary->>'Low')::int), 0)::int AS low,
        COALESCE(sum((summary->>'Negligible')::int), 0)::int AS negligible,
        COALESCE(sum((summary->>'Unknown')::int), 0)::int AS unknown
      FROM vulnerability_scans WHERE status = 'scanned'`),
    db.execute(sql`
      SELECT 'mirror' AS kind, status AS k, '' AS j, count(*)::bigint AS n FROM mirror_runs GROUP BY status
      UNION ALL
      SELECT 'webhook', CASE WHEN ok THEN 'ok' ELSE 'failed' END, '', count(*)::bigint FROM webhook_deliveries GROUP BY ok
      UNION ALL
      SELECT 'job', status, job, count(*)::bigint FROM job_runs GROUP BY job, status`),
    registryHealth(),
    clairUp(),
  ]);

  const t = totals.rows[0];
  const x = new Exposition();
  x.add("chicoree_up", "gauge", "Whether the web app could answer this scrape (always 1 when served).", [[{}, 1]]);
  x.add("chicoree_registry_up", "gauge", "1 when registryd answers its health check.", [[{}, health.ok ? 1 : 0]]);
  x.add("chicoree_clair_up", "gauge", "1 when the Clair indexer answers (0 when scanning is disabled).", [[{}, clair]]);
  x.add("chicoree_users_total", "gauge", "Accounts by instance role.", [
    [{ role: "admin" }, num(t.admins)],
    [{ role: "user" }, num(t.users)],
  ]);
  x.add("chicoree_organizations_total", "gauge", "Organizations, including the library.", [[{}, num(t.orgs)]]);
  x.add("chicoree_repositories_total", "gauge", "Repositories by visibility.", [
    [{ visibility: "public" }, num(t.repos_public)],
    [{ visibility: "private" }, num(t.repos_private)],
  ]);
  x.add("chicoree_tags_total", "gauge", "Tags across all repositories.", [[{}, num(t.tags)]]);
  x.add("chicoree_manifests_total", "gauge", "Manifests (images, indexes, attestations) stored.", [[{}, num(t.manifests)]]);
  x.add("chicoree_blobs_total", "gauge", "Unique blobs on disk.", [[{}, num(t.blobs)]]);
  x.add("chicoree_storage_bytes", "gauge", "Storage: physical is deduplicated bytes on disk, logical counts every repository reference.", [
    [{ kind: "physical" }, num(t.physical_bytes)],
    [{ kind: "logical" }, num(t.logical_bytes)],
  ]);
  x.add("chicoree_pulls_total", "counter", "Manifest pulls since the instance was created.", [[{}, num(t.pulls)]]);
  x.add("chicoree_events_total", "counter", "Registry events by type and actor kind (pruned events drop out of the count).",
    events.rows.map((r) => [{ type: String(r.type), actor: String(r.actor_type) }, num(r.n)] as Sample));
  x.add("chicoree_repository_pulls_total", "counter", "Pulls per repository since it was created.",
    byRepo.rows.map((r) => [{ organization: String(r.org), repository: String(r.name) }, num(r.pulls)] as Sample));
  x.add("chicoree_repository_storage_bytes", "gauge", "Logical size of each repository (sum of the blobs it references).",
    byRepo.rows.map((r) => [{ organization: String(r.org), repository: String(r.name) }, num(r.bytes)] as Sample));
  x.add("chicoree_repository_tags", "gauge", "Tags per repository.",
    byRepo.rows.map((r) => [{ organization: String(r.org), repository: String(r.name) }, num(r.tags)] as Sample));
  x.add("chicoree_vulnerability_scans_total", "gauge", "Scan records by status.",
    ["pending", "indexing", "scanned", "failed"].map((s) => [{ status: s }, num(scans.rows.find((r) => r.status === s)?.n)] as Sample));
  const f = findings.rows[0];
  x.add("chicoree_vulnerability_findings", "gauge", "Findings across every scanned manifest, by severity.", [
    [{ severity: "critical" }, num(f.critical)],
    [{ severity: "high" }, num(f.high)],
    [{ severity: "medium" }, num(f.medium)],
    [{ severity: "low" }, num(f.low)],
    [{ severity: "negligible" }, num(f.negligible)],
    [{ severity: "unknown" }, num(f.unknown)],
  ]);
  x.add("chicoree_blocked_manifests", "gauge", "Manifests whose pulls the pull policy currently refuses.", [[{}, num(t.blocked)]]);
  x.add("chicoree_sessions_active", "gauge", "Browser sessions that have not expired.", [[{}, num(t.sessions)]]);
  x.add("chicoree_access_tokens_total", "gauge", "Personal access tokens.", [[{}, num(t.tokens)]]);
  x.add("chicoree_service_accounts_total", "gauge", "Organization service accounts.", [[{}, num(t.service_accounts)]]);
  x.add("chicoree_mirrors_total", "gauge", "Mirrors by enabled state.", [
    [{ enabled: "true" }, num(t.mirrors_enabled)],
    [{ enabled: "false" }, num(t.mirrors_disabled)],
  ]);
  x.add("chicoree_webhooks_total", "gauge", "Repository webhooks.", [[{}, num(t.webhooks)]]);
  const rows = automation.rows;
  x.add("chicoree_mirror_runs_total", "counter", "Mirror sync runs by outcome.",
    rows.filter((r) => r.kind === "mirror").map((r) => [{ status: String(r.k) }, num(r.n)] as Sample));
  x.add("chicoree_webhook_deliveries_total", "counter", "Webhook deliveries by outcome.",
    rows.filter((r) => r.kind === "webhook").map((r) => [{ status: String(r.k) }, num(r.n)] as Sample));
  x.add("chicoree_job_runs_total", "counter", "Maintenance job runs by job and outcome.",
    rows.filter((r) => r.kind === "job").map((r) => [{ job: String(r.j), status: String(r.k) }, num(r.n)] as Sample));
  x.add("chicoree_scrape_duration_seconds", "gauge", "Time spent collecting this exposition.", [[{}, (performance.now() - started) / 1000]]);
  return x.toString();
}
