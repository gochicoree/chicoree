// The `quota-enforce` job: organizations (and accounts, across the
// organizations they own that have no limit of their own) found above their
// storage limit are told, given a grace period, told again shortly before it
// ends, and then pruned down to the limit — oldest images first, protected
// tags never — followed by garbage collection. Everything it does is
// recorded in the job run; dry runs only report.
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { quotaBreaches } from "@/db/schema";
import { deleteManifestByDigest } from "./manifests";
import { notify } from "./notify";
import { planPruneToFit, type PrunePlan, type ScopeRepository } from "./quota-enforce-shared";
import { triggerGarbageCollection } from "./registry-client";
import type { RetentionDetailLine } from "./retention";
import { deleteTag } from "./tag-admin";
import { effectiveTagRules } from "./tag-rules";

import { imagePath } from "@/lib/library-shared";
export interface Breach {
  targetType: "organization" | "user";
  targetId: string;
  /** Slug of the organization, or the user's email. */
  label: string;
  usedBytes: number;
  limitBytes: number;
  /** Repositories whose blobs count against this limit. */
  repositoryIds: string[];
}

/**
 * Who is over a storage limit right now. An organization with its own limit
 * counts its repositories; an account with a limit counts the repositories
 * of the organizations it owns that have no storage limit of their own —
 * the same reading as lib/quota.ts and registryd.
 */
export async function findBreaches(organizationSlug?: string): Promise<Breach[]> {
  const out: Breach[] = [];
  const orgs = await db.execute(sql`
    WITH usage AS (
      SELECT x.organization_id, COALESCE(sum(x.size), 0)::bigint AS used
      FROM (SELECT DISTINCT r.organization_id, b.digest, b.size FROM blobs b
            JOIN repository_blobs rb ON rb.blob_digest = b.digest
            JOIN repositories r ON r.id = rb.repository_id) AS x
      GROUP BY x.organization_id)
    SELECT o.id, o.slug, ol.max_storage_bytes AS lim, u.used
    FROM organization_limits ol
    JOIN organization o ON o.id = ol.organization_id
    JOIN usage u ON u.organization_id = o.id
    WHERE ol.max_storage_bytes IS NOT NULL AND u.used > ol.max_storage_bytes
      ${organizationSlug ? sql`AND o.slug = ${organizationSlug}` : sql``}
    ORDER BY o.slug`);
  for (const r of orgs.rows) {
    const repos = await db.execute(sql`SELECT id FROM repositories WHERE organization_id = ${r.id as string}`);
    out.push({ targetType: "organization", targetId: r.id as string, label: r.slug as string, usedBytes: Number(r.used), limitBytes: Number(r.lim), repositoryIds: repos.rows.map((x) => x.id as string) });
  }
  if (organizationSlug) return out;

  const users = await db.execute(sql`
    SELECT ul.user_id, u.email, ul.max_storage_bytes AS lim,
      COALESCE((SELECT sum(size)::bigint FROM (
        SELECT DISTINCT r.organization_id, b.digest, b.size FROM blobs b
        JOIN repository_blobs rb ON rb.blob_digest = b.digest
        JOIN repositories r ON r.id = rb.repository_id
        WHERE r.organization_id IN (
          SELECT m.organization_id FROM member m
          LEFT JOIN organization_limits ol ON ol.organization_id = m.organization_id
          WHERE m.user_id = ul.user_id AND m.role = 'owner' AND ol.max_storage_bytes IS NULL)) t), 0) AS used
    FROM user_limits ul JOIN "user" u ON u.id = ul.user_id
    WHERE ul.max_storage_bytes IS NOT NULL`);
  for (const r of users.rows) {
    if (Number(r.used) <= Number(r.lim)) continue;
    const repos = await db.execute(sql`
      SELECT r.id FROM repositories r
      WHERE r.organization_id IN (
        SELECT m.organization_id FROM member m
        LEFT JOIN organization_limits ol ON ol.organization_id = m.organization_id
        WHERE m.user_id = ${r.user_id as string} AND m.role = 'owner' AND ol.max_storage_bytes IS NULL)`);
    out.push({ targetType: "user", targetId: r.user_id as string, label: r.email as string, usedBytes: Number(r.used), limitBytes: Number(r.lim), repositoryIds: repos.rows.map((x) => x.id as string) });
  }
  return out;
}

