import type { Metadata } from "next";
import { requireSession } from "@/lib/session";
import { getInstanceSettings } from "@/lib/instance-settings";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "./settings-nav";
import { ProfileDetailsForm } from "./profile-forms";
import { DefaultVisibilityForm } from "@/components/default-visibility-form";
import { LogoUploadCard } from "@/components/logo-upload";
import { saveUserAvatar } from "@/app/actions/logos";
import { db } from "@/db";
import { user as userTable, userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireSession();
  const settings = await getInstanceSettings();
  const mine = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, session.user.id) });
  const me = await db.query.user.findFirst({ where: eq(userTable.id, session.user.id) });

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
        <LogoUploadCard
          action={saveUserAvatar}
          kind="user"
          name={session.user.name}
          fields={{}}
          initial={me?.image ?? null}
          eyebrow="Profile"
          title="Your avatar"
          description="Shown next to your name in the sidebar, member lists, the activity feed and on the images you push."
          submitLabel="Save avatar"
          removeLabel="Remove avatar"
        />
        <DefaultVisibilityForm scope="user" value={mine?.defaultVisibility ?? null} />
      </div>
    </>
  );
}
