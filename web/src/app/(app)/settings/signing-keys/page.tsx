import type { Metadata } from "next";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { organizationSettings } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { env } from "@/lib/env";
import { listUserSigningKeys, organizationsTrustingUser } from "@/lib/signatures";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "../settings-nav";
import { SigningKeysManager } from "./signing-keys-manager";

export const metadata: Metadata = { title: "Signing keys" };

export default async function SigningKeysPage() {
  const session = await requireSession();
  const [keys, orgs] = await Promise.all([listUserSigningKeys(session.user.id), organizationsTrustingUser(session.user.id)]);
  const settings = orgs.length
    ? await db.query.organizationSettings.findMany({
        where: inArray(
          organizationSettings.organizationId,
          orgs.map((o) => o.id),
        ),
        columns: { organizationId: true, trustMemberKeys: true },
      })
    : [];
  const disabled = new Set(settings.filter((s) => !s.trustMemberKeys).map((s) => s.organizationId));

  return (
    <>
      <PageHeader eyebrow="Account" title="Settings" />
      <SettingsNav />
      <SigningKeysManager
        registryHost={env.registryHost}
        keys={keys.map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint, keyType: k.keyType, createdAt: k.createdAt.toISOString() }))}
        organizations={orgs.map((o) => ({ slug: o.slug, name: o.name, role: o.role, trusted: !disabled.has(o.id) }))}
        instanceAdmin={session.user.role === "admin"}
      />
    </>
  );
}