/** The in-memory picture the planner needs for a set of repositories. */
export async function loadScope(repositoryIds: string[]): Promise<ScopeRepository[]> {
  if (repositoryIds.length === 0) return [];
  const [repos, manifests, refs, tags] = await Promise.all([
    db.execute(sql`SELECT r.id, r.organization_id, o.slug AS org_slug, r.name FROM repositories r JOIN organization o ON o.id = r.organization_id WHERE r.id IN ${sql`(${sql.join(repositoryIds.map((id) => sql`${id}`), sql`, `)})`}`),
    db.execute(sql`SELECT repository_id, digest, created_at, subject_digest FROM manifests WHERE repository_id IN ${sql`(${sql.join(repositoryIds.map((id) => sql`${id}`), sql`, `)})`}`),
    db.execute(sql`
      SELECT mr.repository_id, mr.manifest_digest, mr.ref_digest, b.size
      FROM manifest_refs mr LEFT JOIN blobs b ON b.digest = mr.ref_digest
      WHERE mr.repository_id IN ${sql`(${sql.join(repositoryIds.map((id) => sql`${id}`), sql`, `)})`}`),
    db.execute(sql`SELECT repository_id, name, manifest_digest, updated_at FROM tags WHERE repository_id IN ${sql`(${sql.join(repositoryIds.map((id) => sql`${id}`), sql`, `)})`}`),
  ]);
  const manifestDigests = new Set(manifests.rows.map((m) => `${m.repository_id}:${m.digest}`));
  const out: ScopeRepository[] = [];
  for (const r of repos.rows) {
    const id = r.id as string;
    const rules = await effectiveTagRules(r.organization_id as string, id);
    const ms = manifests.rows
      .filter((m) => m.repository_id === id)
      .map((m) => {
        const mine = refs.rows.filter((x) => x.repository_id === id && x.manifest_digest === m.digest);
        return {
          digest: m.digest as string,
          pushedAt: new Date(m.created_at as string),
          subjectDigest: (m.subject_digest as string | null) ?? null,
          blobs: mine.filter((x) => x.size !== null).map((x) => ({ digest: x.ref_digest as string, size: Number(x.size) })),
          // A ref without a blob row is a child manifest (or a blob the registry never stored, which counts nothing).
          children: mine.filter((x) => x.size === null && manifestDigests.has(`${id}:${x.ref_digest}`)).map((x) => x.ref_digest as string),
        };
      });
    out.push({
      id,
      path: imagePath(r.org_slug as string, r.name as string),
      manifests: ms,
      tags: tags.rows.filter((t) => t.repository_id === id).map((t) => ({ name: t.name as string, digest: t.manifest_digest as string, pushedAt: new Date(t.updated_at as string) })),
      rules,
    });
  }
  return out;
}

export interface EnforceTarget {
  target: string;
  type: "organization" | "user";
  usedBytes: number;
  limitBytes: number;
  overSince: string;
  daysLeft: number;
  action: "noticed" | "reminded" | "waiting" | "pruned" | "planned" | "unmet";
  freedBytes?: number;
  tags?: number;
  manifests?: number;
  failed?: number;
}

export interface EnforceResult extends Record<string, unknown> {
  dryRun: boolean;
  graceDays: number;
  /** Targets over their limit right now. */
  targets: number;
  notified: number;
  pruned: number;
  repositories: number;
  tags: { planned: number; deleted: number; failed: number };
  manifests: { planned: number; deleted: number; failed: number };
  perTarget: EnforceTarget[];
  detail: RetentionDetailLine[];
  truncated: number;
  gc: Record<string, unknown> | null;
}

const MAX_DETAIL_LINES = 300;
const DAY = 86_400_000;
/** The reminder goes out this many days before pruning. */
const REMINDER_DAYS = 2;

/**
 * One pass: record who is over, notify, and prune those whose grace period
 * has run out. `subject` is the registry subject deletions are made as.
 */
