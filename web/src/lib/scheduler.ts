// In-app job scheduler. Started once per server process from
// src/instrumentation.ts; every 30 seconds it tries to take a Postgres
// advisory lock on a dedicated connection — the replica that holds it runs
// the schedules that are due and drains the registry event outbox,
// everyone else stays idle. A job never runs twice at once; runs that are
// still "running" after six hours are marked failed. Errors are logged and
// the loop keeps going. JOB_SCHEDULER=false leaves the schedules to
// external cron but keeps the outbox drain — events must not depend on it.
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { Client } from "pg";
import { db } from "@/db";
import { jobRuns, jobSchedules } from "@/db/schema";
import { env } from "./env";
import { JOBS, runJob } from "./jobs";
import { notify } from "./notify";
import { nextRun } from "./schedule-shared";
import { drainEventOutbox } from "./registry-events";

/** Arbitrary but fixed: every replica must ask for the same key. */
const LOCK_KEY = 7261637;
const TICK_MS = 30_000;
const FIRST_TICK_MS = 5_000;
const STUCK_AFTER = "6 hours";

interface SchedulerState {
  started: boolean;
  timer: NodeJS.Timeout | null;
  client: Client | null;
  hasLock: boolean;
  ticking: boolean;
  lastTickAt: Date | null;
  lastError: string | null;
  waitingLogged: boolean;
}

const globalState = globalThis as unknown as { __chicoreeScheduler?: SchedulerState };

function state(): SchedulerState {
  globalState.__chicoreeScheduler ??= {
    started: false,
    timer: null,
    client: null,
    hasLock: false,
    ticking: false,
    lastTickAt: null,
    lastError: null,
    waitingLogged: false,
  };
  return globalState.__chicoreeScheduler;
}

function log(message: string, ...rest: unknown[]) {
  console.log(`[scheduler] ${message}`, ...rest);
}

/** Start the loop (idempotent; survives dev-server module reloads). */
export function startScheduler(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  if (!env.jobSchedulerEnabled) {
    log("schedules disabled by JOB_SCHEDULER=false; only the registry event outbox is drained here");
  } else {
    log(`started; checking for due schedules every ${TICK_MS / 1000}s`);
  }
  const first = setTimeout(() => {
    void tick();
    s.timer = setInterval(() => void tick(), TICK_MS);
    s.timer.unref?.();
  }, FIRST_TICK_MS);
  first.unref?.();
}

/** What the admin page shows about this process. */
export function schedulerStatus(): {
  enabled: boolean;
  started: boolean;
  hasLock: boolean;
  lastTickAt: Date | null;
  lastError: string | null;
} {
  const s = state();
  return { enabled: env.jobSchedulerEnabled, started: s.started, hasLock: s.hasLock, lastTickAt: s.lastTickAt, lastError: s.lastError };
}

async function dropClient(): Promise<void> {
  const s = state();
  const c = s.client;
  s.client = null;
  s.hasLock = false;
  if (c) await c.end().catch(() => {});
}

/**
 * Take (or confirm) the advisory lock. Session-level, so it lives as long as
 * this dedicated connection; a dropped connection releases it in Postgres
 * and we simply try again on the next tick.
 */
async function acquireLock(): Promise<boolean> {
  const s = state();
  if (!s.client) {
    const client = new Client({ connectionString: env.databaseUrl, application_name: "chicoree-scheduler" });
    client.on("error", (err) => {
      log("lock connection lost:", err.message);
      void dropClient();
    });
    await client.connect();
    s.client = client;
    s.hasLock = false;
  }
  if (s.hasLock) {
    // Make sure the connection (and with it the lock) is still alive.
    await s.client.query("SELECT 1");
    return true;
  }
  const { rows } = await s.client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS ok", [LOCK_KEY]);
  s.hasLock = !!rows[0]?.ok;
  if (s.hasLock) {
    log("holding the scheduler lock; this replica runs the schedules");
    s.waitingLogged = false;
  } else if (!s.waitingLogged) {
    log("another replica holds the scheduler lock; standing by");
    s.waitingLogged = true;
  }
  return s.hasLock;
}

