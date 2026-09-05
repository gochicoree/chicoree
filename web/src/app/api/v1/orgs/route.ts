// GET /api/v1/orgs — organizations the caller belongs to or can see a repository of.
import { route } from "@/lib/api/handler";
import { listOrgs } from "@/lib/api/queries";
import { json, paged, pageParams } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, { caller, url }) => {
  const { page, pageSize } = pageParams(url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 120);
  const { rows, state } = await listOrgs(caller, { q, page, pageSize });
  return json(paged(rows, state));
});
