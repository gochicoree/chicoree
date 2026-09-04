// Read side for credential screens: a user's tokens with their restriction
// resolved to organization / repository names (Settings → Access tokens and
// the admin user page).
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { accessTokens, organization, repositories } from "@/db/schema";
import type { TokenRow } from "@/app/(app)/settings/tokens/token-manager";

export type { TokenRow };

/** Tokens of a user with their restriction resolved to names; shared with the admin user page. */
export async function loadUserTokens(userId: string): Promise<TokenRow[]> {
  const tokens = await db.query.accessTokens.findMany({
    where: eq(accessTokens.userId, userId),
    orderBy: [desc(accessTokens.createdAt)],
  });
  const orgIds = [...new Set(tokens.map((t) => t.organizationId).filter((id): id is string => !!id))];
  const repoIds = [...new Set(tokens.flatMap((t) => t.repositoryIds ?? []))];
  const [orgs, repos] = await Promise.all([
    orgIds.length ? db.query.organization.findMany({ where: inArray(organization.id, orgIds) }) : [],
    repoIds.length ? db.query.repositories.findMany({ where: inArray(repositories.id, repoIds), columns: { id: true, name: true } }) : [],
  ]);
  const orgById = new Map(orgs.map((o) => [o.id, o]));
  const repoById = new Map(repos.map((r) => [r.id, r.name]));
  return tokens.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    scope: t.scope,
    tokenPrefix: t.tokenPrefix,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: t.lastUsedIp,
    organization: t.organizationId ? (orgById.get(t.organizationId) ? { name: orgById.get(t.organizationId)!.name, slug: orgById.get(t.organizationId)!.slug } : { name: "deleted organization", slug: "" }) : null,
    repositories: t.repositoryIds ? t.repositoryIds.map((id) => repoById.get(id) ?? "deleted repository") : null,
  }));
}

