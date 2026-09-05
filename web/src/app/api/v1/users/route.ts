// GET /api/v1/users — accounts on this instance (instance administrators);
// `email` finds one address exactly, `q` searches names and addresses.
import { requireInstanceAdmin } from "@/lib/api/access";
import { route } from "@/lib/api/handler";
import { json, paged, pageParams } from "@/lib/api/respond";
import { listUsers } from "@/lib/api/users";

export const dynamic = "force-dynamic";

export const GET = route(async (_req, { caller, url }) => {
  requireInstanceAdmin(caller, "list users", { read: true });
  const { page, pageSize } = pageParams(url);
  const email = (url.searchParams.get("email") ?? "").slice(0, 254);
  const q = (url.searchParams.get("q") ?? "").slice(0, 120);
  const { rows, state } = await listUsers({ email, q, page, pageSize });
  return json(paged(rows, state));
});
