// Job schedules: one optional cron schedule per maintenance job, stored in
// job_schedules and executed by lib/scheduler.ts.
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns, jobSchedules } from "@/db/schema";
import { JOBS } from "./jobs";
import { nextRun, nextRuns, validateCron, validateTimezone } from "./schedule-shared";

export type ScheduleRow = typeof jobSchedules.$inferSelect;

/** Serialisable view for the admin page. */
export interface ScheduleView {
  job: string;
  cron: string;
  params: Record<string, string>;
  enabled: boolean;
  timezone: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastStatus: string | null;
  /** The next three run times, when enabled and valid. */
  upcoming: string[];
}

export function toScheduleView(row: ScheduleRow): ScheduleView {
  let upcoming: string[] = [];
  if (row.enabled) {
    try {
      upcoming = nextRuns(row.cron, row.timezone).map((d) => d.toISOString());
    } catch {
      upcoming = [];
    }
  }
  return {
    job: row.job,
    cron: row.cron,
    params: row.params ?? {},
    enabled: row.enabled,
    timezone: row.timezone,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus,
    upcoming,
  };
}

export async function listSchedules(): Promise<Map<string, ScheduleRow>> {
  const rows = await db.select().from(jobSchedules);
  return new Map(rows.map((r) => [r.job, r]));
}

/** Validate and store a schedule. Returns an error message or null. */
export async function saveSchedule(input: {
  job: string;
  cron: string;
  params: Record<string, string>;
  enabled: boolean;
  timezone: string;
  updatedBy: string;
}): Promise<string | null> {
  const job = JOBS[input.job];
  if (!job) return "Unknown job.";
  const timezone = input.timezone.trim() || "UTC";
  if (!validateTimezone(timezone)) return `"${timezone}" is not a valid IANA time zone (for example Europe/Berlin).`;
  const cron = input.cron.trim().replace(/\s+/g, " ");
  const invalid = validateCron(cron, timezone);
  if (invalid) return `Invalid cron expression: ${invalid}`;
  // Only documented parameters are stored; blanks fall back to the defaults at run time.
  const params: Record<string, string> = {};
  for (const p of job.params) {
    const v = (input.params[p.name] ?? "").trim();
    if (v) params[p.name] = v;
  }
  const nextRunAt = input.enabled ? nextRun(cron, timezone) : null;
  await db
    .insert(jobSchedules)
    .values({
      job: input.job,
      cron,
      params,
      enabled: input.enabled,
      timezone,
      nextRunAt,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: jobSchedules.job,
      set: { cron, params, enabled: input.enabled, timezone, nextRunAt, updatedBy: input.updatedBy, updatedAt: new Date() },
    });
  return null;
}

/** The most recent scheduled run of a job, for the "last scheduled result" line. */
export async function lastScheduledRun(job: string) {
  return db.query.jobRuns.findFirst({
    where: and(eq(jobRuns.job, job), eq(jobRuns.triggeredBy, "schedule")),
    orderBy: [desc(jobRuns.startedAt)],
  });
}