/** Runs that never finished (crashed process) are closed so the job can run again. */
async function failStuckRuns(): Promise<void> {
  const { rows } = await db.execute(
    `UPDATE job_runs SET status = 'failed', finished_at = now(),
       error = 'marked failed by the scheduler: still running after ${STUCK_AFTER}'
     WHERE status = 'running' AND started_at < now() - interval '${STUCK_AFTER}'
     RETURNING id, job, triggered_by, error`,
  );
  for (const r of rows) {
    log(`marked stuck run ${r.id} of ${r.job} as failed`);
    await notify({
      event: "job.failed",
      job: String(r.job),
      runId: String(r.id),
      error: String(r.error),
      triggeredBy: String(r.triggered_by),
    }).catch((err) => console.error("job.failed notification failed:", err));
  }
}

async function runDue(): Promise<void> {
  const now = new Date();
  const due = await db
    .select()
    .from(jobSchedules)
    .where(and(eq(jobSchedules.enabled, true), or(isNull(jobSchedules.nextRunAt), lte(jobSchedules.nextRunAt, now))));
  for (const schedule of due) {
    try {
      let next: Date;
      try {
        next = nextRun(schedule.cron, schedule.timezone, now);
      } catch (err) {
        log(`schedule for ${schedule.job} has an invalid expression, disabling:`, err);
        await db.update(jobSchedules).set({ enabled: false, lastStatus: "disabled: invalid cron" }).where(eq(jobSchedules.job, schedule.job));
        continue;
      }
      if (schedule.nextRunAt === null) {
        // Freshly enabled without a computed slot: wait for the first one.
        await db.update(jobSchedules).set({ nextRunAt: next }).where(eq(jobSchedules.job, schedule.job));
        continue;
      }
      if (!JOBS[schedule.job]) {
        log(`schedule for unknown job "${schedule.job}" skipped`);
        await db.update(jobSchedules).set({ nextRunAt: next, lastStatus: "skipped: unknown job" }).where(eq(jobSchedules.job, schedule.job));
        continue;
      }
      const running = await db.query.jobRuns.findFirst({
        where: and(eq(jobRuns.job, schedule.job), eq(jobRuns.status, "running")),
      });
      if (running) {
        // Leave next_run_at in the past: it runs as soon as the current one ends.
        log(`${schedule.job} is still running (run ${running.id}); not starting another`);
        await db.update(jobSchedules).set({ lastStatus: "skipped: already running" }).where(eq(jobSchedules.job, schedule.job));
        continue;
      }
      await db.update(jobSchedules).set({ lastRunAt: now, nextRunAt: next }).where(eq(jobSchedules.job, schedule.job));
      log(`running ${schedule.job} (next at ${next.toISOString()})`);
      const result = await runJob(schedule.job, schedule.params ?? {}, "schedule");
      await db.update(jobSchedules).set({ lastStatus: result.status }).where(eq(jobSchedules.job, schedule.job));
      log(`${schedule.job} ${result.status}${result.error ? `: ${result.error}` : ""}`);
    } catch (err) {
      console.error(`[scheduler] ${schedule.job} failed unexpectedly:`, err);
      await db
        .update(jobSchedules)
        .set({ lastStatus: `failed: ${err instanceof Error ? err.message : String(err)}` })
        .where(eq(jobSchedules.job, schedule.job))
        .catch(() => {});
    }
  }
}

async function tick(): Promise<void> {
  const s = state();
  if (s.ticking) return;
  s.ticking = true;
  try {
    s.lastTickAt = new Date();
    if (!(await acquireLock())) return;
    // Events registryd could not hand over come first: a scan or webhook
    // that waited for the web app to come back should not also wait for
    // a retention run.
    await drainEventOutbox().catch((err) => console.error("[scheduler] outbox drain failed:", err));
    if (env.jobSchedulerEnabled) {
      await failStuckRuns();
      await runDue();
    }
    s.lastError = null;
  } catch (err) {
    s.lastError = err instanceof Error ? err.message : String(err);
    console.error("[scheduler] tick failed:", err);
    // A broken lock connection is rebuilt on the next tick.
    if (s.client && /connection|terminated|ECONNREFUSED|ECONNRESET/i.test(s.lastError)) await dropClient();
  } finally {
    s.ticking = false;
  }
}
