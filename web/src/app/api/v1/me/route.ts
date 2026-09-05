// GET /api/v1/me — the caller behind the credential.
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { organization, repositories } from "@/db/schema";
import { requireAuthenticated } from "@/lib/api/auth";
import { route } from "@/lib/api/handler";
import { iso, json } from "@/lib/api/respond";
import { API_REVISION, API_VERSION } from "@/lib/api/version";

export const dynamic = "force-dynamic";

async function orgSlug(id: string | null): Promise<string | null> {
  if (!id) return null;
  const o = await db.query.organization.findFirst({ where: eq(organization.id, id), columns: { slug: true } });
  return o?.slug ?? null;
}

async function repoNames(ids: string[] | null): Promise<string[] | null> {
  if (!ids || ids.length === 0) return null;
  const rows = await db.query.repositories.findMany({ where: inArray(repositories.id, ids), columns: { name: true } });
  return rows.map((r) => r.name).sort();
}

export const GET = route(async (_req, { caller }) => {
  const c = requireAuthenticated(caller);
  const api = { version: API_VERSION, revision: API_REVISION };
  if (c.kind === "sa") {
    return json({
      kind: "service-account",
      via: c.via,
      user: null,
      token: null,
      serviceAccount: {
        id: c.sa.id,
        name: c.sa.name,
        organization: await orgSlug(c.sa.organizationId),
        permission: c.sa.permission,
        repositories: await repoNames(c.sa.repositoryIds),
        expiresAt: iso(c.sa.expiresAt),
      },
      api,
    });
  }
  return json({
    kind: "user",
    via: c.via,
    user: { id: c.user.id, name: c.user.name, email: c.user.email, role: c.user.role, emailVerified: c.user.emailVerified },
    token: c.token
      ? {
          id: c.token.id,
          name: c.token.name,
          scope: c.token.scope,
          expiresAt: iso(c.token.expiresAt),
          organization: await orgSlug(c.token.organizationId),
          repositories: await repoNames(c.token.repositoryIds),
        }
      : null,
    serviceAccount: null,
    api,
  });
});
