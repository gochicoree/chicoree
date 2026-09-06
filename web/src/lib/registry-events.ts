// Registry events (manifest pushes and deletes) and the outbox that makes
// them durable. registryd records every event in registry_event_outbox and
// POSTs it to /api/internal/events; the route claims the row and processes
// the event. Rows that were never claimed — the web app was down, or
// registryd gave up retrying — and rows whose claim went stale (the process
// died mid-way) are drained here from the scheduler tick with exponential
// backoff. Processing is the same in both paths (processRegistryEvent).
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { env } from "./env";
import { cacheManifestConfig } from "./scan";
import { startScan } from "./scan-tasks";
import { buildPushPayload, dispatchRepositoryWebhooks, emitRepositoryEvent, resolveActor } from "./webhooks";
import { checkQuotaWarningsForRepository } from "./notify";
import { getRepoByPath } from "./data";
import { imageReference, splitImagePath } from "./library";
import { onManifestPushed } from "./signatures";

export interface RegistryEvent {
  /** Outbox row id; absent from events sent by a registryd whose outbox insert failed. */
  id?: number;
  type: string;
  repository: string;
  digest: string;
  tag?: string | null;
  /** Tags that pointed at a manifest deleted by digest. */
  tags?: string[] | null;
  mediaType?: string | null;
  actor?: string | null;
}

/** A claim older than this is considered abandoned (the process died) and the row is retried. */
const CLAIM_TTL = "10 minutes";
/** Rows past this many attempts stay in the table for inspection but are no longer retried. */
export const OUTBOX_MAX_ATTEMPTS = 25;
/** Delivered rows are kept this long for the health page and debugging. */
const KEEP_DELIVERED = "7 days";

/** Backoff after `attempts` failures: 30 s, 60 s, 2 min, … capped at an hour. */
export function outboxBackoffSeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Act on one event: cache the image config, fan out webhooks and quota
 * warnings, verify signatures, start the scan (pushes); or emit the delete
 * webhook. Each step logs and swallows its own failure so one broken
 * receiver does not block the others; only an unexpected error escapes and
 * makes the outbox retry the whole event.
 */
export async function processRegistryEvent(event: RegistryEvent): Promise<void> {
  if (event.type === "manifest.push" && event.repository && event.digest) {
    await cacheManifestConfig(event.repository, event.digest).catch((err) => console.error("config cache failed:", err));
    // Repository webhooks go out right after the config is cached so the
    // payload can include platform, labels and entrypoint.
    const target = splitImagePath(event.repository);
    if (target) {
      const built = await buildPushPayload(target.orgSlug, target.repoName, event.digest, event.tag ?? null, event.actor ?? undefined).catch(
        (err) => {
          console.error("webhook payload failed:", err);
          return null;
        },
      );
      if (built) {
        await dispatchRepositoryWebhooks(built.repositoryId, built.payload);
        await checkQuotaWarningsForRepository(built.repositoryId).catch((err) => console.error("quota warning check failed:", err));
      }
    }
    // Signatures and attestations arrive as pushes too: verify what was
    // attached (or the image itself) and refresh the signature policy.
    await onManifestPushed(event.repository, event.digest, event.tag).catch((err) => console.error("signature verification failed:", err));
    await startScan(event.repository, event.digest).catch((err) => console.error("scan failed:", err));
    return;
  }

  if (event.type === "manifest.delete" && event.repository) {
    const target = splitImagePath(event.repository);
    if (!target) return;
    const found = await getRepoByPath(target.orgSlug, target.repoName);
    if (!found) return;
    const tags = event.tags ?? (event.tag ? [event.tag] : []);
    const digest = event.digest || null;
    await emitRepositoryEvent(found.repo.id, "delete", {
      tag: event.tag ?? null,
      tags,
      digest,
      image: digest
        ? {
            digest,
            reference: imageReference(env.registryHost, target.orgSlug, target.repoName, digest),
            digestReference: imageReference(env.registryHost, target.orgSlug, target.repoName, digest),
          }
        : null,
      actor: await resolveActor(event.actor),
    }).catch((err) => console.error("delete webhook failed:", err));
  }
}

/**
 * Take the outbox row for processing. False when it was already delivered
 * or another process holds a live claim — the caller skips the event.
 */
export async function claimOutboxEvent(id: number): Promise<boolean> {
  const { rows } = await db.execute(sql`
    UPDATE registry_event_outbox SET claimed_at = now()
    WHERE id = ${id} AND delivered_at IS NULL
      AND (claimed_at IS NULL OR claimed_at < now() - interval '${sql.raw(CLAIM_TTL)}')
    RETURNING id`);
  return rows.length > 0;
}

