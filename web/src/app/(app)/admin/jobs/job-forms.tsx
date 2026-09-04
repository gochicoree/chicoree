"use client";

import { useActionState, useMemo, useState } from "react";
import { CalendarClock, Play } from "lucide-react";
import { runJobAction, type JobActionResult } from "@/app/actions/jobs";
import { saveScheduleAction, type ScheduleActionResult } from "@/app/actions/schedules";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useActionToast } from "@/components/ui/toast";
import { relativeTime } from "@/lib/format";
import type { ScheduleView } from "@/lib/schedules";
import {
  CUSTOM_PRESET,
  describeCron,
  formatRunTime,
  nextRuns,
  presetFor,
  SCHEDULE_PRESETS,
  validateCron,
  validateTimezone,
} from "@/lib/schedule-shared";

export interface JobInfo {
  name: string;
  title: string;
  description: string;
  params: { name: string; description: string; default: string }[];
}

export interface LastScheduled {
  id: string;
  status: string;
  error: string | null;
  startedAt: string;
}

const PRESET_OPTIONS = [
  ...SCHEDULE_PRESETS.map((p) => ({ value: p.value, label: p.label, description: p.value })),
  { value: CUSTOM_PRESET, label: "Custom", description: "Any 5-field cron expression" },
];

export function ScheduleForm({
  job,
  schedule,
  lastScheduled,
  schedulerEnabled,
}: {
  job: JobInfo;
  schedule: ScheduleView | null;
  lastScheduled: LastScheduled | null;
  schedulerEnabled: boolean;
}) {
  const [state, action, pending] = useActionState<ScheduleActionResult | null, FormData>(saveScheduleAction, null);
  useActionToast(state, "Schedule saved");
  const initialCron = schedule?.cron ?? SCHEDULE_PRESETS[1].value;
  const [preset, setPreset] = useState(presetFor(initialCron));
  const [cron, setCron] = useState(initialCron);
  const [timezone, setTimezone] = useState(schedule?.timezone ?? "UTC");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? false);

  const effectiveCron = preset === CUSTOM_PRESET ? cron : preset;
  const preview = useMemo(() => {
    const tz = validateTimezone(timezone) ? timezone : null;
    if (!tz) return { error: "Unknown time zone.", description: "", upcoming: [] as string[] };
    const error = validateCron(effectiveCron, tz);
    if (error) return { error, description: "", upcoming: [] as string[] };
    try {
      return {
        error: null,
        description: describeCron(effectiveCron),
        upcoming: nextRuns(effectiveCron, tz).map((d) => formatRunTime(d, tz)),
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), description: "", upcoming: [] as string[] };
    }
  }, [effectiveCron, timezone]);

  const id = (s: string) => `${job.name}-schedule-${s}`;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="job" value={job.name} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm text-ink-2">
          <CalendarClock className="size-4 text-ink-3" /> {schedule ? "Saved schedule" : "No schedule yet"}
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <input
            type="checkbox"
            name="enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="size-4 accent-[var(--action)]"
          />
          Enabled
        </label>
      </div>
      <Field label="Runs" htmlFor={id("preset")}>
        <Select
          id={id("preset")}
          name="preset"
          options={PRESET_OPTIONS}
          value={preset}
          onChange={(v) => {
            setPreset(v);
            if (v !== CUSTOM_PRESET) setCron(v);
          }}
        />
      </Field>
      {preset === CUSTOM_PRESET && (
        <Field label="Cron expression" htmlFor={id("cron")} hint="minute hour day-of-month month day-of-week">
          <Input
            id={id("cron")}
            name="cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            className="font-mono"
            placeholder="*/30 * * * *"
            spellCheck={false}
          />
        </Field>
      )}
      <Field label="Time zone" htmlFor={id("tz")} hint="IANA name, e.g. Europe/Berlin">
        <Input
          id={id("tz")}
          name="timezone"
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="font-mono"
          spellCheck={false}
        />
      </Field>
      {job.params.map((p) => (
        <Field key={p.name} label={`${p.name} (scheduled runs)`} htmlFor={id(`param-${p.name}`)} hint={p.description}>
          <Input
            id={id(`param-${p.name}`)}
            name={`param:${p.name}`}
            defaultValue={schedule?.params[p.name] ?? ""}
            placeholder={p.default}
            className="font-mono"
          />
        </Field>
      ))}
      <div className="rounded-lg border border-line bg-card-2 px-3 py-2 text-xs">
        {preview.error ? (
          <p className="text-danger">{preview.error}</p>
        ) : (
          <>
            <p className="font-medium text-ink">{preview.description}</p>
            <p className="mt-1 text-ink-2">
              Next: {preview.upcoming.join(" · ")}
              {timezone !== "UTC" && <span className="text-ink-3"> ({timezone})</span>}
            </p>
          </>
        )}
      </div>
      {schedule && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span>Last scheduled run:</span>
          {lastScheduled ? (
            <>
              <Badge tone={lastScheduled.status === "succeeded" ? "ok" : lastScheduled.status === "failed" ? "danger" : "neutral"}>
                {lastScheduled.status}
              </Badge>
              <span className="text-ink-3">{relativeTime(lastScheduled.startedAt)}</span>
              {lastScheduled.error && <span className="min-w-0 basis-full truncate text-danger" title={lastScheduled.error}>{lastScheduled.error}</span>}
            </>
          ) : (
            <span className="text-ink-3">never</span>
          )}
          {schedule.lastStatus && schedule.lastStatus.startsWith("skipped") && <Badge tone="danger">{schedule.lastStatus}</Badge>}
        </p>
      )}
      {!schedulerEnabled && enabled && (
        <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
          The scheduler is disabled on this install (JOB_SCHEDULER=false); the schedule is saved but will not run.
        </p>
      )}
      {state?.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{state.error}</p>}
      <div>
        <Button type="submit" variant="secondary" size="sm" disabled={pending || !!preview.error}>
          {pending ? "Saving…" : "Save schedule"}
        </Button>
      </div>
    </form>
  );
}

/** Manual "Run now" form for one job: parameter inputs, the run button and the outcome. */
export function RunJobForm({ job }: { job: JobInfo }) {
  const [state, action, pending] = useActionState<JobActionResult | null, FormData>(runJobAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="job" value={job.name} />
      {job.params.length === 0 && <p className="text-sm text-ink-2">This job takes no parameters.</p>}
      {job.params.map((p) => (
        <Field key={p.name} label={p.name} htmlFor={`${job.name}-${p.name}`} hint={p.description}>
          <Input id={`${job.name}-${p.name}`} name={p.name} placeholder={p.default} className="font-mono" />
        </Field>
      ))}
      <div className="space-y-3 pt-1">
        <Button type="submit" variant="secondary" disabled={pending}>
          <Play className="size-4" /> {pending ? "Running…" : "Run now"}
        </Button>
        {state?.status === "succeeded" && (
          <p className="overflow-x-auto rounded-md bg-ok-soft px-3 py-2 font-mono text-xs text-ok">{JSON.stringify(state.result)}</p>
        )}
        {state?.error && <p className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{state.error}</p>}
      </div>
    </form>
  );
}
