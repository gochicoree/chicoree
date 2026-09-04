import type { Metadata } from "next";
import { requireSession } from "@/lib/session";
import { getInstanceSettings } from "@/lib/instance-settings";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "./settings-nav";
import { ProfileDetailsForm } from "./profile-forms";
import { DefaultVisibilityForm } from "@/components/default-visibility-form";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireSession();
  const settings = await getInstanceSettings();
  const mine = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, session.user.id) });

  return (
    <>
      <PageHeader eyebrow="Account" title="Settings" />
      <SettingsNav />
      <div className="space-y-6">
        <ProfileDetailsForm
          name={session.user.name}
          email={session.user.email}
          emailVerified={session.user.emailVerified}
          emailConfigured={!!settings.smtp.host}
        />
        <DefaultVisibilityForm scope="user" value={mine?.defaultVisibility ?? null} />
      </div>
    </>
  );
}
