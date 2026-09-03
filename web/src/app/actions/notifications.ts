"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { notificationPreferences } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { NOTIFICATION_EVENTS } from "@/lib/notify-shared";

export interface NotificationPrefsResult {
  error?: string;
  saved?: boolean;
}

/** Store the caller's email preference for every notification event. */
export async function saveNotificationPreferences(
  _prev: NotificationPrefsResult | null,
  formData: FormData,
): Promise<NotificationPrefsResult> {
  const session = await requireSession();
  const isAdmin = session.user.role === "admin";
  for (const info of NOTIFICATION_EVENTS) {
    if (info.scope === "instance" && !isAdmin) continue;
    const email = formData.get(`email:${info.event}`) === "on";
    await db
      .insert(notificationPreferences)
      .values({ userId: session.user.id, event: info.event, email, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [notificationPreferences.userId, notificationPreferences.event],
        set: { email, updatedAt: new Date() },
      });
  }
  revalidatePath("/settings/notifications");
  return { saved: true };
}
