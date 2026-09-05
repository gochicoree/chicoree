"use server";

import { revalidatePath } from "next/cache";
import { acknowledgeApiRevision } from "@/lib/api/revision-notice";
import { API_REVISION } from "@/lib/api/version";
import { requireAdmin } from "@/lib/session";

/** Administration overview: hide the "API changed" card until the next revision. */
export async function dismissApiRevisionNotice(): Promise<void> {
  await requireAdmin();
  await acknowledgeApiRevision(API_REVISION);
  revalidatePath("/admin");
}
