import type { Metadata } from "next";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { accessTokens } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { env } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "../settings-nav";
import { TokenManager } from "./token-manager";

export const metadata: Metadata = { title: "Access tokens" };

export default async function TokensPage() {
  const session = await requireSession();
  const tokens = await db.query.accessTokens.findMany({
    where: eq(accessTokens.userId, session.user.id),
    orderBy: [desc(accessTokens.createdAt)],
  });

  return (
    <>
      <PageHeader eyebrow="Account" title="Settings" />
      <SettingsNav />
      <TokenManager
        registryHost={env.registryHost}
        email={session.user.email}
        tokens={tokens.map((t) => ({
          id: t.id,
          name: t.name,
          scope: t.scope,
          tokenPrefix: t.tokenPrefix,
          createdAt: t.createdAt.toISOString(),
          expiresAt: t.expiresAt?.toISOString() ?? null,
          lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        }))}
      />
    </>
  );
}
