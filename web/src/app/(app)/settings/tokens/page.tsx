import type { Metadata } from "next";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { repositories } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { env } from "@/lib/env";
import { listUserOrgs } from "@/lib/data";
import { getInstanceSettings } from "@/lib/instance-settings";
import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "../settings-nav";
import { loadUserTokens } from "@/lib/credentials-data";
import { TokenManager, type TokenOrg } from "./token-manager";
import { API_BASE } from "@/lib/api/version";
import Link from "next/link";

export const metadata: Metadata = { title: "Access tokens" };

export default async function TokensPage() {
  const session = await requireSession();
  const [tokens, orgs, settings] = await Promise.all([loadUserTokens(session.user.id), listUserOrgs(session.user.id), getInstanceSettings()]);
  const repoRows = orgs.length
    ? await db.query.repositories.findMany({
        where: inArray(
          repositories.organizationId,
          orgs.map((o) => o.id),
        ),
        columns: { id: true, name: true, organizationId: true },
        orderBy: (t, { asc }) => [asc(t.name)],
      })
    : [];
  const tokenOrgs: TokenOrg[] = orgs.map((o) => ({
    id: o.id,
    name: o.name,
    slug: o.slug,
    repositories: repoRows.filter((r) => r.organizationId === o.id).map((r) => ({ id: r.id, name: r.name })),
  }));

  return (
    <>
      <PageHeader eyebrow="Account" title="Settings" />
      <SettingsNav />
      {settings.access.apiEnabled && (
        <p className="mb-4 text-sm text-ink-2">
          Tokens also authenticate the{" "}
          <Link href="/docs/api" className="text-action underline underline-offset-2 hover:text-action-hover">
            REST API
          </Link>
          , with the same roles and limits as docker login.
        </p>
      )}
      <TokenManager
        registryHost={env.registryHost}
        apiUrl={settings.access.apiEnabled ? `${env.appUrl.replace(/\/$/, "")}${API_BASE}` : null}
        email={session.user.email}
        tokens={tokens}
        orgs={tokenOrgs}
        policy={{ maxTokenLifetimeDays: settings.access.maxTokenLifetimeDays, requireTokenExpiry: settings.access.requireTokenExpiry }}
      />
    </>
  );
}
