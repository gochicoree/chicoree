import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { serviceAccounts } from "@/db/schema";
import { getOrgContext } from "@/lib/session";
import { env } from "@/lib/env";
import { getInstanceSettings } from "@/lib/instance-settings";
import { ServiceAccountsManager } from "./sa-manager";

export default async function ServiceAccountsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const ctx = await getOrgContext(slug);
  if (!ctx) notFound();
  if (ctx.role !== "owner" && ctx.role !== "admin") redirect(`/${slug}`);

  const [accounts, settings] = await Promise.all([
    db.query.serviceAccounts.findMany({
      where: eq(serviceAccounts.organizationId, ctx.org.id),
      orderBy: (t, { asc }) => [asc(t.name)],
    }),
    getInstanceSettings(),
  ]);

  return (
    <ServiceAccountsManager
      organizationId={ctx.org.id}
      registryHost={env.registryHost}
      policy={{ maxTokenLifetimeDays: settings.access.maxTokenLifetimeDays, requireTokenExpiry: settings.access.requireTokenExpiry }}
      accounts={accounts.map((sa) => ({
        id: sa.id,
        name: sa.name,
        description: sa.description,
        permission: sa.permission,
        tokenPrefix: sa.tokenPrefix,
        createdAt: sa.createdAt.toISOString(),
        expiresAt: sa.expiresAt?.toISOString() ?? null,
        lastUsedAt: sa.lastUsedAt?.toISOString() ?? null,
        lastUsedIp: sa.lastUsedIp,
      }))}
    />
  );
}
