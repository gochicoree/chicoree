// Cron schedule helpers safe for the browser (no database): presets,
// validation, the next run times and a plain-English description of a
// 5-field expression. The scheduler and the admin form both use these.
import { CronExpressionParser } from "cron-parser";

export interface SchedulePreset {
  value: string;
  label: string;
}

/** Offered in the schedule form; "custom" lets the admin type any expression. */
export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { value: "0 * * * *", label: "Every hour" },
  { value: "0 3 * * *", label: "Daily at 03:00" },
  { value: "0 4 * * 0", label: "Weekly, Sunday 04:00" },
];

export const CUSTOM_PRESET = "custom";

/** Which preset an expression matches, or "custom". */
export function presetFor(cron: string): string {
  const normalized = cron.trim().replace(/\s+/g, " ");
  return SCHEDULE_PRESETS.find((p) => p.value === normalized)?.value ?? CUSTOM_PRESET;
}

/** Returns an error message for an invalid 5-field expression, else null. */
export function validateCron(cron: string, timezone = "UTC"): string | null {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return "Use five fields: minute hour day-of-month month day-of-week.";
  try {
    const it = CronExpressionParser.parse(fields.join(" "), { tz: timezone });
    it.next();
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.replace(/^Error:\s*/, "");
  }
}

export function validateTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The next `count` run times after `from`. Throws on an invalid expression. */
export function nextRuns(cron: string, timezone = "UTC", from: Date = new Date(), count = 3): Date[] {
  const it = CronExpressionParser.parse(cron.trim().replace(/\s+/g, " "), { currentDate: from, tz: timezone });
  const out: Date[] = [];
  for (let i = 0; i < count; i++) out.push(it.next().toDate());
  return out;
}

export function nextRun(cron: string, timezone = "UTC", from: Date = new Date()): Date {
  return nextRuns(cron, timezone, from, 1)[0];
}

// --- Description -------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function listOf(values: string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/** Expand one field into its matching values, or null for "every". */
function expand(field: string, min: number, max: number, names?: string[]): number[] | null {
  const f = field.trim().toLowerCase();
  if (f === "*" || f === "?") return null;
  const lookup = (v: string): number => {
    if (names && /^[a-z]/.test(v)) {
      const idx = names.findIndex((n) => n.slice(0, 3).toLowerCase() === v.slice(0, 3));
      return idx >= 0 ? idx + min : NaN;
    }
    return Number(v);
  };
  const out = new Set<number>();
  for (const part of f.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = lookup(a);
      hi = lookup(b);
    } else {
      lo = lookup(rangePart);
      hi = stepPart ? max : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step < 1) return [];
    for (let v = lo; v <= hi; v += step) out.add(names === DAYS ? v % 7 : v);
  }
  return [...out].sort((a, b) => a - b);
}

function stepOf(field: string): number | null {
  const m = /^\*\/(\d+)$/.exec(field.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Plain-English reading of a cron expression, e.g. "Every day at 03:00",
 * "Every 15 minutes", "At 04:00 on Sunday". Falls back to the raw expression.
 */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) return cron;
  const [minF, hourF, domF, monF, dowF] = fields;
  const minutes = expand(minF, 0, 59);
  const hours = expand(hourF, 0, 23);
  const doms = expand(domF, 1, 31);
  const months = expand(monF, 1, 12, MONTHS);
  const dows = expand(dowF, 0, 7, DAYS);
  if ([minutes, hours, doms, months, dows].some((v) => v !== null && v.length === 0)) return cron;

  let time: string;
  const minuteStep = stepOf(minF);
  const hourStep = stepOf(hourF);
  if (minutes === null && hours === null) time = "Every minute";
  else if (minuteStep && hours === null) time = `Every ${minuteStep} minutes`;
  else if (minutes === null) time = `Every minute during hour${hours!.length > 1 ? "s" : ""} ${listOf(hours!.map(pad))}`;
  else if (hourStep && minutes.length === 1) time = `Every ${hourStep} hours at minute ${minutes[0]}`;
  else if (hours === null) time = `At minute${minutes.length > 1 ? "s" : ""} ${listOf(minutes.map(String))} of every hour`;
  else {
    const times: string[] = [];
    for (const h of hours) for (const m of minutes) times.push(`${pad(h)}:${pad(m)}`);
    time = `At ${listOf(times.slice(0, 6))}${times.length > 6 ? " …" : ""}`;
  }

  const parts: string[] = [time];
  if (dows !== null) parts.push(`on ${listOf(dows.map((d) => DAYS[d]))}`);
  if (doms !== null) parts.push(`on the ${listOf(doms.map(ordinal))}`);
  if (months !== null) parts.push(`in ${listOf(months.map((m) => MONTHS[m - 1]))}`);
  const clockTime = minutes !== null && hours !== null && !hourStep;
  if (clockTime && dows === null && doms === null && months === null) parts.push("every day");
  return parts.join(" ");
}

/** Format a run time for the UI in the schedule's zone. */
export function formatRunTime(date: Date, timezone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}
