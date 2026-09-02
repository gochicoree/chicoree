import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { passkey as passkeyTable } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "../settings-nav";
import { TwoFactorManager } from "./two-factor-manager";
import { PasskeyManager } from "./passkey-manager";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage() {
  const session = await requireSession();
  const passkeys = await db.query.passkey.findMany({
    where: eq(passkeyTable.userId, session.user.id),
  });

  return (
    <>
      <PageHeader eyebrow="Account" title="Settings" />
      <SettingsNav />
      <div className="space-y-6">
        <TwoFactorManager enabled={!!session.user.twoFactorEnabled} />
        <PasskeyManager
          passkeys={passkeys.map((p) => ({
            id: p.id,
            name: p.name ?? "Unnamed passkey",
            createdAt: p.createdAt?.toISOString() ?? null,
            deviceType: p.deviceType,
          }))}
        />
      </div>
    </>
  );
}
