// GET  /api/v1/orgs/{org}/repos — the organization's repositories the caller may see.
// POST /api/v1/orgs/{org}/repos — create one (owners, admins and members; write tokens).
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { repositories } from "@/db/schema";
import { loadOrg, requireOrgWriter } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { defaultVisibility, listRepos, repoListItem, type RepoSort } from "@/lib/api/queries";
import { conflict, enumField, json, paged, pageParams, readJson, stringField, unprocessable } from "@/lib/api/respond";
import { repoJson } from "@/lib/api/serialize";
import { recordAudit } from "@/lib/audit";
import { checkQuotaWarnings } from "@/lib/notify";
import { checkRepoQuota } from "@/lib/quota";
import { clearRepositoryRedirects } from "@/lib/redirects";
import { repoNameProblem } from "@/lib/repo-names-shared";

export const dynamic = "force-dynamic";

const VISIBILITIES = ["public", "private"] as const;
const SORTS: RepoSort[] = ["updated", "pulls", "name"];

export const GET = route<{ org: string }>(async (_req, { caller, params, url }) => {
  const a = await loadOrg(caller, params.org);
  const { page, pageSize } = pageParams(url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 120);
  const visibilityParam = url.searchParams.get("visibility");
  const visibility = visibilityParam === "public" || visibilityParam === "private" ? visibilityParam : undefined;
  const sortParam = url.searchParams.get("sort") as RepoSort | null;
  const sort: RepoSort = sortParam && SORTS.includes(sortParam) ? sortParam : "updated";
  const { rows, state } = await listRepos(caller, a.org.id, { q, visibility, sort, page, pageSize });
  return json(paged(rows.map((r) => repoJson(r, a.org.slug)), state));
});

export const POST = route<{ org: string }>(async (req, { caller, params }) => {
  const a = await loadOrg(caller, params.org);
  requireOrgWriter(caller, a);
  if (caller.kind !== "user") throw unprocessable("Only users can create repositories.");
  const body = await readJson(req);
  const name = stringField(body, "name", 255) ?? "";
  const description = stringField(body, "description", 1000) ?? "";
  const visibility = enumField(body, "visibility", VISIBILITIES) ?? (await defaultVisibility(a.org.id, caller.user.id));

  const problem = repoNameProblem(name, a.proxy);
  if (problem) throw unprocessable(problem, { field: "name" });
  const existing = await db.query.repositories.findFirst({
    where: and(eq(repositories.organizationId, a.org.id), eq(repositories.name, name)),
    columns: { id: true },
  });
  if (existing) throw conflict(`A repository named ${name} already exists.`);
  const quota = await checkRepoQuota(a.org.id, visibility, a.org.name);
  if (quota) throw unprocessable(quota);

  const [created] = await db.insert(repositories).values({ organizationId: a.org.id, name, description, visibility }).returning({ id: repositories.id });
  // Old names of renamed / transferred repositories can be reused: the redirect ends here.
  await clearRepositoryRedirects(a.org.id, a.org.slug, name);
  await recordAudit({
    action: "repo.create",
    actor: caller.auditActor,
    headers: req.headers,
    organizationId: a.org.id,
    targetType: "repository",
    targetId: created.id,
    targetLabel: `${a.org.slug}/${name}`,
    details: { visibility, via: "api" },
  });
  after(() => checkQuotaWarnings(a.org.id).catch((err) => console.error("quota warning check failed:", err)));
  revalidatePath(`/${a.org.slug}`);
  const item = await repoListItem(created.id);
  if (!item) throw conflict("The repository was created but could not be read back.");
  return json(repoJson(item, a.org.slug), { status: 201 });
});
