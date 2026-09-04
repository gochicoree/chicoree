"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { requireAdmin, requireSession } from "@/lib/session";

/** Hide the dashboard onboarding checklist for the caller. */
export async function dismissOnboarding(): Promise<void> {
  const session = await requireSession();
  const now = new Date();
  await db
    .insert(userSettings)
    .values({ userId: session.user.id, onboardingDismissedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: userSettings.userId, set: { onboardingDismissedAt: now, updatedAt: now } });
  revalidatePath("/dashboard");
}

/** Hide the /admin setup checklist for this administrator. */
export async function dismissAdminChecklist(): Promise<void> {
  const session = await requireAdmin();
  const now = new Date();
  await db
    .insert(userSettings)
    .values({ userId: session.user.id, adminChecklistDismissedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: userSettings.userId, set: { adminChecklistDismissedAt: now, updatedAt: now } });
  revalidatePath("/admin");
}
