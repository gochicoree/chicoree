// GET /api/v1/me/starred — repositories the caller starred, newest star first.
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization } from "@/db/schema";
import { requireUser } from "@/lib/api/auth";
import { route } from "@/lib/api/handler";
import { iso, json } from "@/lib/api/respond";
import { repoJson } from "@/lib/api/serialize";
import { listStarredRepos } from "@/lib/stars";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, { caller, url }) => {
  const c = requireUser(caller);
  const raw = Math.trunc(Number(url.searchParams.get("limit") ?? 50));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 200) : 50;
  let rows = await listStarredRepos(c.viewer, c.user.id, limit);
  // A token limited to one organization (or a few repositories) sees only the stars inside it.
  const rs = c.caller.restriction;
  if (rs) {
    const org = await db.query.organization.findFirst({ where: eq(organization.id, rs.organizationId), columns: { slug: true } });
    rows = rows.filter((r) => r.orgSlug === org?.slug && (!rs.repositoryIds || rs.repositoryIds.includes(r.id)));
  }
  const items = rows.map((r) => ({ ...repoJson(r), starredAt: iso(r.starredAt) }));
  return json({ items, total: items.length });
});
