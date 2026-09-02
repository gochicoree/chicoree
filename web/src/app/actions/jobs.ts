"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { JOBS, runJob } from "@/lib/jobs";

export interface JobActionResult {
  error?: string;
  runId?: string;
  status?: string;
  result?: Record<string, unknown>;
}

export async function runJobAction(
  _prev: JobActionResult | null,
  formData: FormData,
): Promise<JobActionResult> {
  const session = await requireAdmin();
  const name = String(formData.get("job") ?? "");
  const job = JOBS[name];
  if (!job) return { error: "Unknown job." };
  const params: Record<string, string> = {};
  for (const p of job.params) {
    const v = String(formData.get(p.name) ?? "").trim();
    if (v) params[p.name] = v;
  }
  const run = await runJob(name, params, `user:${session.user.id}`);
  revalidatePath("/admin/jobs");
  revalidatePath("/admin");
  return run.status === "succeeded"
    ? { runId: run.id, status: run.status, result: run.result }
    : { runId: run.id, status: run.status, error: run.error };
}
