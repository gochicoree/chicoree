import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { notificationPreferences } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { NOTIFICATION_EVENTS } from "@/lib/notify-shared";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "../settings-nav";
import { NotificationsForm } from "./notifications-form";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsSettingsPage() {
  const session = await requireSession();
  const rows = await db.query.notificationPreferences.findMany({
    where: eq(notificationPreferences.userId, session.user.id),
  });
  const stored = new Map(rows.map((r) => [r.event, r.email]));
  const isAdmin = session.user.role === "admin";
  const items = NOTIFICATION_EVENTS.filter((e) => e.scope !== "instance" || isAdmin).map((e) => ({
    event: e.event,
    label: e.label,
    description: e.description,
    scope: e.scope,
    email: stored.get(e.event) ?? e.defaultEmail,
  }));

  return (
    <>
      <PageHeader eyebrow="Account" title="Settings" />
      <SettingsNav />
      <NotificationsForm items={items} email={session.user.email} />
    </>
  );
}
