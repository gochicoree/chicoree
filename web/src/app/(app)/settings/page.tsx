import type { Metadata } from "next";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "./settings-nav";
import { ProfileForms } from "./profile-forms";
import { DefaultVisibilityForm } from "@/components/default-visibility-form";
import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await requireSession();
  const sessions = await auth.api.listSessions({ headers: await headers() });
  const mine = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, session.user.id) });

  return (
    <>
      <PageHeader eyebrow="Account" title="Settings" />
      <SettingsNav />
      <div className="mb-6">
        <DefaultVisibilityForm scope="user" value={mine?.defaultVisibility ?? null} />
      </div>
      <ProfileForms
        name={session.user.name}
        email={session.user.email}
        emailVerified={session.user.emailVerified}
        sessions={sessions.map((s) => ({
          token: s.token,
          current: s.token === session.session.token,
          userAgent: s.userAgent ?? "unknown device",
          ipAddress: s.ipAddress ?? "",
          createdAt: s.createdAt.toISOString(),
        }))}
      />
    </>
  );
}