export async function runQuotaEnforcement(opts: { graceDays: number; dryRun: boolean; organizationSlug?: string; subject: string; now?: Date }): Promise<EnforceResult> {
  const now = opts.now ?? new Date();
  const result: EnforceResult = {
    dryRun: opts.dryRun,
    graceDays: opts.graceDays,
    targets: 0,
    notified: 0,
    pruned: 0,
    repositories: 0,
    tags: { planned: 0, deleted: 0, failed: 0 },
    manifests: { planned: 0, deleted: 0, failed: 0 },
    perTarget: [],
    detail: [],
    truncated: 0,
    gc: null,
  };
  const push = (line: RetentionDetailLine) => {
    if (result.detail.length < MAX_DETAIL_LINES) result.detail.push(line);
    else result.truncated++;
  };

  const breaches = await findBreaches(opts.organizationSlug);
  result.targets = breaches.length;

  // Targets that fit again are forgotten.
  const seen = new Set(breaches.map((b) => `${b.targetType}:${b.targetId}`));
  const known = await db.query.quotaBreaches.findMany();
  for (const k of known) {
    if (opts.organizationSlug && k.targetType !== "organization") continue;
    if (!seen.has(`${k.targetType}:${k.targetId}`) && !opts.dryRun) {
      await db.delete(quotaBreaches).where(and(eq(quotaBreaches.targetType, k.targetType), eq(quotaBreaches.targetId, k.targetId)));
    }
  }

  let pruneRan = false;
  for (const b of breaches) {
    let row = known.find((k) => k.targetType === b.targetType && k.targetId === b.targetId) ?? null;
    if (!row) {
      const values = { targetType: b.targetType, targetId: b.targetId, firstOverAt: now, lastSeenAt: now, usedBytes: b.usedBytes, limitBytes: b.limitBytes };
      if (!opts.dryRun) [row] = await db.insert(quotaBreaches).values(values).returning();
      else row = { ...values, notifiedAt: null, finalNoticeAt: null, prunedAt: null };
    } else if (!opts.dryRun) {
      await db.update(quotaBreaches).set({ lastSeenAt: now, usedBytes: b.usedBytes, limitBytes: b.limitBytes }).where(and(eq(quotaBreaches.targetType, b.targetType), eq(quotaBreaches.targetId, b.targetId)));
    }
    const pruneAt = new Date(row.firstOverAt.getTime() + opts.graceDays * DAY);
    const daysLeft = Math.max(0, Math.ceil((pruneAt.getTime() - now.getTime()) / DAY));
    const entry: EnforceTarget = { target: b.label, type: b.targetType, usedBytes: b.usedBytes, limitBytes: b.limitBytes, overSince: row.firstOverAt.toISOString(), daysLeft, action: "waiting" };
    result.perTarget.push(entry);

    // Notices: once when first seen over, once shortly before pruning.
    const target = b.targetType === "organization" ? { type: "organization" as const, organizationId: b.targetId } : { type: "user" as const, userId: b.targetId };
    if (!row.notifiedAt) {
      entry.action = "noticed";
      result.notified++;
      if (!opts.dryRun) {
        await notify({ event: "quota.exceeded", target, used: b.usedBytes, limit: b.limitBytes, pruneAt, reminder: false }).catch((err) => console.error("quota.exceeded notification failed:", err));
        await db.update(quotaBreaches).set({ notifiedAt: now }).where(and(eq(quotaBreaches.targetType, b.targetType), eq(quotaBreaches.targetId, b.targetId)));
      }
    } else if (!row.finalNoticeAt && daysLeft > 0 && daysLeft <= REMINDER_DAYS) {
      entry.action = "reminded";
      result.notified++;
      if (!opts.dryRun) {
        await notify({ event: "quota.exceeded", target, used: b.usedBytes, limit: b.limitBytes, pruneAt, reminder: true }).catch((err) => console.error("quota.exceeded reminder failed:", err));
        await db.update(quotaBreaches).set({ finalNoticeAt: now }).where(and(eq(quotaBreaches.targetType, b.targetType), eq(quotaBreaches.targetId, b.targetId)));
      }
    }

    if (now.getTime() < pruneAt.getTime()) continue;

    // Grace period over: prune down to the limit.
    const scope = await loadScope(b.repositoryIds);
    result.repositories += scope.length;
    const plan: PrunePlan = planPruneToFit(scope, b.limitBytes);
    const per = { tags: 0, manifests: 0, failed: 0 };
    for (const step of plan.steps) {
      if (step.kind === "tag") result.tags.planned++;
      else result.manifests.planned++;
      if (opts.dryRun) {
        if (step.kind === "tag") per.tags++;
        else per.manifests++;
        push({ repository: step.repository, kind: step.kind, ref: step.ref, reason: step.reason, status: "planned" });
        continue;
      }
      try {
        if (step.kind === "tag") await deleteTag(step.repositoryId, step.ref, opts.subject, { moveLatest: false });
        else await deleteManifestByDigest(step.repositoryId, step.ref, opts.subject);
        if (step.kind === "tag") {
          result.tags.deleted++;
          per.tags++;
        } else {
          result.manifests.deleted++;
          per.manifests++;
        }
        push({ repository: step.repository, kind: step.kind, ref: step.ref, reason: step.reason, status: "deleted" });
      } catch (err) {
        if (step.kind === "tag") result.tags.failed++;
        else result.manifests.failed++;
        per.failed++;
        push({ repository: step.repository, kind: step.kind, ref: step.ref, reason: step.reason, status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
    entry.action = plan.unmet ? "unmet" : opts.dryRun ? "planned" : "pruned";
    entry.freedBytes = plan.beforeBytes - plan.afterBytes;
    entry.tags = per.tags;
    entry.manifests = per.manifests;
    entry.failed = per.failed;
    if (!opts.dryRun && plan.steps.length > 0) {
      pruneRan = true;
      result.pruned++;
      await db.update(quotaBreaches).set({ prunedAt: now }).where(and(eq(quotaBreaches.targetType, b.targetType), eq(quotaBreaches.targetId, b.targetId)));
      await notify({
        event: "quota.pruned",
        target,
        used: b.usedBytes,
        limit: b.limitBytes,
        freed: entry.freedBytes,
        tags: per.tags,
        manifests: per.manifests,
        unmet: plan.unmet,
        detail: plan.steps.slice(0, 40).map((s) => `${s.repository}: ${s.kind} ${s.kind === "manifest" ? s.ref.slice(7, 19) : s.ref}`),
      }).catch((err) => console.error("quota.pruned notification failed:", err));
    }
  }

  // Deleted manifests only free bytes once garbage collection has unlinked their blobs.
  if (pruneRan) {
    try {
      result.gc = (await triggerGarbageCollection("1h")) as Record<string, unknown>;
    } catch (err) {
      result.gc = { error: err instanceof Error ? err.message : String(err) };
    }
  }
  return result;
}

/** For the admin screens: current breaches with their state. */
export async function listBreaches() {
  return db.query.quotaBreaches.findMany({ orderBy: (t, { asc }) => [asc(t.firstOverAt)] });
}