export async function completeOutboxEvent(id: number): Promise<void> {
  await db.execute(sql`UPDATE registry_event_outbox SET delivered_at = now(), last_error = NULL WHERE id = ${id}`);
}

/** Release the claim and schedule the next try. */
export async function failOutboxEvent(id: number, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await db.execute(sql`
    UPDATE registry_event_outbox
    SET attempts = attempts + 1,
        claimed_at = NULL,
        last_error = ${message},
        next_attempt_at = now() + make_interval(secs => ${sql.raw("LEAST(3600, 30 * power(2, GREATEST(0, attempts)))")})
    WHERE id = ${id}`);
}

/** Process one claimed event and record the outcome. */
export async function handleClaimedEvent(id: number, event: RegistryEvent): Promise<void> {
  try {
    await processRegistryEvent(event);
    await completeOutboxEvent(id);
  } catch (err) {
    console.error(`registry event ${id} (${event.type} ${event.repository}) failed:`, err);
    await failOutboxEvent(id, err).catch((e) => console.error("outbox update failed:", e));
  }
}

interface OutboxRow {
  id: number;
  type: string;
  repository: string;
  digest: string | null;
  tag: string | null;
  tags: string[] | null;
  media_type: string | null;
  actor: string | null;
}

/**
 * Process due events nobody delivered: never claimed, or claimed by a
 * process that died. Runs from the scheduler tick on the lock-holding
 * replica; claims are atomic, so an overlapping run is harmless.
 */
export async function drainEventOutbox(limit = 50): Promise<{ processed: number; failed: number }> {
  const { rows } = await db.execute(sql`
    SELECT id, type, repository, digest, tag, tags, media_type, actor
    FROM registry_event_outbox
    WHERE delivered_at IS NULL AND next_attempt_at <= now() AND attempts < ${OUTBOX_MAX_ATTEMPTS}
      AND (claimed_at IS NULL OR claimed_at < now() - interval '${sql.raw(CLAIM_TTL)}')
    ORDER BY id
    LIMIT ${limit}`);
  let processed = 0;
  let failed = 0;
  for (const raw of rows as unknown as OutboxRow[]) {
    const id = Number(raw.id);
    if (!(await claimOutboxEvent(id))) continue;
    const event: RegistryEvent = {
      id,
      type: raw.type,
      repository: raw.repository,
      digest: raw.digest ?? "",
      tag: raw.tag,
      tags: raw.tags,
      mediaType: raw.media_type,
      actor: raw.actor,
    };
    try {
      await processRegistryEvent(event);
      await completeOutboxEvent(id);
      processed++;
    } catch (err) {
      failed++;
      console.error(`registry event ${id} (${event.type} ${event.repository}) failed:`, err);
      await failOutboxEvent(id, err).catch((e) => console.error("outbox update failed:", e));
    }
  }
  if (processed > 0) console.log(`[outbox] delivered ${processed} registry event${processed === 1 ? "" : "s"} the registry could not hand over`);
  await db
    .execute(sql`DELETE FROM registry_event_outbox WHERE delivered_at IS NOT NULL AND delivered_at < now() - interval '${sql.raw(KEEP_DELIVERED)}'`)
    .catch((err) => console.error("outbox sweep failed:", err));
  return { processed, failed };
}

export interface OutboxStats {
  /** Undelivered rows still being retried. */
  pending: number;
  /** Undelivered rows that hit the attempt limit. */
  stuck: number;
  /** Age of the oldest undelivered row, in seconds. */
  oldestPendingSeconds: number | null;
  /** Rows delivered from the outbox drain (not the fast path) in the last 24 h. */
  drainedLastDay: number;
}

export async function outboxStats(): Promise<OutboxStats> {
  const { rows } = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE delivered_at IS NULL AND attempts < ${OUTBOX_MAX_ATTEMPTS})::int AS pending,
      count(*) FILTER (WHERE delivered_at IS NULL AND attempts >= ${OUTBOX_MAX_ATTEMPTS})::int AS stuck,
      extract(epoch FROM now() - min(created_at) FILTER (WHERE delivered_at IS NULL))::int AS oldest,
      count(*) FILTER (WHERE delivered_at IS NOT NULL AND attempts > 0 AND delivered_at > now() - interval '1 day')::int AS drained
    FROM registry_event_outbox`);
  const r = rows[0] ?? {};
  return {
    pending: Number(r.pending ?? 0),
    stuck: Number(r.stuck ?? 0),
    oldestPendingSeconds: r.oldest == null ? null : Number(r.oldest),
    drainedLastDay: Number(r.drained ?? 0),
  };
}
