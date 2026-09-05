import type { Metadata } from "next";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { passkey as passkeyTable, session as sessionTable } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "../settings-nav";
import { PasswordForm, SessionsList } from "../profile-forms";
import { TwoFactorManager } from "./two-factor-manager";
import { PasskeyManager } from "./passkey-manager";

export const metadata: Metadata = { title: "Security" };

/** better-auth's default `session.freshAge` (one day), used when the config leaves it unset. */
const DEFAULT_FRESH_AGE_SECONDS = 60 * 60 * 24;

export default async function SecurityPage() {
  const session = await requireSession();
  const auth = await getAuth();
  // Sessions are read straight from the table: better-auth's listSessions
  // endpoint insists on a *fresh* session (signed in less than a day ago)
  // and throws SESSION_NOT_FRESH otherwise, which took the whole page down
  // for anyone with an older session. Listing is harmless; only adding a
  // passkey still needs the fresh sign-in, and its form says so.
  const [passkeys, sessions, freshAge] = await Promise.all([
    db.query.passkey.findMany({ where: eq(passkeyTable.userId, session.user.id) }),
    db.query.session.findMany({
      where: and(eq(sessionTable.userId, session.user.id), gt(sessionTable.expiresAt, new Date())),
      orderBy: (t, { desc }) => [desc(t.updatedAt)],
    }),
    auth.$context.then((c) => c.sessionConfig.freshAge ?? DEFAULT_FRESH_AGE_SECONDS).catch(() => DEFAULT_FRESH_AGE_SECONDS),
  ]);
  const fresh = freshAge === 0 || Date.now() - new Date(session.session.createdAt).getTime() < freshAge * 1000;

  return (
    <>
      <PageHeader eyebrow="Account" title="Settings" />
      <SettingsNav />
      <div className="space-y-6">
        <TwoFactorManager enabled={!!session.user.twoFactorEnabled} />
        <PasskeyManager
          fresh={fresh}
          passkeys={passkeys.map((p) => ({
            id: p.id,
            name: p.name ?? "Unnamed passkey",
            createdAt: p.createdAt?.toISOString() ?? null,
            deviceType: p.deviceType,
          }))}
        />
        <PasswordForm />
        <SessionsList
          sessions={sessions.map((s) => ({
            token: s.token,
            current: s.token === session.session.token,
            userAgent: s.userAgent ?? "unknown device",
            ipAddress: s.ipAddress ?? "",
            createdAt: s.createdAt.toISOString(),
            lastActiveAt: s.updatedAt.toISOString(),
            expiresAt: s.expiresAt.toISOString(),
          }))}
        />
      </div>
    </>
  );
}
