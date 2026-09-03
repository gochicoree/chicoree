"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { JOBS } from "@/lib/jobs";
import { saveSchedule } from "@/lib/schedules";
import { CUSTOM_PRESET } from "@/lib/schedule-shared";

export interface ScheduleActionResult {
  error?: string;
  saved?: boolean;
}

/** Save (or switch off) the cron schedule of one job. Administrators only. */
export async function saveScheduleAction(
  _prev: ScheduleActionResult | null,
  formData: FormData,
): Promise<ScheduleActionResult> {
  const session = await requireAdmin();
  const name = String(formData.get("job") ?? "");
  const job = JOBS[name];
  if (!job) return { error: "Unknown job." };

  const preset = String(formData.get("preset") ?? CUSTOM_PRESET);
  const cron = preset === CUSTOM_PRESET ? String(formData.get("cron") ?? "") : preset;
  const enabled = formData.get("enabled") === "on";
  const timezone = String(formData.get("timezone") ?? "UTC");
  const params: Record<string, string> = {};
  for (const p of job.params) params[p.name] = String(formData.get(`param:${p.name}`) ?? "");

  const error = await saveSchedule({ job: name, cron, params, enabled, timezone, updatedBy: session.user.id });
  if (error) return { error };
  revalidatePath("/admin/jobs");
  return { saved: true };
}
